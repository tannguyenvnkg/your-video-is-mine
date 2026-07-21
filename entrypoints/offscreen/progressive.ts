import { activeBlobUrls, BLOB_TTL_MS, revokeBlob } from './blob-store';
import { describeError } from '@/utils/errors';
import {
  CHUNK_THRESHOLD_BYTES,
  DEFAULT_CHUNK_BYTES,
  MAX_PROGRESSIVE_BYTES,
  parseContentRangeTotal,
  planRangeChunks,
  tooLargeMessage,
} from '@/utils/progressive';
import { HEARTBEAT_INTERVAL_MS } from '@/utils/liveness';
import type { DownloadEntry } from '@/utils/storage';
import type { OffscreenRequest } from '@/utils/messages';

// W2.5 — AbortController for each in-flight progressive fetch (cancel = .abort() yanks the request immediately).
export const progressiveAborts = new Map<string, AbortController>();

// --- W2.5: progressive download through offscreen ---
//
// WHY (measured 2026-07-18): `chrome.downloads.download({url})` fires a request that does NOT pick
// up the DNR modifyHeaders rule -> a hotlink-protected server sees `Referer: NONE` -> 403. The
// extension's own `fetch()` here is `xmlhttprequest`, tab-less -> MATCHES the spoof rule (W2.4) ->
// gets past the 403. `chrome.downloads.download` is therefore reduced to a SAVE-only tool (it takes
// a blob: URL), which matches VDH's invariant.

/** Reports progress/completion of a progressive fetch back to background. Does NOT throw (unlike updateHlsJob). */
async function updateProgressiveDownload(
  key: string,
  patch: Partial<DownloadEntry>,
): Promise<void> {
  try {
    await browser.runtime.sendMessage({
      kind: 'download/progress',
      key,
      patch,
    });
  } catch (e) {
    console.warn(
      '[offscreen] không gửi được tiến trình tải progressive:',
      describeError(e),
    );
  }
}

/** Minimum byte-report step (~1MB) — the stream returns many small chunks, don't spam storage on every one. */
const PROGRESS_REPORT_STEP = 1024 * 1024;

/**
 * Reads all of `res.body` (a stream) into a Blob, reporting progress in steps. Falls back to
 * arrayBuffer if there's no body. `heartbeat()` is called on every byte received -> resets the
 * anti-hang watchdog. Hard-caps once the limit is exceeded (server lies about content-length /
 * sends none) so offscreen doesn't OOM silently.
 */
async function readBodyToBlob(o: {
  res: Response;
  type: string;
  total: number | null;
  key: string;
  heartbeat: () => void;
}): Promise<Blob> {
  const { res, type, total, key, heartbeat } = o;
  if (!res.body) {
    // Can't read as a stream -> hold the whole file at once (acceptable, small file).
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_PROGRESSIVE_BYTES) {
      throw new Error(tooLargeMessage(buf.byteLength));
    }
    return new Blob([buf], { type });
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  let lastReport = 0;
  if (total != null) {
    await updateProgressiveDownload(key, {
      bytesTotal: total,
      bytesReceived: 0,
    });
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    heartbeat();
    received += value.byteLength;
    // Cap it before RAM blows up: the total may be unknown upfront (no content-length), so this
    // must be checked while reading. Cancel the reader to release the connection.
    if (received > MAX_PROGRESSIVE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(tooLargeMessage(received));
    }
    parts.push(value);
    if (received - lastReport >= PROGRESS_REPORT_STEP) {
      lastReport = received;
      await updateProgressiveDownload(key, { bytesReceived: received });
    }
  }
  await updateProgressiveDownload(key, { bytesReceived: received });
  return new Blob(parts as BlobPart[], { type });
}

/**
 * Downloads a file in Range chunks. The server MUST return 206 with the EXACT length of each chunk.
 * ⚠️ Does NOT cap RAM: the final Blob still holds the whole file (see the comment in progressive.ts).
 * The benefit is progress reporting + catching a server that doesn't honor Range.
 * `heartbeat()` resets the anti-hang watchdog.
 */
async function fetchByRangeChunks(o: {
  url: string;
  type: string;
  total: number;
  key: string;
  signal: AbortSignal;
  heartbeat: () => void;
}): Promise<Blob> {
  const { url, type, total, key, signal, heartbeat } = o;
  const parts: Uint8Array[] = [];
  let received = 0;
  await updateProgressiveDownload(key, { bytesTotal: total, bytesReceived: 0 });
  for (const c of planRangeChunks(total, DEFAULT_CHUNK_BYTES)) {
    const r = await fetch(url, {
      credentials: 'include',
      headers: { Range: `bytes=${c.start}-${c.end}` },
      signal,
    });
    // Server MUST honor Range: 200 = returns the whole file for every chunk -> ends up holding N
    // copies of the whole file (exactly the W1.3 trap). Better to FAIL LOUDLY than concatenate garbage bytes.
    if (r.status !== 206) {
      throw new Error(
        `Máy chủ không hỗ trợ tải theo đoạn (Range): trả HTTP ${r.status} thay vì 206.`,
      );
    }
    const buf = new Uint8Array(await r.arrayBuffer());
    heartbeat();
    // 206 SHORTER than the requested range (RFC allows this; a proxy/CDN can cap the range) ->
    // summing by the PLANNED size would skip the tail, assembling a Blob that's missing bytes yet
    // still marked 'complete'. Check the REAL length, fail loudly.
    const want = c.end - c.start + 1;
    if (buf.byteLength !== want) {
      throw new Error(
        `Máy chủ trả đoạn ngắn hơn yêu cầu (${buf.byteLength}/${want} byte) — dừng để tránh file hỏng.`,
      );
    }
    parts.push(buf);
    received += buf.byteLength;
    await updateProgressiveDownload(key, { bytesReceived: received });
  }
  return new Blob(parts as BlobPart[], { type });
}

