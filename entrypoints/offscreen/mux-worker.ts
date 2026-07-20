// Worker ghép video: nơi DUY NHẤT có `FileSystemSyncAccessHandle`.
//
// 🔴 BA RÀNG BUỘC NỀN TẢNG ĐÃ ĐO, đừng thiết kế lại:
// 1. `createSyncAccessHandle` CHỈ tồn tại trong Worker. Gọi ở luồng chính offscreen ném
//    `TypeError: fh.createSyncAccessHandle is not a function` — mà tsc/eslint/vitest đều
//    không thấy. Đúng lớp lỗi đã giết dự án này ba lần.
// 2. Trong Worker, `chrome` KHÔNG TỒN TẠI (offscreen còn có `chrome.runtime`, ở đây thì không).
//    Nên mọi đường dẫn phải do luồng chính truyền vào; libav nạp bằng `import()` ĐỘNG với URL
//    truyền vào, không phải import tĩnh.
// 3. `av_write_trailer` KHÔNG BAO GIỜ được bỏ qua mã trả về — xem `runMux`.
//
// Việc nặng chạy ở đây cũng giữ cho luồng chính offscreen RẢNH, nhờ vậy nhịp tim 5 giây
// (W2.7) vẫn đập trong suốt lúc ghép; nếu ghép ở luồng chính thì một job khoẻ sẽ bị tick
// dò-offscreen-chết GIẾT OAN sau ~60–90 giây.

import {
  moovReserveForPackets,
  remux,
  RemuxCancelledError,
  type LibavLike,
  type RemuxInputSpec,
  type RemuxResult,
} from '@/utils/remux-core';

/* ────────────────────────── Giao thức với luồng chính ────────────────────────── */

export interface MuxTrackSpec {
  /** 'v' | 'a' | '' — tiền tố đặt tên file OPFS, khớp quy ước cũ của FS ảo ffmpeg. */
  prefix: string;
  kind: 'video' | 'audio' | 'any';
  /** MPEG-TS cần bitstream filter aac_adtstoasc; fMP4 thì KHÔNG. */
  adtsToAsc: boolean;
}

type WorkerRequest =
  | { rid: number; cmd: 'init'; jobKey: string; libavBase: string; libavEntry: string }
  | { rid: number; cmd: 'append'; track: string; bytes: ArrayBuffer }
  | { rid: number; cmd: 'mux'; tracks: MuxTrackSpec[] }
  | { rid: number; cmd: 'cleanup'; keep?: string | null }
  | { rid: number; cmd: 'cancel' };

interface TrackFile {
  name: string;
  handle: FileSystemSyncAccessHandle;
  bytes: number;
}

/* ────────────────────────── Trạng thái ────────────────────────── */

let jobKey = '';
let libavBase = '';
let libavEntry = '';
let cancelled = false;
const tracks = new Map<string, TrackFile>();
let outName = '';
let outHandle: FileSystemSyncAccessHandle | null = null;

/**
 * Lỗi chốt lại từ callback ĐỒNG BỘ của device.
 *
 * 🔴 ĐO ĐƯỢC: `sah.write()` ném `QuotaExceededError` (DOMException, code 22 — phân biệt rõ với
 * `NoModificationAllowedError` code 7 của tranh chấp handle), KHÔNG có đường ghi thiếu: hoặc đủ
 * hoặc ném. Nhưng `libav.onwrite` chạy đồng bộ qua ranh giới wasm nên cú ném đó CÓ THỂ BỊ NUỐT,
 * và file ghi dở vẫn flush sạch, close sạch, đọc lại được — không cách nào phân biệt bằng kích
 * thước. Nên: chốt vào đây, và `remux()` hỏi lại sau mỗi lô ghi và sau `av_write_trailer`.
 */
let deviceError: Error | null = null;

/** Tiến trình KHÔNG GIẢM, kể cả khi phải mux lại lần hai vì đặt chỗ moov thiếu. */
let progressMax = 0;
function reportProgress(fraction: number): void {
  if (fraction <= progressMax) return;
  progressMax = fraction;
  post({ type: 'progress', fraction });
}

