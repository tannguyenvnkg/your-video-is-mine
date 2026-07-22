import {
  activeBlobUrls,
  opfsByBlobUrl,
  BLOB_TTL_MS,
  revokeBlob,
} from './blob-store';
import { MuxCancelledError, MuxSession } from './libav-mux';
import type { MuxTrackSpec } from './mux-worker';
import {
  DEFAULT_CHUNK_BYTES,
  MAX_PROGRESSIVE_BYTES,
  parseContentRangeTotal,
  planRangeChunks,
  tooLargeMessage,
} from '@/utils/progressive';
// TYPE-only import (erased at compile time) — offscreen has NO chrome.storage, so pulling a real
// storage function into this chain would be a runtime TypeError no static gate catches. Keep it types.
import { HEARTBEAT_INTERVAL_MS } from '@/utils/liveness';
import { CancelledError } from '@/utils/retry';
import { describeError } from '@/utils/errors';
import type { HlsJob } from '@/utils/storage';
import type { OffscreenRequest } from '@/utils/messages';

// Track 2 — download two direct googlevideo URLs (video + audio track) and mux them into one .mp4
// with the SAME libav worker the HLS/DASH path uses. Reuses the HlsJob progress record so the popup's
// job UI applies unchanged.
//
// Why offscreen (not background): `URL.createObjectURL` + the mux Worker only exist here; the service
// worker has neither. googlevideo URLs need NO DNR spoof — they carry their own auth and 206 on a
// plain cross-origin fetch (measured 2026-07-22).

// One AbortController per job — cancel aborts the in-flight fetch AND tells the mux worker to stop.
export const youtubeAborts = new Map<string, AbortController>();

// MUST NOT THROW OUTWARD (same contract as hls-job's updateHlsJob): called at every step including
// inside the catch block. A throw here would erase the original error and hang the job. Swallow +
// log — offscreen reports state ONLY through background (it has no chrome.storage).
async function reportJob(jobId: string, patch: Partial<HlsJob>): Promise<void> {
  try {
    await browser.runtime.sendMessage({ kind: 'hls/progress', jobId, patch });
  } catch (e) {
    console.warn(
      '[offscreen] không gửi được tiến trình YouTube về background:',
      describeError(e),
    );
  }
}

/** 1-byte Range probe: measures the total size + proves the URL is alive (a dead/expired URL 403s here). */
async function probeTotal(
  url: string,
  signal: AbortSignal,
): Promise<number | null> {
  const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal });
  await r.body?.cancel().catch(() => undefined);
  if (!r.ok && r.status !== 206) {
    throw new Error(`Máy chủ trả mã ${r.status} (liên kết có thể đã hết hạn).`);
  }
  return r.status === 206
    ? parseContentRangeTotal(r.headers.get('content-range'))
    : Number(r.headers.get('content-length')) || null;
}

/**
 * Downloads one track into its OPFS file via `appendSegment`. Range-chunks when the size is known
 * (progress + verifies the server honors Range); otherwise streams a single GET. Returns bytes written.
 * `appendSegment` copies+transfers each chunk, so the source buffer is never reused after the call.
 */
async function fetchTrackInto(o: {
  session: MuxSession;
  prefix: 'v' | 'a';
  url: string;
  total: number | null;
  signal: AbortSignal;
  throwIfCancelled: () => void;
  onChunk: (n: number) => Promise<void>;
}): Promise<number> {
  const { session, prefix, url, total, signal, throwIfCancelled, onChunk } = o;
  let written = 0;

  if (total != null && total > 0) {
    for (const c of planRangeChunks(total, DEFAULT_CHUNK_BYTES)) {
      throwIfCancelled();
      const r = await fetch(url, {
        headers: { Range: `bytes=${c.start}-${c.end}` },
        signal,
      });
      // 200 = server ignores Range and returns the whole file per chunk (the W1.3 trap) -> fail loud.
      if (r.status !== 206) {
        throw new Error(
          `Máy chủ không hỗ trợ tải theo đoạn (Range): trả HTTP ${r.status} thay vì 206.`,
        );
      }
      const buf = new Uint8Array(await r.arrayBuffer());
      const want = c.end - c.start + 1;
      if (buf.byteLength !== want) {
        throw new Error(
          `Máy chủ trả đoạn ngắn hơn yêu cầu (${buf.byteLength}/${want} byte) — dừng để tránh file hỏng.`,
        );
      }
      await session.appendSegment(prefix, buf);
      written += buf.byteLength;
      await onChunk(buf.byteLength);
    }
    return written;
  }

  // Size unknown -> single GET, stream into the track file. Hard-cap RAM the same way progressive does.
  throwIfCancelled();
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`Máy chủ trả mã ${r.status}.`);
  if (!r.body) {
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength > MAX_PROGRESSIVE_BYTES) {
      throw new Error(tooLargeMessage(buf.byteLength));
    }
    await session.appendSegment(prefix, buf);
    return buf.byteLength;
  }
  const reader = r.body.getReader();
  for (;;) {
    throwIfCancelled();
    const { done, value } = await reader.read();
    if (done) break;
    if (written + value.byteLength > MAX_PROGRESSIVE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(tooLargeMessage(written + value.byteLength));
    }
    await session.appendSegment(prefix, value);
    written += value.byteLength;
    await onChunk(value.byteLength);
  }
  return written;
}

