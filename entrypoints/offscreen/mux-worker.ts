// Muxing worker: the ONLY place `FileSystemSyncAccessHandle` is used.
//
// 🔴 THREE FOUNDATIONAL CONSTRAINTS, VERIFIED IN PRACTICE — don't redesign around them:
// 1. `createSyncAccessHandle` ONLY exists inside a Worker. Calling it on the offscreen main thread
//    throws `TypeError: fh.createSyncAccessHandle is not a function` — which tsc/eslint/vitest all
//    miss. Exactly the class of bug that has killed this project three times.
// 2. Inside a Worker, `chrome` does NOT EXIST (offscreen still has `chrome.runtime`, but here there's
//    nothing). So every path must be passed in by the main thread; libav is loaded via a DYNAMIC
//    `import()` with a passed-in URL, not a static import.
// 3. The return code of `av_write_trailer` must NEVER be ignored — see `runMux`.
//
// Running the heavy work here also keeps the offscreen main thread FREE, so the 5-second heartbeat
// (W2.7) keeps beating throughout muxing; if muxing ran on the main thread, a healthy job would get
// WRONGLY KILLED by the dead-offscreen-detection tick after ~60–90 seconds.

import {
  moovReserveForPackets,
  remux,
  RemuxCancelledError,
  type LibavLike,
  type RemuxInputSpec,
  type RemuxResult,
} from '@/utils/remux-core';

/* ────────────────────────── Protocol with the main thread ────────────────────────── */

export interface MuxTrackSpec {
  /** 'v' | 'a' | '' — OPFS filename prefix, matching the old convention of ffmpeg's virtual FS. */
  prefix: string;
  kind: 'video' | 'audio' | 'any';
  /** MPEG-TS needs the aac_adtstoasc bitstream filter; fMP4 does NOT. */
  adtsToAsc: boolean;
}

type WorkerRequest =
  | {
      rid: number;
      cmd: 'init';
      jobKey: string;
      libavBase: string;
      libavEntry: string;
    }
  | { rid: number; cmd: 'append'; track: string; bytes: ArrayBuffer }
  | { rid: number; cmd: 'mux'; tracks: MuxTrackSpec[] }
  | { rid: number; cmd: 'cleanup'; keep?: string | null }
  | { rid: number; cmd: 'cancel' };

interface TrackFile {
  name: string;
  handle: FileSystemSyncAccessHandle;
  bytes: number;
}

/* ────────────────────────── State ────────────────────────── */

let jobKey = '';
let libavBase = '';
let libavEntry = '';
let cancelled = false;
const tracks = new Map<string, TrackFile>();
let outName = '';
let outHandle: FileSystemSyncAccessHandle | null = null;

/**
 * Error latched from a device's SYNCHRONOUS callback.
 *
 * 🔴 VERIFIED IN PRACTICE: `sah.write()` throws `QuotaExceededError` (DOMException, code 22 —
 * clearly distinct from `NoModificationAllowedError` code 7 for handle contention); there's no
 * partial-write path: either it fully succeeds or it throws. But `libav.onwrite` runs synchronously
 * across the wasm boundary, so that throw CAN GET SWALLOWED, and the partially-written file still
 * flushes cleanly, closes cleanly, and reads back fine — no way to tell by size alone. So: latch it
 * here, and `remux()` re-checks it after every write batch and after `av_write_trailer`.
 */
let deviceError: Error | null = null;

/** Progress NEVER DECREASES, even when a second mux pass is needed due to insufficient moov reservation. */
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
 * Turn an OPFS DOMException into a message the user can understand.
 * Distinguished by `name`, NOT by string content (the message text changes across browser versions).
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

/** OPFS filename of a track. Includes `jobKey` so two jobs never collide. */
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

/** Close every handle. MUST be called before the main thread's `getFile()` — SAH holds an exclusive lock. */
function closeHandles(): void {
  for (const t of tracks.values()) {
    try {
      t.handle.flush();
      t.handle.close();
    } catch {
      // already closed, ignore
    }
  }
  if (outHandle) {
    try {
      outHandle.flush();
      outHandle.close();
    } catch {
      // already closed, ignore
    }
    outHandle = null;
  }
}

