// Cầu nối giữa luồng chính offscreen và Worker ghép video.
//
// Phân vai (đã ĐO, đừng đổi):
//   - Luồng chính offscreen: fetch mạng (giữ nguyên ngữ cảnh DNR spoof header của W2.1/W2.4),
//     `URL.createObjectURL` (Worker không có `chrome`, service worker KHÔNG có createObjectURL).
//   - Worker: `FileSystemSyncAccessHandle` (chỉ có ở đây) + libav.wasm.
//
// Byte segment đi thẳng từ fetch sang Worker bằng TRANSFER (zero-copy), rồi Worker ghi
// xuống OPFS. Không có bản sao nào nằm lại: đây là chỗ bỏ được trần RAM của bản ffmpeg cũ.

import type { MuxTrackSpec } from './mux-worker';

/**
 * Bản dựng libav.js tự biên dịch (variant `ts2mp4d`, LGPL, 0 encoder).
 * ⚠️ Đổi phiên bản thì phải đổi cả ở đây và `scripts/libav-vendor.test.ts` — ratchet đó
 * khoá đúng tên file để một lần nâng cấp hụt không biến thành lỗi lúc chạy.
 */
const LIBAV_ENTRY = '/libav/libav-6.9.8.1-ts2mp4d.mjs' as const;

export interface MuxOutcome {
  outName: string;
  outBytes: number;
  packets: number;
  seams: number;
  /** false = phải lùi về moov-ở-cuối (mất faststart nhưng file vẫn đúng). */
  moovAtFront: boolean;
  attempts: number;
}

interface WorkerReply {
  rid?: number;
  ok?: boolean;
  type?: string;
  line?: string;
  fraction?: number;
  error?: string;
  cancelled?: boolean;
  [key: string]: unknown;
}

/** Lỗi từ Worker do người dùng bấm Huỷ, phân biệt với lỗi thật. */
export class MuxCancelledError extends Error {
  constructor(message = 'Đã huỷ') {
    super(message);
    this.name = 'MuxCancelledError';
  }
}

export class MuxSession {
  private worker: Worker;
  private rid = 0;
  private readonly waiting = new Map<
    number,
    { resolve: (v: WorkerReply) => void; reject: (e: unknown) => void }
  >();
  private onProgress: ((fraction: number) => void) | null = null;
  private disposed = false;

  private constructor(worker: Worker) {
    this.worker = worker;
    this.worker.addEventListener('message', (ev: MessageEvent<WorkerReply>) => {
      const msg = ev.data;
      if (msg.type === 'progress' && typeof msg.fraction === 'number') {
        this.onProgress?.(msg.fraction);
        return;
      }
      if (msg.type === 'log') {
        console.debug('[mux-worker]', msg.line);
        return;
      }
      if (typeof msg.rid !== 'number') return;
      const w = this.waiting.get(msg.rid);
      if (!w) return;
      this.waiting.delete(msg.rid);
      if (msg.ok) w.resolve(msg);
      else if (msg.cancelled) w.reject(new MuxCancelledError(msg.error));
      else w.reject(new Error(msg.error ?? 'Worker ghép video lỗi không rõ.'));
    });
    // Worker chết (OOM, crash wasm) KHÔNG tự báo về qua rid nào cả — job sẽ treo vĩnh viễn
    // nếu không bắt ở đây. Đánh thức mọi lời gọi đang chờ bằng lỗi rõ ràng.
    this.worker.addEventListener('error', (ev: ErrorEvent) => {
      this.failAll(new Error(`Bộ ghép video dừng đột ngột: ${ev.message}`));
    });
  }

  private failAll(err: Error): void {
    for (const [, w] of this.waiting) w.reject(err);
    this.waiting.clear();
  }

  static async start(jobKey: string): Promise<MuxSession> {
    // Vite/WXT gói file này thành một chunk worker riêng; URL trỏ vào chính extension nên
    // CSP `script-src 'self'` chấp nhận.
    const worker = new Worker(new URL('./mux-worker.ts', import.meta.url), {
      type: 'module',
    });
    const s = new MuxSession(worker);
    // `base` của libav.js là THƯ MỤC chứa 3 file (.mjs + .wasm.mjs + .wasm) — nó tự ghép
    // tên file còn lại vào. Cắt từ chính URL entry để không phải khai một PublicPath thư mục.
    const libavEntry = browser.runtime.getURL(LIBAV_ENTRY);
    const libavBase = libavEntry.slice(0, libavEntry.lastIndexOf('/'));
    await s.call({ cmd: 'init', jobKey, libavBase, libavEntry });
    return s;
  }

  private call(
    payload: Record<string, unknown>,
    transfer?: Transferable[],
  ): Promise<WorkerReply> {
    if (this.disposed) {
      return Promise.reject(new Error('Bộ ghép video đã đóng.'));
    }
    const rid = ++this.rid;
    return new Promise<WorkerReply>((resolve, reject) => {
      this.waiting.set(rid, { resolve, reject });
      this.worker.postMessage({ ...payload, rid }, transfer ?? []);
    });
  }