export async function runYoutubeJob(
  req: Extract<OffscreenRequest, { kind: 'youtube/run' }>,
): Promise<void> {
  const { jobId, filename, mediaUrl, tabId, videoUrl, audioUrl } = req;
  // Cancellation can arrive BEFORE the job starts (offscreen/main pre-registers an aborted controller).
  const ac = youtubeAborts.get(jobId) ?? new AbortController();
  youtubeAborts.set(jobId, ac);
  const throwIfCancelled = (): void => {
    if (ac.signal.aborted) throw new CancelledError('Đã huỷ');
  };

  // Liveness heartbeat: proves offscreen is alive so the dead-job reaper (W2.7) doesn't kill a healthy
  // long download. Small files send few progress updates, so an explicit ping is required.
  const livenessPing = setInterval(
    () => void reportJob(jobId, {}),
    HEARTBEAT_INTERVAL_MS,
  );

  let session: MuxSession | null = null;
  // Declared out here so `finally` can adopt a Worker that was STARTED but not yet assigned to
  // `session` when a pre-mux throw (expired-URL probe, size-cap) short-circuits the try.
  let sessionPromise: Promise<MuxSession> | null = null;
  let deliveredOpfs: string | null = null;
  try {
    throwIfCancelled();
    await reportJob(jobId, { phase: 'loading' });

    // Spin up the mux Worker in parallel with probing the two track sizes.
    const jobKey = jobId.replace(/[^a-zA-Z0-9_-]/g, '');
    sessionPromise = MuxSession.start(jobKey);

    const vTotal = req.videoBytes ?? (await probeTotal(videoUrl, ac.signal));
    const aTotal = req.audioBytes ?? (await probeTotal(audioUrl, ac.signal));
    const grandTotal = (vTotal ?? 0) + (aTotal ?? 0);
    if (grandTotal > MAX_PROGRESSIVE_BYTES) {
      throw new Error(tooLargeMessage(grandTotal));
    }

    session = await sessionPromise;
    const activeSession = session;
    // Pressing Cancel WHILE MUXING: signal the Worker directly so it stops at the next packet batch.
    ac.signal.addEventListener('abort', () => void activeSession.cancel(), {
      once: true,
    });

    // Two "segments" = the two tracks, so the popup's segmentsDone/Total bar shows 0 -> 2.
    await reportJob(jobId, {
      phase: 'fetching',
      segmentsTotal: 2,
      segmentsDone: 0,
      bytesDownloaded: 0,
      bytesTotal: grandTotal || undefined,
      startedAt: Date.now(),
    });

    let bytesDownloaded = 0;
    const onChunk = async (n: number): Promise<void> => {
      bytesDownloaded += n;
      await reportJob(jobId, { bytesDownloaded });
    };

    const vBytes = await fetchTrackInto({
      session: activeSession,
      prefix: 'v',
      url: videoUrl,
      total: vTotal,
      signal: ac.signal,
      throwIfCancelled,
      onChunk,
    });
    await reportJob(jobId, { segmentsDone: 1 });
    const aBytes = await fetchTrackInto({
      session: activeSession,
      prefix: 'a',
      url: audioUrl,
      total: aTotal,
      signal: ac.signal,
      throwIfCancelled,
      onChunk,
    });
    await reportJob(jobId, { segmentsDone: 2 });

    // A zero-byte track guarantees a corrupted file — refuse to mux (the §2.1 silent-failure trap).
    if (vBytes === 0 || aBytes === 0) {
      throw new Error(
        `Tải về 0 byte (hình ${vBytes}, tiếng ${aBytes}) — không ghép để tránh ra file hỏng.`,
      );
    }

    await reportJob(jobId, { phase: 'muxing', muxProgress: 0, note: '' });
    // googlevideo video+audio are fMP4 (NOT MPEG-TS) -> no aac_adtstoasc filter.
    const tracks: MuxTrackSpec[] = [
      { prefix: 'v', kind: 'video', adtsToAsc: false },
      { prefix: 'a', kind: 'audio', adtsToAsc: false },
    ];
    let lastPct = -1;
    const outcome = await activeSession.mux(tracks, (fraction) => {
      const pct = Math.floor(fraction * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      void reportJob(jobId, { muxProgress: fraction });
    });
    if (!outcome.moovAtFront) {
      console.warn(
        '[offscreen] youtube job phải lùi về moov ở cuối file:',
        jobId,
      );
    }

    await reportJob(jobId, { phase: 'saving' });
    throwIfCancelled();

    const outFile = await MuxSession.openOutput(outcome.outName);
    const blobUrl = URL.createObjectURL(outFile);
    activeBlobUrls.add(blobUrl);
    opfsByBlobUrl.set(blobUrl, outcome.outName);
    deliveredOpfs = outcome.outName;
    setTimeout(() => revokeBlob(blobUrl), BLOB_TTL_MS);
    await browser.runtime.sendMessage({
      kind: 'download/blob',
      blobUrl,
      filename,
      mediaUrl,
      tabId,
      jobId,
    });
    await reportJob(jobId, { phase: 'done', segmentsDone: 2 });
  } catch (e) {
    // `ac.signal.aborted` covers a native AbortError from a raw fetch cancelled mid-flight (which is
    // neither CancelledError nor MuxCancelledError) -> classify it as a clean cancel, not a red error
    // with an untranslated browser message.
    if (
      ac.signal.aborted ||
      e instanceof CancelledError ||
      e instanceof MuxCancelledError
    ) {
      await reportJob(jobId, { phase: 'cancelled', error: 'Đã huỷ' });
    } else {
      await reportJob(jobId, { phase: 'error', error: describeError(e) });
    }
  } finally {
    clearInterval(livenessPing);
    // Adopt a Worker that was started but never assigned to `session` (a throw during the probes /
    // size-cap jumps here with `session` still null) so it is torn down instead of leaking.
    if (!session && sessionPromise) {
      session = await sessionPromise.catch(() => null);
    }
    if (session) {
      await session.cleanup(deliveredOpfs);
      session.dispose();
    }
    youtubeAborts.delete(jobId);
  }
}