async function removeFiles(keep?: string | null): Promise<void> {
  const dir = await root();
  const names = [...tracks.values()].map((t) => t.name);
  // KEEP the result file if it has already been handed to background (a blob URL is pointing at
  // it) — it gets removed on `revoke`, on TTL expiry, or by the startup sweep.
  if (outName && outName !== keep) names.push(outName);
  for (const n of names) {
    try {
      await dir.removeEntry(n);
    } catch {
      // the file may never have been created
    }
  }
  tracks.clear();
}

/* ────────────────────────── Loading libav ────────────────────────── */

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
      // DYNAMIC import(): URL is passed in by the main thread (`chrome.runtime.getURL`). A static
      // import can't be used because the bundler would try to bundle libav into a chunk, but it needs
      // to stay a separate file under public/.
      const mod = (await import(
        /* @vite-ignore */ libavEntry
      )) as LibavFactoryModule;
      mod.default.base = libavBase;
      return await mod.default.LibAV({ noworker: true, nothreads: true });
    })().catch((e: unknown) => {
      libavPromise = null;
      throw e;
    });
  }
  return libavPromise;
}

/* ────────────────────────── Muxing ────────────────────────── */

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

  // Close the WRITE handles of the input tracks and reopen them for READING: same file, but the
  // write lifecycle is fully done. `getSize()` here is exactly the final size — something
  // `mkblockreaderdev` must know in advance.
  for (const t of tracks.values()) {
    t.handle.flush();
    t.handle.close();
  }
  const readers = new Map<
    string,
    { handle: FileSystemSyncAccessHandle; size: number }
  >();
  for (const [prefix, t] of tracks) {
    const fh = await dir.getFileHandle(t.name);
    const handle = await fh.createSyncAccessHandle();
    const size = handle.getSize();
    // 🔴 BYTE-COUNT GATE. The old ffmpeg version detected gaps by checking whether the filename
    // array had any `undefined` slot — appending bytes into ONE file makes that signal disappear,
    // so byte counting has to replace it. Muxing with an incomplete write = a file missing a chunk
    // with no error reported: exactly what W1.2 exists to block.
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
    // doesn't exist yet, ignore
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

  // Each mux attempt: reopen a write device + a clean write handle (different moov reservation -> different layout).
  let attempts = 0;
  let outBytes = 0;
  const attempt = async (
    moovSizeBytes: number | 'auto',
  ): Promise<RemuxResult> => {
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

  // 🔴 INSUFFICIENT moov reservation = a BROKEN FILE THAT LOOKS FINE. VERIFIED IN PRACTICE:
  // `av_write_trailer` returns -28, the box after moov parses into garbage, the decoder throws
  // "Invalid NAL unit size" — BUT `ffprobe` still reads a duration and EXITS CODE 0. There's no way
  // to detect this by probing the file. So: rely strictly on the return code, and have two fallback
  // paths instead of handing over a broken file.
  if (res.trailerCode < 0) {
    logLine(`đặt chỗ moov thiếu (mã ${res.trailerCode}) — thử lại rộng gấp 4`);
    res = await attempt(moovReserveForPackets(res.packetsWritten) * 4);
  }
  let moovAtFront = true;
  if (res.trailerCode < 0) {
    // Last fallback: NO reservation. moov sits at the end of the file — loses faststart but is ALWAYS correct.
    logLine(
      `vẫn thiếu (mã ${res.trailerCode}) — ghép lại với moov ở cuối file`,
    );
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
      // ignore
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

/* ────────────────────────── Command receive loop ────────────────────────── */

/**
 * SEQUENTIAL command queue.
 *
 * 🔴 VERIFIED IN PRACTICE via e2e (no static gate catches this): the download loop calls `append`
 * from MULTIPLE parallel fetch workers, so two `append` messages can arrive before any file is
 * open. `openTrack` has an `await` in the middle -> both see `tracks` as empty -> both call
 * `createSyncAccessHandle` on the SAME file, and the second one throws:
 *   "Access Handles cannot be created if there is another open Access Handle ..."
 * The entire HLS job dies at ~segment 6/10. Sequential processing also guarantees BYTE ordering
 * when concatenating segments — something interleaved messages could break.
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
          // Load libav EARLY, in parallel with segment downloading — same as the old ffmpeg prewarm approach.
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