  /**
   * Nối byte của MỘT segment vào file track trên OPFS.
   *
   * ⚠️ `bytes` bị TRANSFER (detach) sang Worker — y hệt `ffmpeg.writeFile` ngày trước.
   * Bên gọi tuyệt đối không được dùng lại buffer sau lời gọi này, và phải "xí phần" chỉ số
   * TRƯỚC khi await (nếu không, hai worker fetch song song sẽ ghi trùng một buffer đã detach).
   */
  async appendSegment(prefix: string, bytes: Uint8Array): Promise<void> {
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    await this.call({ cmd: 'append', track: prefix, bytes: buf }, [buf]);
  }

  async mux(
    tracks: MuxTrackSpec[],
    onProgress: (fraction: number) => void,
  ): Promise<MuxOutcome> {
    this.onProgress = onProgress;
    try {
      const r = await this.call({ cmd: 'mux', tracks });
      return {
        outName: String(r.outName),
        outBytes: Number(r.outBytes),
        packets: Number(r.packets),
        seams: Number(r.seams),
        moovAtFront: Boolean(r.moovAtFront),
        attempts: Number(r.attempts),
      };
    } finally {
      this.onProgress = null;
    }
  }

  /**
   * Lấy file kết quả từ OPFS ra dạng `File`.
   *
   * 🔬 ĐO ĐƯỢC (2026-07-19, Edge 150, extension thật): với file 1,2 GB thì `getFile()` mất
   * 0,0 ms và `createObjectURL()` mất 0,1 ms, RSS KHÔNG nhúc nhích và JS heap không đổi —
   * blob này là THAM CHIẾU TỚI FILE TRÊN ĐĨA, không phải bản sao trong RAM. Đây chính là
   * điều làm cho cả kiến trúc OPFS có ý nghĩa; nếu nó nạp hết vào RAM thì vô ích.
   */
  static async openOutput(outName: string): Promise<File> {
    const dir = await navigator.storage.getDirectory();
    const fh = await dir.getFileHandle(outName);
    return await fh.getFile();
  }

  /** Báo Worker dừng vòng ghép ở lô packet kế tiếp. */
  async cancel(): Promise<void> {
    try {
      await this.call({ cmd: 'cancel' });
    } catch {
      // Worker có thể đã chết — huỷ thì không cần ồn ào
    }
  }

  /**
   * Đóng handle + xoá file OPFS của job. Gọi trong `finally`, kể cả khi lỗi/huỷ.
   * `keep` = tên file kết quả đã giao cho background (đừng xoá, blob URL đang trỏ vào nó).
   */
  async cleanup(keep?: string | null): Promise<void> {
    try {
      await this.call({ cmd: 'cleanup', keep: keep ?? null });
    } catch {
      // Worker chết trước khi dọn: file mồ côi sẽ do lượt quét lúc khởi động dọn hộ
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error('Bộ ghép video đã đóng.'));
    this.worker.terminate();
  }
}

/** Xoá một file OPFS theo tên. Dùng khi lượt tải đã xong và blob URL được thu hồi. */
export async function removeOpfsFile(name: string): Promise<void> {
  try {
    const dir = await navigator.storage.getDirectory();
    await dir.removeEntry(name);
  } catch {
    // đã biến mất hoặc đang bị khoá — lượt quét lúc khởi động sẽ dọn nốt
  }
}

/** Tiền tố mọi file OPFS của extension này — dùng để quét dọn file mồ côi. */
export const OPFS_PREFIX = 'ymv-';

/**
 * Xoá file OPFS còn sót của các job đã chết (offscreen bị giết giữa chừng, trình duyệt tắt
 * ngang…). Chạy lúc offscreen khởi động: job đang chạy thì không tồn tại ở thời điểm đó, nên
 * không có gì để xoá nhầm.
 *
 * File đang bị một `SyncAccessHandle` khoá sẽ ném khi xoá — nuốt lỗi, lượt sau dọn tiếp.
 */
export async function sweepOrphanOpfsFiles(): Promise<number> {
  let removed = 0;
  try {
    const dir =
      (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & {
        keys?: () => AsyncIterableIterator<string>;
      };
    if (!dir.keys) return 0;
    const names: string[] = [];
    for await (const name of dir.keys()) {
      if (name.startsWith(OPFS_PREFIX)) names.push(name);
    }
    for (const n of names) {
      try {
        await dir.removeEntry(n);
        removed++;
      } catch {
        // đang bị khoá hoặc đã biến mất
      }
    }
  } catch {
    // OPFS không dùng được: không phải lý do để giết offscreen
  }
  return removed;
}