const post = (msg: Record<string, unknown>): void => {
  (self as unknown as Worker).postMessage(msg);
};
const logLine = (line: string): void => post({ type: 'log', line });

/**
 * Đổi DOMException của OPFS thành thông báo người dùng hiểu được.
 * Phân biệt theo `name`, KHÔNG theo nội dung chuỗi (chuỗi đổi theo phiên bản trình duyệt).
 */
function describeDeviceError(e: unknown, what: string): Error {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'QuotaExceededError') {
    return new Error(
      `Hết dung lượng trống khi ${what}. Video này quá lớn so với chỗ trống trên máy.`,
    );
  }
  if (name === 'NoModificationAllowedError') {
    return new Error(
      `Tệp tạm đang bị một lượt tải khác giữ (${what}). Thử lại sau khi lượt đó xong.`,
    );
  }
  return new Error(
    `Lỗi ${what}: ${e instanceof Error ? e.message : String(e)}`,
  );
}

async function root(): Promise<FileSystemDirectoryHandle> {
  return await navigator.storage.getDirectory();
}

/** Tên file OPFS của một track. Có `jobKey` để hai job không bao giờ đụng nhau. */
const trackFileName = (prefix: string): string =>
  `ymv-${jobKey}-${prefix === '' ? 'm' : prefix}.bin`;

async function openTrack(prefix: string): Promise<TrackFile> {
  const existing = tracks.get(prefix);
  if (existing) return existing;
  const dir = await root();
  const name = trackFileName(prefix);
  const fh = await dir.getFileHandle(name, { create: true });
  const handle = await fh.createSyncAccessHandle();
  handle.truncate(0);
  const t: TrackFile = { name, handle, bytes: 0 };
  tracks.set(prefix, t);
  return t;
}

/** Đóng mọi handle. PHẢI gọi trước khi luồng chính `getFile()` — SAH giữ khoá độc quyền. */
function closeHandles(): void {
  for (const t of tracks.values()) {
    try {
      t.handle.flush();
      t.handle.close();
    } catch {
      // đã đóng rồi thì thôi
    }
  }
  if (outHandle) {
    try {
      outHandle.flush();
      outHandle.close();
    } catch {
      // đã đóng rồi thì thôi
    }
    outHandle = null;
  }
}

async function removeFiles(keep?: string | null): Promise<void> {
  const dir = await root();
  const names = [...tracks.values()].map((t) => t.name);
  // File kết quả đã giao cho background (blob URL đang trỏ vào) thì GIỮ LẠI — nó được xoá
  // lúc `revoke`, hết TTL, hoặc bởi lượt quét lúc khởi động.
  if (outName && outName !== keep) names.push(outName);
  for (const n of names) {
    try {
      await dir.removeEntry(n);
    } catch {
      // file có thể chưa từng được tạo
    }
  }
  tracks.clear();
}

/* ────────────────────────── Nạp libav ────────────────────────── */

let libavPromise: Promise<LibavLike> | null = null;

interface LibavFactoryModule {
  default: {
    base: string;
    LibAV(opts: { noworker: boolean; nothreads: boolean }): Promise<LibavLike>;
  };
}

async function getLibav(): Promise<LibavLike> {
  if (!libavPromise) {
    libavPromise = (async () => {
      // import() ĐỘNG: URL do luồng chính truyền vào (`chrome.runtime.getURL`). Import TĨNH
      // không dùng được vì bundler sẽ cố gói libav vào chunk, mà nó phải nằm rời ở public/.
      const mod = (await import(/* @vite-ignore */ libavEntry)) as LibavFactoryModule;
      mod.default.base = libavBase;
      return await mod.default.LibAV({ noworker: true, nothreads: true });
    })().catch((e: unknown) => {
      libavPromise = null;
      throw e;
    });
  }
  return libavPromise;
}

/* ────────────────────────── Ghép ────────────────────────── */

interface MuxOutcome {
  outName: string;
  outBytes: number;
  packets: number;
  seams: number;
  moovAtFront: boolean;
  attempts: number;
}

