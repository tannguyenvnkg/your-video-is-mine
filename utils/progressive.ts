// W2.5 — pure logic for the progressive-download path through offscreen.
//
// WHY GO THROUGH OFFSCREEN (measured 2026-07-18): `chrome.downloads.download({url})` fires a
// request that does NOT pick up DNR modifyHeaders rules — an anti-hotlink server sees
// `Referer: NONE` -> 403. The extension's `fetch()` inside offscreen is a tab-less
// `xmlhttprequest` -> DOES match the spoof rule (§2.10/W2.4) -> gets past the 403.
//
// ⚠️ HONEST NOTE ON RAM: chunking by Range **does NOT cap the peak RAM** — the final Blob still
// holds the ENTIRE file in offscreen RAM (peak ~2x while building the Blob), same as reading a
// stream. The real benefits of chunking are only: (1) progress reporting per chunk, (2) CATCHING a
// server that doesn't honor Range (206 guard), (3) avoiding one single giant `arrayBuffer()` call.
// Real RAM bounding (streaming straight to disk) has to wait for Batch 3 (OPFS). Until then, hard-cap
// via MAX_PROGRESSIVE_BYTES so an oversized file gets a CLEAR ERROR instead of a silent offscreen
// OOM crash (a crash that tears down the whole document -> job stuck 'in_progress' forever + spoof
// rule leaking for the rest of the session).

/** Default Range chunk size (8 MiB) — large enough for few requests, small enough for smooth progress. */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * A file is only worth chunking by Range once it's large enough (small files are simpler as one GET
 * stream). Below this threshold, download in one shot. NOT related to RAM (see file header comment)
 * — just the "worth splitting" threshold.
 */
export const CHUNK_THRESHOLD_BYTES = 16 * 1024 * 1024;

/**
 * Hard cap for progressive downloads through offscreen: exceeding it is a CLEAR ERROR (don't let
 * offscreen OOM silently). 2 GiB — matches the "2GB video" tier that Batch 3 (OPFS) will unlock;
 * remove this cap once that lands.
 */
export const MAX_PROGRESSIVE_BYTES = 2 * 1024 * 1024 * 1024;

/** Error message when a file exceeds the cap — extracted for shared use (pre-check + mid-stream). */
export function tooLargeMessage(totalBytes: number): string {
  const gb = (n: number) => (n / (1024 * 1024 * 1024)).toFixed(1);
  return `File quá lớn để tải trong bộ nhớ (~${gb(totalBytes)} GB, giới hạn ${gb(MAX_PROGRESSIVE_BYTES)} GB). Tính năng tải file rất lớn sẽ có ở bản sau.`;
}

export interface ByteChunk {
  /** first byte (inclusive). */
  start: number;
  /** last byte (INCLUSIVE) — matches the `Range: bytes=start-end` header. */
  end: number;
}

/**
 * Split `[0, total-1]` into `chunkSize`-byte chunks, CLOSED on both ends (matches HTTP Range syntax).
 * total <= 0 -> empty (empty/invalid file). chunkSize <= 0 -> a single chunk (guards against divide-by-0).
 */
export function planRangeChunks(total: number, chunkSize: number): ByteChunk[] {
  if (!Number.isFinite(total) || total <= 0) return [];
  const size = chunkSize > 0 ? Math.floor(chunkSize) : total;
  const chunks: ByteChunk[] = [];
  for (let start = 0; start < total; start += size) {
    chunks.push({ start, end: Math.min(start + size - 1, total - 1) });
  }
  return chunks;
}

/**
 * Read the TOTAL byte count from the `Content-Range` header (e.g. `bytes 0-0/12345` -> 12345).
 * Returns null when the total is unknown (`bytes 0-0/*`) or the header is missing/invalid.
 */
export function parseContentRangeTotal(
  header: string | null | undefined,
): number | null {
  if (!header) return null;
  const m = /\/(\d+)\s*$/.exec(header.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
