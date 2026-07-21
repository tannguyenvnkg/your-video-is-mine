// Bridge between the offscreen main thread and the muxing Worker.
//
// Role split (MEASURED, do not change):
//   - Offscreen main thread: network fetch (keeps the DNR header-spoof context from W2.1/W2.4
//     intact), `URL.createObjectURL` (the Worker has no `chrome`, and the service worker has NO
//     createObjectURL).
//   - Worker: `FileSystemSyncAccessHandle` (only available here) + libav.wasm.
//
// Segment bytes go straight from fetch to the Worker via TRANSFER (zero-copy), then the Worker
// writes them to OPFS. No copy is left behind: this is what drops the RAM ceiling the old ffmpeg
// build had.

import type { MuxTrackSpec } from './mux-worker';

/**
 * Self-compiled libav.js build (`ts2mp4d` variant, LGPL, 0 encoders).
 * ⚠️ Changing the version requires changing it both here and in `scripts/libav-vendor.test.ts` —
 * that ratchet locks the exact filename so a botched upgrade doesn't turn into a runtime error.
 */
const LIBAV_ENTRY = '/libav/libav-6.9.8.1-ts2mp4d.mjs' as const;

export interface MuxOutcome {
  outName: string;
  outBytes: number;
  packets: number;
  seams: number;
  /** false = had to fall back to moov-at-end (loses faststart but the file is still correct). */
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

/** Error from the Worker caused by the user pressing Cancel, distinguished from a real error. */
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
    // Worker death (OOM, wasm crash) does NOT report back through any rid — the job would hang
    // forever if this isn't caught here. Wake up every waiting call with a clear error.
    this.worker.addEventListener('error', (ev: ErrorEvent) => {
      this.failAll(new Error(`Bộ ghép video dừng đột ngột: ${ev.message}`));
    });
  }

  private failAll(err: Error): void {
    for (const [, w] of this.waiting) w.reject(err);
    this.waiting.clear();
  }

  static async start(jobKey: string): Promise<MuxSession> {
    // Vite/WXT bundles this file into a separate worker chunk; the URL points into the extension
    // itself so the CSP `script-src 'self'` accepts it.
    const worker = new Worker(new URL('./mux-worker.ts', import.meta.url), {
      type: 'module',
    });
    const s = new MuxSession(worker);
    // libav.js's `base` is the DIRECTORY containing 3 files (.mjs + .wasm.mjs + .wasm) — it
    // appends the remaining filenames itself. Sliced from the entry URL so we don't have to
    // declare a directory PublicPath.
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
   * Appends the bytes of ONE segment to the track file on OPFS.
   *
   * ⚠️ `bytes` gets TRANSFERRED (detached) to the Worker — exactly like `ffmpeg.writeFile` used
   * to. The caller must absolutely not reuse the buffer after this call, and must "claim" its
   * index slot BEFORE awaiting (otherwise two parallel fetch workers would write into the same
   * already-detached buffer).
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
   * Retrieves the result file from OPFS as a `File`.
   *
   * 🔬 MEASURED (2026-07-19, Edge 150, real extension): for a 1.2 GB file, `getFile()` takes
   * 0.0 ms and `createObjectURL()` takes 0.1 ms, RSS DOES NOT budge and the JS heap doesn't
   * change — this blob is a REFERENCE TO THE FILE ON DISK, not a copy in RAM. This is exactly
   * what makes the whole OPFS architecture meaningful; if it loaded everything into RAM it would
   * be pointless.
   */
  static async openOutput(outName: string): Promise<File> {
    const dir = await navigator.storage.getDirectory();
    const fh = await dir.getFileHandle(outName);
    return await fh.getFile();
  }

  /** Tells the Worker to stop the mux loop at the next packet batch. */
  async cancel(): Promise<void> {
    try {
      await this.call({ cmd: 'cancel' });
    } catch {
      // Worker may already be dead — cancellation doesn't need to be noisy about it
    }
  }

  /**
   * Closes handles + removes the job's OPFS file. Called in `finally`, including on error/cancel.
   * `keep` = name of the output file already handed to background (don't delete it, the blob URL
   * still points to it).
   */
  async cleanup(keep?: string | null): Promise<void> {
    try {
      await this.call({ cmd: 'cleanup', keep: keep ?? null });
    } catch {
      // Worker died before cleaning up: the startup orphan sweep will clean it up instead
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error('Bộ ghép video đã đóng.'));
    this.worker.terminate();
  }
}

/** Removes an OPFS file by name. Used once a download has finished and the blob URL is revoked. */
export async function removeOpfsFile(name: string): Promise<void> {
  try {
    const dir = await navigator.storage.getDirectory();
    await dir.removeEntry(name);
  } catch {
    // already gone or currently locked — the startup sweep will clean it up next time
  }
}

/** Prefix for every OPFS file belonging to this extension — used to sweep orphan files. */
export const OPFS_PREFIX = 'ymv-';

/**
 * Removes leftover OPFS files from dead jobs (offscreen killed mid-flight, browser closed
 * abruptly…). Runs at offscreen startup: at that point no job can be running, so there's nothing
 * to accidentally delete.
 *
 * A file locked by a `SyncAccessHandle` throws on delete — swallow the error, a later sweep will
 * finish the job.
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
        // currently locked or already gone
      }
    }
  } catch {
    // OPFS unavailable: not a reason to kill offscreen
  }
  return removed;
}