async function runMux(specs: MuxTrackSpec[]): Promise<MuxOutcome> {
  const libav = await getLibav();
  const dir = await root();

  // Đóng handle GHI của các track input rồi mở lại để ĐỌC: cùng một file, nhưng vòng đời
  // ghi đã xong hẳn. `getSize()` ở đây chính là kích thước cuối — thứ mà
  // `mkblockreaderdev` bắt buộc phải biết trước.
  for (const t of tracks.values()) {
    t.handle.flush();
    t.handle.close();
  }
  const readers = new Map<string, { handle: FileSystemSyncAccessHandle; size: number }>();
  for (const [prefix, t] of tracks) {
    const fh = await dir.getFileHandle(t.name);
    const handle = await fh.createSyncAccessHandle();
    const size = handle.getSize();
    // 🔴 CỔNG ĐẾM BYTE. Bản ffmpeg cũ dò lỗ bằng cách xem mảng tên file có ô nào `undefined`
    // không — nối byte vào MỘT file thì dấu vết đó biến mất, nên phải đếm byte thay thế.
    // Ghi thiếu mà vẫn ghép = ra file thiếu đoạn mà không báo gì: đúng thứ W1.2 sinh ra để chặn.
    if (size !== t.bytes) {
      throw new Error(
        `Dữ liệu tải về không khớp (đã nhận ${t.bytes} byte, trên đĩa có ${size}) — không ghép để tránh ra file hỏng.`,
      );
    }
    readers.set(prefix, { handle, size });
  }

  outName = `ymv-${jobKey}-out.mp4`;
  try {
    await dir.removeEntry(outName);
  } catch {
    // chưa có thì thôi
  }
  const outFh = await dir.getFileHandle(outName, { create: true });

  const scratch = new Uint8Array(1 << 20);
  let readBytes = 0;
  const inputs: RemuxInputSpec[] = [];
  const deviceOf = new Map<string, string>();
  for (const spec of specs) {
    const r = readers.get(spec.prefix);
    if (!r) continue;
    const dev = `in${spec.prefix === '' ? 'm' : spec.prefix}.bin`;
    deviceOf.set(dev, spec.prefix);
    await libav.mkblockreaderdev(dev, r.size);
    inputs.push({ name: dev, kind: spec.kind, adtsToAsc: spec.adtsToAsc });
  }
  libav.onblockread = (name: string, pos: number, len: number): void => {
    const prefix = deviceOf.get(name);
    const r = prefix === undefined ? undefined : readers.get(prefix);
    if (!r) return;
    const n = Math.max(0, Math.min(len, scratch.length, r.size - pos));
    const view = scratch.subarray(0, n);
    try {
      const got = n > 0 ? r.handle.read(view, { at: pos }) : 0;
      readBytes += got;
      libav.ff_block_reader_dev_send(name, pos, view.subarray(0, got).slice());
    } catch (e) {
      deviceError ??= describeDeviceError(e, 'đọc dữ liệu đã tải');
      libav.ff_block_reader_dev_send(name, pos, null);
    }
  };

  const totalInputBytes = [...readers.values()].reduce((a, r) => a + r.size, 0);

  // Mỗi lần thử ghép: mở lại device ghi + handle ghi sạch (moov đặt chỗ khác nhau -> bố cục khác).
  let attempts = 0;
  let outBytes = 0;
  const attempt = async (moovSizeBytes: number | 'auto'): Promise<RemuxResult> => {
    attempts++;
    outHandle = await outFh.createSyncAccessHandle();
    outHandle.truncate(0);
    let written = 0;
    const devName = `out${attempts}.mp4`;
    await libav.mkwriterdev(devName);
    libav.onwrite = (_n: string, pos: number, buf: Uint8Array): void => {
      try {
        outHandle!.write(buf, { at: pos });
        written = Math.max(written, pos + buf.length);
      } catch (e) {
        deviceError ??= describeDeviceError(e, 'ghi tệp kết quả');
      }
    };
    try {
      const r = await remux(libav, {
        inputs,
        out: devName,
        moovSizeBytes,
        totalInputBytes,
        getReadBytes: () => readBytes,
        onProgress: reportProgress,
        deviceError: () => deviceError,
        isCancelled: () => cancelled,
        onLog: logLine,
      });
      outBytes = written;
      return r;
    } finally {
      outHandle.flush();
      outHandle.close();
      outHandle = null;
      readBytes = 0;
    }
  };

  let res = await attempt('auto');

  // 🔴 Đặt chỗ moov THIẾU = file HỎNG MÀ TRÔNG NHƯ THẬT. ĐO ĐƯỢC: `av_write_trailer` trả -28,
  // hộp sau moov parse thành rác, decoder ném "Invalid NAL unit size" — NHƯNG `ffprobe` vẫn
  // đọc được thời lượng và THOÁT MÃ 0. Không có cách nào phát hiện bằng cách probe file.
  // Vì vậy: bám đúng mã trả về, và có hai đường lùi thay vì giao file hỏng.
  if (res.trailerCode < 0) {
    logLine(`đặt chỗ moov thiếu (mã ${res.trailerCode}) — thử lại rộng gấp 4`);
    res = await attempt(moovReserveForPackets(res.packetsWritten) * 4);
  }
  let moovAtFront = true;
  if (res.trailerCode < 0) {
    // Đường lùi cuối: KHÔNG đặt chỗ. moov nằm cuối file — mất faststart nhưng LUÔN đúng.
    logLine(`vẫn thiếu (mã ${res.trailerCode}) — ghép lại với moov ở cuối file`);
    res = await attempt(0);
    moovAtFront = false;
  }
  if (res.trailerCode < 0) {
    throw new Error(
      `Ghép video thất bại khi ghi phần cuối tệp (mã ${res.trailerCode}).`,
    );
  }

  for (const r of readers.values()) {
    try {
      r.handle.close();
    } catch {
      // thôi
    }
  }

  return {
    outName,
    outBytes,
    packets: res.packetsWritten,
    seams: res.seams,
    moovAtFront,
    attempts,
  };
}