/**
 * No new bytes within this window = treat the server as stuck -> abort. Reset on every byte
 * received (heartbeat) so it does NOT wrongly cut off a slow-but-still-running download; it only
 * cuts when things go completely still. The HLS path already has this invariant
 * (PLAYLIST_TIMEOUT_MS); progressive once dropped it -> jobs got stuck at 'in_progress' forever + a
 * leaked spoof rule.
 */
const PROGRESSIVE_STALL_MS = 60_000;

export async function runProgressiveDownload(
  req: Extract<OffscreenRequest, { kind: 'download/run' }>,
): Promise<void> {
  const { key, url, filename, mediaUrl, tabId, spoofRuleIds } = req;
  const ac = new AbortController();
  progressiveAborts.set(key, ac);

  // W2.7 — LIVENESS HEARTBEAT (very different from the `heartbeat` watchdog below: that one watches
  // for a SILENT SERVER, this one proves OFFSCREEN is still alive). W2.5 routes .mp4 through
  // offscreen so this path depends on offscreen exactly like HLS does; if offscreen is killed ⇒
  // `finally` never runs ⇒ nobody sends 'interrupted' ⇒ the entry is stuck at `in_progress` forever
  // (MEASURED: e2e `progressive-offscreen-death` stuck >150s before this fix).
  const livenessPing = setInterval(() => {
    void updateProgressiveDownload(key, {});
  }, HEARTBEAT_INTERVAL_MS);

  // Anti-hang watchdog: no progress within PROGRESSIVE_STALL_MS -> abort. `stalled` distinguishes
  // this from a user-cancel so the right error message is reported (network hang vs pressing Cancel).
  let stalled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const heartbeat = (): void => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      ac.abort();
    }, PROGRESSIVE_STALL_MS);
  };

  try {
    heartbeat(); // also covers the probe: server not returning headers within 60s -> abort.
    // 1-byte Range probe: (1) measures the total file size + whether the server supports Range;
    // (2) is the FIRST fetch through the spoof rule -> a 403 here means the spoof isn't applying
    // (report a clear error instead of downloading garbage bytes).
    const probe = await fetch(url, {
      credentials: 'include',
      headers: { Range: 'bytes=0-0' },
      signal: ac.signal,
    });
    heartbeat();
    if (!probe.ok && probe.status !== 206) {
      throw new Error(`Máy chủ trả mã ${probe.status}.`);
    }
    const contentType = probe.headers.get('content-type') || 'video/mp4';
    const total =
      probe.status === 206
        ? parseContentRangeTotal(probe.headers.get('content-range'))
        : Number(probe.headers.get('content-length')) || null;

    // Hard cap: file too large -> REPORT A CLEAR ERROR, don't let offscreen silently OOM-crash
    // (losing the catch branch below -> job stuck forever + a leaked rule). Real RAM-capping is
    // Wave 3 (OPFS). If the total is unknown -> checked mid-stream instead.
    if (total != null && total > MAX_PROGRESSIVE_BYTES) {
      throw new Error(tooLargeMessage(total));
    }

    let blob: Blob;
    if (
      probe.status === 206 &&
      total != null &&
      total > CHUNK_THRESHOLD_BYTES
    ) {
      // LARGE file + server supports Range -> chunk it. Drop the probe body (1 byte).
      await probe.body?.cancel().catch(() => undefined);
      blob = await fetchByRangeChunks({
        url,
        type: contentType,
        total,
        key,
        signal: ac.signal,
        heartbeat,
      });
    } else if (probe.status === 200) {
      // Server ignores Range -> the probe body IS the whole file, read it directly (no re-fetch).
      blob = await readBodyToBlob({
        res: probe,
        type: contentType,
        total,
        key,
        heartbeat,
      });
    } else {
      // Small file (206) or total unknown -> a single GET for the whole file, stream the body.
      await probe.body?.cancel().catch(() => undefined);
      const res = await fetch(url, {
        credentials: 'include',
        signal: ac.signal,
      });
      heartbeat();
      if (!res.ok) throw new Error(`Máy chủ trả mã ${res.status}.`);
      const streamTotal =
        total ?? (Number(res.headers.get('content-length')) || null);
      blob = await readBodyToBlob({
        res,
        type: contentType,
        total: streamTotal,
        key,
        heartbeat,
      });
    }

    // Hand the blob to background to SAVE via chrome.downloads (only accepts a blob: URL — VDH's invariant).
    const blobUrl = URL.createObjectURL(blob);
    activeBlobUrls.add(blobUrl);
    setTimeout(() => revokeBlob(blobUrl), BLOB_TTL_MS);
    await browser.runtime.sendMessage({
      kind: 'download/blob',
      blobUrl,
      filename,
      mediaUrl,
      tabId,
      // Not an HLS job: use downloadKey so background attaches this to the CORRECT DownloadEntry being fetched.
      jobId: key,
      downloadKey: key,
      spoofRuleIds,
    });
  } catch (e) {
    const userCancelled =
      !stalled &&
      (ac.signal.aborted || (e instanceof Error && e.name === 'AbortError'));
    await updateProgressiveDownload(key, {
      state: 'interrupted',
      error: stalled
        ? 'Máy chủ không phản hồi (quá thời gian chờ).'
        : userCancelled
          ? 'Đã huỷ'
          : describeError(e),
    });
  } finally {
    if (watchdog) clearTimeout(watchdog);
    clearInterval(livenessPing);
    progressiveAborts.delete(key);
  }
}