/* ────────────────────────── Vòng nhận lệnh ────────────────────────── */

/**
 * Hàng đợi lệnh TUẦN TỰ.
 *
 * 🔴 ĐO ĐƯỢC bằng e2e (không cổng tĩnh nào thấy): vòng tải gọi `append` từ NHIỀU worker fetch
 * song song, nên hai tin `append` cùng bay tới lúc chưa có file nào được mở. `openTrack` có
 * `await` ở giữa -> cả hai cùng thấy `tracks` rỗng -> cùng gọi `createSyncAccessHandle` trên
 * MỘT file, và cái thứ hai ném:
 *   "Access Handles cannot be created if there is another open Access Handle ..."
 * Toàn bộ job HLS chết ở ~segment 6/10. Xử lý tuần tự cũng bảo đảm luôn thứ tự BYTE khi nối
 * segment — thứ mà hai tin chạy xen kẽ có thể phá.
 */
let queue: Promise<void> = Promise.resolve();

self.addEventListener('message', (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  queue = queue.then(async () => {
    try {
      switch (msg.cmd) {
        case 'init': {
          jobKey = msg.jobKey;
          libavBase = msg.libavBase;
          libavEntry = msg.libavEntry;
          cancelled = false;
          deviceError = null;
          progressMax = 0;
          // Nạp libav SỚM, song song với việc tải segment — giống hệt cách cũ prewarm ffmpeg.
          void getLibav().catch(() => undefined);
          post({ rid: msg.rid, ok: true });
          return;
        }
        case 'append': {
          const t = await openTrack(msg.track);
          const bytes = new Uint8Array(msg.bytes);
          t.handle.write(bytes, { at: t.bytes });
          t.bytes += bytes.byteLength;
          post({ rid: msg.rid, ok: true, bytes: t.bytes });
          return;
        }
        case 'mux': {
          const out = await runMux(msg.tracks);
          post({ rid: msg.rid, ok: true, ...out });
          return;
        }
        case 'cleanup': {
          closeHandles();
          await removeFiles(msg.keep);
          post({ rid: msg.rid, ok: true });
          return;
        }
        case 'cancel': {
          cancelled = true;
          post({ rid: msg.rid, ok: true });
          return;
        }
      }
    } catch (e) {
      closeHandles();
      post({
        rid: msg.rid,
        ok: false,
        cancelled: e instanceof RemuxCancelledError,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
});
