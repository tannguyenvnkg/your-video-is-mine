// Offscreen document — runs heavy work that needs DOM/WASM: mux/remux HLS with libav.js,
// fetch + decrypt segments, create blob URLs for download. MV3 service worker CANNOT do this.
//
// W3.1 — @ffmpeg/core (GPL, 32.2 MB, holds the whole video in RAM) HAS BEEN REMOVED, replaced by a
// self-built libav.js (variant `ts2mp4d`, LGPL-2.1, 1.56 MB wasm, 0 encoders) running in a Worker and
// streaming bytes through OPFS. Three reasons, in order of importance:
//   1. LEGAL: @ffmpeg/core is built with --enable-gpl so it's GPL, while the project declares MIT.
//   2. Memory: the old build kept the whole video in RAM; this one has FLAT RAM (measured up to a 1.19 GB input).
//   3. Bundle size: 34.8 MB -> ~2.4 MB.
// The muxing lives in `mux-worker.ts` (the only place with FileSystemSyncAccessHandle); the pure
// core is in `utils/remux-core.ts` + `utils/remux-time.ts` so it can be tested under node.
import {
  MuxCancelledError,
  MuxSession,
  removeOpfsFile,
  sweepOrphanOpfsFiles,
} from './libav-mux';
import type { MuxTrackSpec } from './mux-worker';
import { decryptAes128Cbc, segmentIv } from '@/utils/crypto';
import { DRM_UNSUPPORTED_ERROR } from '@/utils/drm';
import { describeError } from '@/utils/errors';
import type { HlsSegmentsResult } from '@/utils/hls';
// ⚠️ `utils/dash` only pulls in mpd-parser + types + hls + drm — NONE of it touches chrome.storage
// or declarativeNetRequest, so it's safe for offscreen (where ONLY chrome.runtime exists). Keep this
// property intact: adding a storage/dnr import into this chain is a runtime TypeError that no static
// gate catches — the exact bug that made HLS die silently in the first several commits.
import { parseTrackSegments } from '@/utils/dash';
// Safe with the "offscreen has NO chrome.storage" constraint: liveness.ts only imports TYPES from
// storage.ts (erased at compile time) so it doesn't pull in a single line of chrome.storage.
import { HEARTBEAT_INTERVAL_MS } from '@/utils/liveness';
import {
  CancelledError,
  FatalFetchError,
  fetchWithRetry,
  timeoutSignal,
} from '@/utils/retry';
import {
  CHUNK_THRESHOLD_BYTES,
  DEFAULT_CHUNK_BYTES,
  MAX_PROGRESSIVE_BYTES,
  parseContentRangeTotal,
  planRangeChunks,
  tooLargeMessage,
} from '@/utils/progressive';
import type { DownloadEntry, HlsJob } from '@/utils/storage';
import type {
  EngineSelfTestResponse,
  OffscreenRequest,
} from '@/utils/messages';

// FOUNDATIONAL CONSTRAINT (measured, not guessed): the offscreen document is granted ONLY
// `chrome.runtime` — `chrome.storage` is UNDEFINED here (`Object.keys(chrome)` = loadTimes,csi,runtime).
// => ABSOLUTELY do not import any storage read/write function into this file: it throws a runtime
// TypeError that no static gate (tsc/eslint/vitest) catches. All state goes through background via
// runtime messages.
//
// MUST NOT THROW OUTWARD (W0.1): this function is called at ~every step of a job that can run 30
// minutes, including inside the `catch` block that reports errors at the end of runHlsJob. If it
// throws: (1) a transient messaging hiccup kills the whole job, and (2) the catch block itself
// throwing -> THE ORIGINAL ERROR IS ERASED, leaving the user with a hung job and no explanation.
// Swallowing errors here is INTENTIONAL — but not silent: it must still be logged.
async function updateHlsJob(
  jobId: string,
  patch: Partial<HlsJob>,
): Promise<void> {
  try {
    await browser.runtime.sendMessage({ kind: 'hls/progress', jobId, patch });
  } catch (e) {
    console.warn(
      '[offscreen] không gửi được tiến trình về background:',
      describeError(e),
    );
  }
}

// Queue HLS jobs SEQUENTIALLY: only 1 ffmpeg instance -> DO NOT run 2 jobs concurrently
// (avoid filename collisions in the shared virtual FS).
let jobChain: Promise<void> = Promise.resolve();

// W2.6 — one AbortController per job. BEFORE W2.6 this was a `Set<string>` cancel-flag, but a flag
// can only be read BETWEEN steps: a worker stuck inside `await fetch` never sees it, so "Cancel"
// couldn't yank an in-flight request -> popup reports cancelled while the network keeps running.
// A controller aborts the request directly.
const jobAborts = new Map<string, AbortController>();

// Last-reported mux percentage — throttled in 1% steps to avoid spamming storage.
// (Jobs run SEQUENTIALLY so there's only 1 mux at a time; no need to key by jobId.)
let lastMuxPct = -1;

// blob URLs currently held (revoked once background reports the download finished, or after a
// fallback timeout).
const activeBlobUrls = new Set<string>();
const BLOB_TTL_MS = 10 * 60 * 1000;

/**
 * blob URL -> the OPFS filename backing it.
 *
 * 🔴 DO NOT delete the OPFS file right after sending `download/blob`: background handles that
 * message fire-and-forget (`background.ts:405-416` returns `undefined`, no ACK), so offscreen has
 * NO WAY to know whether `chrome.downloads.download()` has actually been called yet. MEASURED: it's
 * absolutely safe to delete AFTER `download()` returns an id (the download completes with full bytes
 * even if the file is deleted, offscreen is killed, or the whole extension is reloaded mid-flight) —
 * but "after it returns an id" is a milestone only background can see. So instead hook into a signal
 * that already exists in the protocol: background sends `revoke` when the download finishes. Plus a
 * TTL deadline and a startup sweep so a file can never leak forever.
 */
const opfsByBlobUrl = new Map<string, string>();

// W2.5 — AbortController for each in-flight progressive fetch (cancel = .abort() yanks the request immediately).
const progressiveAborts = new Map<string, AbortController>();

// Playlist fetch timeout cap (a manifest is only a few KB -> 30s is generously wide).
const PLAYLIST_TIMEOUT_MS = 30_000;

/**
 * Self-test the mux engine.
 *
 * Runs the EXACT real path: load libav in a Worker, append one real MPEG-TS segment (18 KB,
 * bundled) into OPFS, mux to mp4, read back the size. Not just "wasm loaded" — it goes through
 * the full demux -> timestamp fixup -> muxer -> writer device -> OPFS pipeline.
 *
 * The old ffmpeg build made its test video with `-f lavfi testsrc`, i.e. using an ENCODER. This
 * libav.js build DELIBERATELY has no encoder at all (that's why it's only 1.56 MB and avoids GPL),
 * so the test had to switch to remux instead — and remux is actually what the extension does for real.
 */
async function runEngineSelfTest(): Promise<EngineSelfTestResponse> {
  let session: MuxSession | null = null;
  try {
    session = await MuxSession.start('selftest');
    // ⚠️ `.bin` extension, NOT `.ts`: this is MPEG-TS, but `tsc` sees a `.ts` extension and treats
    // it as TypeScript, breaking `pnpm compile` immediately ("File appears to be binary").
    const res = await fetch(browser.runtime.getURL('/libav/selftest.bin'));
    if (!res.ok)
      throw new Error(`Không đọc được tệp thử (HTTP ${res.status}).`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await session.appendSegment('', bytes);
    const outcome = await session.mux(
      [{ prefix: '', kind: 'any', adtsToAsc: true }],
      () => undefined,
    );
    if (outcome.outBytes <= 0) throw new Error('Ghép ra tệp rỗng.');
    return { ok: true, size: outcome.outBytes };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  } finally {
    if (session) {
      await session.cleanup(null);
      session.dispose();
    }
  }
}

// --- G5: download & mux HLS (runs sequentially through jobChain) ---
//
// Speed optimization (v0.5.0): separate FETCH (network, parallel) from WRITE (virtual FS, needs
// ffmpeg) to overlap segment downloading with loading ffmpeg.wasm. Prefetch has a RAM CAP
// (MAX_BUFFERED) so it doesn't hold the whole video in memory.

/** Download + parse a media playlist. Throws a CLEAR error instead of letting an error page's body (403/404) leak into the parser. */
/**
 * Downloads the RAW TEXT of a manifest (m3u8 or mpd) with a timeout + status check.
 *
 * Split out of `loadPlaylist` for W1.5: DASH needs that exact text to parse MULTIPLE tracks (video +
 * audio share one .mpd), so the "download" part must be reusable without the "parse" part attached.
 */
async function loadPlaylistText(
  url: string,
  label: string,
  jobSignal?: AbortSignal,
): Promise<string> {
  let text: string;
  // W2.6: chain the timeout with the job's cancel signal -> pressing Cancel while a playlist is
  // downloading aborts immediately too (previously there was only the timeout: cancel had to wait
  // the full 30s to take effect).
  const { signal, dispose } = timeoutSignal(PLAYLIST_TIMEOUT_MS, jobSignal);
  try {
    // Playlist download MUST have a timeout + status check. Without a timeout, one hung request =
    // the job hangs FOREVER at 'loading', no error, no way to tell.
    const res = await fetch(url, {
      credentials: 'include',
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    // Cancellation is NOT a download error: wrapping it as "Failed to download playlist" would
    // show the user a red error message when what actually happened is they pressed Cancel.
    if (jobSignal?.aborted) throw new CancelledError('Đã huỷ');
    throw new Error(`Không tải được playlist ${label}: ${describeError(e)}`, {
      cause: e,
    });
  } finally {
    dispose();
  }
  return text;
}

/** Downloads + parses a media playlist in its EXACT format. */
async function loadPlaylist(
  url: string,
  label: string,
  jobSignal?: AbortSignal,
  mediaType?: 'hls' | 'dash',
  trackId?: string,
): Promise<HlsSegmentsResult> {
  const text = await loadPlaylistText(url, label, jobSignal);
  return parseTrackSegments(text, url, mediaType, trackId);
}

/** Result of downloading a track: how many segments and how many bytes were appended to the OPFS file. */
interface TrackBytes {
  segments: number;
  /** Bytes AFTER decryption — the exact byte count on disk. */
  bytes: number;
}

/**
 * Downloads every segment of ONE playlist into ffmpeg's virtual FS.
 *
 * W1.1 split this function out of runHlsJob so it's reusable for a separate AUDIO stream: video
 * and audio are two independent playlists, each with its own #EXT-X-KEY, #EXT-X-MAP and SEGMENT
 * COUNT (measured on a real fixture: 10 video segments, 11 audio) -> any assumption "both sides are
 * the same" is wrong.
 *
 * `prefix` separates the OPFS filename namespace between the two tracks (`ymv-<job>-v.bin` vs `ymv-<job>-a.bin`).
 *
 * W3.1: bytes NO LONGER go into ffmpeg's virtual FS, instead they're appended straight into ONE
 * OPFS file per track, through the Worker. This is exactly where the RAM cap got removed: previously
 * every segment existed twice (the buffer just fetched + a copy in MEMFS), now it goes straight from
 * network to disk.
 */
async function downloadTrack(o: {
  session: MuxSession;
  parsed: HlsSegmentsResult;
  prefix: string;
  concurrency: number;
  throwIfCancelled: () => void;
  /** W2.6 — the JOB's cancel signal: abort yanks every in-flight request immediately, without waiting for the loop. */
  signal: AbortSignal;
  /** Reports 1 segment just fetched (raw bytes, before decryption) -> combined progress across every track. */
  onSegment: (bytes: number) => Promise<void>;
  /** W2.6 — report "retrying" so the popup doesn't sit silently frozen for a whole minute. */
  onRetry?: (info: { attempt: number; total: number; reason: string }) => void;
}): Promise<TrackBytes> {
  const { session, parsed, prefix, concurrency, throwIfCancelled, signal } = o;
  const total = parsed.segments.length;

  // ⚠️ SEPARATE AES key cache per track: the audio rendition often has its own #EXT-X-KEY; sharing
  // the cache by URI would still be correct, but keeping it separate means there's no way for keys
  // to cross between the two playlists.
  //
  // 🔴 Cache the PROMISE, not the RESULT (measured 2026-07-19): the download loop calls `getKey` from
  // multiple segments IN PARALLEL, so a cache-the-result version lets every caller miss the cache and
  // fetch at the same time — measured for real on a 10-segment fixture: **3-5 key downloads for 1-2
  // actual keys**, and the number even varied between runs. In production that's N wasted requests
  // against the exact endpoint CDNs tend to rate-limit. Caching the promise means later callers latch
  // onto the first one -> exactly 1 request per URI, and that count is DETERMINISTIC, which is what
  // lets the e2e case pin down "key rotation must fetch EXACTLY 2 keys".
  const keyCache = new Map<string, Promise<ArrayBuffer>>();
  const getKey = (keyUri: string): Promise<ArrayBuffer> => {
    const cached = keyCache.get(keyUri);
    if (cached) return cached;
    const p = fetchWithRetry(keyUri, {
      signal,
      label: 'khoá giải mã (AES-128)',
      onRetry: o.onRetry,
    }).catch((e: unknown) => {
      // On failure, REMOVE from cache so a later attempt can retry — BUT ONLY for errors worth retrying.
      //
      // 🔴 For 401/403/404/410 (`FatalFetchError`) it must NOT be removed: `fetchWithRetry` deliberately
      // does not retry those codes, yet up to 6 parallel fetch workers all call `getKey` once their own
      // segment comes back. Clearing the cache means every worker fires one more request at the exact
      // key endpoint that just refused outright -> up to 6 hits, exactly the kind of thing that escalates
      // risk from soft throttling to a hard IP block (see the isFatalHttpStatus comment in utils/retry.ts).
      // Same for job cancellation (`CancelledError`): there's no later caller left to serve.
      if (!(e instanceof FatalFetchError) && !(e instanceof CancelledError)) {
        keyCache.delete(keyUri);
      }
      throw e;
    });
    keyCache.set(keyUri, p);
    return p;
  };

  /**
   * Decrypts a segment, and MOST IMPORTANTLY: turns a WebCrypto error into a human-readable message.
   *
   * 🔴 MEASURED on the build prior to this fix (2026-07-19, e2e `aes128-bad-key`): a wrong key ->
   * WebCrypto throws `DOMException(OperationError)` whose **`message` is EMPTY** -> the job ends
   * with `error: ""` -> the popup shows an EMPTY red line. If the returned key isn't 16 bytes (the
   * CDN redirecting to a login page — very common) you get the English string
   * `"AES key data must be 128 or 256 bits"`, which is just as meaningless to the user. Both are
   * silent failures: indistinguishable from a dropped connection.
   */
  const decryptSegment = async (
    data: ArrayBuffer,
    keyBytes: ArrayBuffer,
    iv: Uint8Array<ArrayBuffer>,
    label: string,
  ): Promise<ArrayBuffer> => {
    // Check length FIRST: this is the "server returned HTML instead of a key" case, and spelling
    // that out directly is far more useful than letting importKey throw an English message about bit counts.
    if (keyBytes.byteLength !== 16) {
      throw new Error(
        `Khoá giải mã AES-128 không hợp lệ: nhận ${keyBytes.byteLength} byte thay vì 16. ` +
          'Máy chủ có thể đã trả về trang đăng nhập/thông báo lỗi thay cho khoá.',
      );
    }
    try {
      return await decryptAes128Cbc(data, keyBytes, iv);
    } catch (e) {
      // DO NOT forward e.message: it's empty in exactly the most common case (wrong key).
      const raw = e instanceof Error ? e.message.trim() : '';
      throw new Error(
        `Giải mã AES-128 thất bại ở ${label} — khoá không khớp với dữ liệu. ` +
          'Khoá có thể đã hết hạn hoặc máy chủ phát nhầm khoá.' +
          (raw ? ` (${raw})` : ''),
        { cause: e },
      );
    }
  };

  const fetchSegmentBytes = async (i: number): Promise<Uint8Array> => {
    throwIfCancelled();
    const seg = parsed.segments[i]!;
    // Safety: a mid-stream segment using a different encryption than AES-128 (mixed method) -> STOP.
    const method = seg.keyMethod;
    if (method && method !== 'NONE' && method !== 'AES-128') {
      throw new Error(`Segment dùng mã hoá không hỗ trợ: ${method}`);
    }
    // 🔴 Declares AES-128 but has NO key address (`#EXT-X-KEY` missing URI, or an empty URI turned
    // into undefined by `utils/hls.ts`): the decryption branch below is gated on `&& seg.keyUri`,
    // so it would SILENTLY SKIP decryption and write the ciphertext straight to OPFS. The result is
    // a garbage file, or a confusing demux error that wrongly blames the muxing stage. Throw here so
    // the error names the real cause.
    if (method === 'AES-128' && !seg.keyUri) {
      throw new Error(
        'Segment khai mã hoá AES-128 nhưng playlist không cho biết địa chỉ khoá ' +
          '(#EXT-X-KEY thiếu URI).',
      );
    }
    // W1.3: has a byterange -> pull only this segment's exact slice, NOT the whole file.
    let buf = await fetchWithRetry(seg.uri, {
      signal,
      label: `${prefix === 'a' ? 'segment tiếng' : 'segment'} #${i + 1}/${total}`,
      onRetry: o.onRetry,
      ...(seg.byterange ? { range: seg.byterange } : {}),
    });
    const raw = buf.byteLength;
    if (method === 'AES-128' && seg.keyUri) {
      const key = await getKey(seg.keyUri);
      const iv = segmentIv(seg);
      buf = await decryptSegment(
        buf,
        key,
        iv,
        `${prefix === 'a' ? 'segment tiếng' : 'segment'} #${i + 1}/${total}`,
      );
    }
    await o.onSegment(raw);
    return new Uint8Array(buf);
  };

  // Download the init segment (fMP4) IN PARALLEL with the prefetch below.
  // W1.3: the init segment can also be a SLICE of a larger file (#EXT-X-MAP:BYTERANGE) — Apple fMP4
  // puts init in the FIRST 719 bytes of the very same 27MB file that holds every segment. Ignoring
  // the byterange here means loading 27MB of garbage bytes as the "header" -> ffmpeg "error reading header".
  const firstInitSeg = parsed.segments.find((s) => s.initUri);
  const initPromise: Promise<Uint8Array | null> = firstInitSeg?.initUri
    ? fetchWithRetry(firstInitSeg.initUri, {
        signal,
        label: 'phần đầu tệp (init)',
        onRetry: o.onRetry,
        ...(firstInitSeg.initByterange
          ? { range: firstInitSeg.initByterange }
          : {}),
      }).then((b) => new Uint8Array(b))
    : Promise.resolve(null);

  // Prefetch has a RAM CAP: at most MAX_BUFFERED not-yet-written segments held in memory (backpressure).
  const MAX_BUFFERED = Math.min(2 * concurrency, 12);
  const names = new Array<string>(total);
  const buffers = new Array<Uint8Array | undefined>(total);
  let nextFetch = 0; // index of the next segment to fetch
  let nextWrite = 0; // index of the next segment to write to FS
  let failed: unknown = null;

  let writtenBytes = 0;
  // init MUST sit at the START of the file, before segment 0 — it's the header for the whole track.
  let initBytes = await initPromise;
  // 🔴 RFC 8216 §4.3.2.5: an AES-128 key applies to EVERY Media Segment **AND** to any Media
  // Initialization Section declared by #EXT-X-MAP that falls within that #EXT-X-KEY's scope (and
  // that is exactly why the spec REQUIRES an explicit IV for this case). Before this fix, init was
  // written STRAIGHT without decryption -> ciphertext ended up right where `ftyp`/`moov` should be,
  // i.e. the very FIRST bytes of the file, while every segment after it was correct -> libav couldn't
  // recognize the format and the job died with a message that wrongly blamed the MUX stage.
  //
  // 🔴 BUT KEY SCOPE FOLLOWS TAG POSITION, NOT SEGMENT (bug caught by adversarial review, 2026-07-20).
  // Using `firstInitSeg.keyMethod/keyUri` (the SEGMENT's key) is WRONG: a playlist that declares
  // `#EXT-X-MAP` BEFORE `#EXT-X-KEY` has a CLEAR init — a valid and common shape, since a clear init
  // lets the player read the codec before going to fetch a key. The old build decrypted that init
  // anyway -> WebCrypto threw a padding error -> **a healthy stream got killed for no reason**, with a
  // message wrongly blaming the server for sending the wrong key. Now it reads init's OWN key
  // (`initKeyMethod/initKeyUri/initIv`, taken from `segment.map.key` — verified that m3u8-parser
  // models the scope correctly). The `fmp4-clear-init` case pins this direction, `fmp4-aes-init` pins
  // the other. **Never infer the init key from the segment key again.**
  const initMethod = firstInitSeg?.initKeyMethod;
  if (initMethod && initMethod !== 'NONE' && initMethod !== 'AES-128') {
    throw new Error(`Init segment dùng mã hoá không hỗ trợ: ${initMethod}`);
  }
  // AES-128 declared for init but missing key URI: throw instead of silently writing ciphertext as the header.
  if (initMethod === 'AES-128' && !firstInitSeg?.initKeyUri) {
    throw new Error(
      'Phần đầu tệp (init) khai mã hoá AES-128 nhưng playlist không cho biết địa chỉ khoá ' +
        '(#EXT-X-KEY thiếu URI).',
    );
  }
  if (initBytes && initMethod === 'AES-128' && firstInitSeg?.initKeyUri) {
    const key = await getKey(firstInitSeg.initKeyUri);
    const iv = segmentIv({
      seq: firstInitSeg.seq,
      ...(firstInitSeg.initIv ? { iv: firstInitSeg.initIv } : {}),
    });
    initBytes = new Uint8Array(
      await decryptSegment(
        initBytes.buffer as ArrayBuffer,
        key,
        iv,
        'phần đầu tệp (init)',
      ),
    );
  }
  if (initBytes) {
    writtenBytes += initBytes.byteLength;
    await session.appendSegment(prefix, initBytes);
  }

  // Writer loop: appends sequentially in index order to free up RAM early.
  //
  // MUST "claim" the index (nextWrite++) BEFORE the await. writeReady() is called from MULTIPLE
  // parallel fetch workers; incrementing after the await means worker B reads back the exact
  // nextWrite that worker A is still in the middle of writing -> double-writing the same buffer.
  // And `appendSegment` TRANSFERS (detaches) the ArrayBuffer to the Worker — exactly like the old
  // `ffmpeg.writeFile` — so the second write blows up with "ArrayBuffer is detached".
  // W3.1's NEW constraint: index order is also BYTE order on disk, so this loop is also what keeps
  // segments concatenated in correct playback order.
  const writeReady = async (): Promise<void> => {
    while (nextWrite < total && buffers[nextWrite] !== undefined) {
      throwIfCancelled();
      const i = nextWrite;
      nextWrite++;
      const bytes = buffers[i]!;
      buffers[i] = undefined; // release the reference immediately: the buffer is about to be transferred to the Worker
      writtenBytes += bytes.byteLength;
      await session.appendSegment(prefix, bytes);
      names[i] = 'ok';
    }
  };

  // Fetch worker with backpressure: stops picking up new segments once the buffer is full.
  const worker = async (): Promise<void> => {
    while (failed === null) {
      if (nextFetch - nextWrite >= MAX_BUFFERED) {
        await writeReady();
        if (nextFetch - nextWrite >= MAX_BUFFERED) {
          await new Promise((r) => setTimeout(r, 5));
          continue;
        }
      }
      const i = nextFetch;
      if (i >= total) return;
      nextFetch++;
      try {
        buffers[i] = await fetchSegmentBytes(i);
        await writeReady();
      } catch (e) {
        failed = e;
        return;
      }
    }
  };

  // W2.6 — CAP OF 6 workers: Chrome opens at most 6 concurrent connections to ONE host; the 7th
  // request onward sits QUEUED in the pool. And our wait-for-headers clock starts counting from the
  // moment fetch is CALLED, so queued time gets wrongly counted -> slow network + high concurrency
  // (up to 16 allowed) = segments get killed even though the server is perfectly healthy. Above 6
  // is ALSO not actually faster (Chrome still queues), so this cap costs no speed, it only removes
  // the invisible wait.
  const MAX_INFLIGHT_PER_HOST = 6;
  const workerCount = Math.min(
    Math.max(1, concurrency),
    total,
    MAX_INFLIGHT_PER_HOST,
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failed !== null) throw failed;
  await writeReady(); // write out anything left over
  throwIfCancelled();

  // W1.2: throw LOUDLY instead of muxing a list with a hole in it. `names.join('|')` renders an
  // empty slot as an empty string -> `concat:a.ts||c.ts` -> ffmpeg swallows the gap and produces a
  // file MISSING A CHUNK without reporting anything. That silent swallowing is exactly what turns a
  // race-condition bug from "crash" into "corrupted file" — far worse.
  const missing = names.findIndex((n) => n === undefined);
  if (nextWrite !== total || missing >= 0) {
    throw new Error(
      `Thiếu segment sau khi tải (đã ghi ${nextWrite}/${total}` +
        `${missing >= 0 ? `, hổng ở #${missing}` : ''}) — không ghép để tránh ra file hỏng.`,
    );
  }

  return { segments: total, bytes: writtenBytes };
}

async function runHlsJob(
  req: Extract<OffscreenRequest, { kind: 'hls/run' }>,
): Promise<void> {
  const {
    jobId,
    variantUrl,
    audioUrl,
    filename,
    mediaUrl,
    tabId,
    spoofRuleIds,
  } = req;
  // W2.6 — this job's controller. `hls/cancel` calls .abort() -> in-flight requests break NOW, and
  // `abortableSleep` inside the backoff also wakes up immediately instead of sitting out the full 8 seconds.
  // Cancellation can arrive BEFORE the job leaves the queue (jobs are queued sequentially): keep any
  // controller that already exists.
  const ac = jobAborts.get(jobId) ?? new AbortController();
  jobAborts.set(jobId, ac);
  const throwIfCancelled = () => {
    if (ac.signal.aborted) throw new CancelledError('Đã huỷ');
  };

  let session: MuxSession | null = null;
  let deliveredOpfs: string | null = null;

  try {
    throwIfCancelled();
    await updateHlsJob(jobId, { phase: 'loading' });

    // Spin up the Worker + load libav IN PARALLEL with downloading the playlist (don't await yet).
    // `jobKey` keeps every OPFS file of this job from COLLIDING with other jobs: MEASURED that OPFS
    // files survive killing offscreen, reloading the extension, and even restarting the browser, so
    // a fixed name like `in.ts`/`out.mp4` would let a later job silently reuse a previous job's leftovers.
    const jobKey = jobId.replace(/[^a-zA-Z0-9_-]/g, '');
    const sessionPromise = MuxSession.start(jobKey);

    // W1.1: download the video playlist and the audio playlist IN PARALLEL (if the master declares audio separately).
    // W1.5 — DASH keeps BOTH video and audio in ONE .mpd file: download it once, then parse two
    // tracks by id. Calling loadPlaylist twice here would download the whole manifest twice and,
    // worse, there'd be no way to tell tracks apart since every representation's `resolvedUri` is
    // the same .mpd file.
    const mediaType = req.mediaType;
    let parsed: HlsSegmentsResult;
    let parsedAudio: HlsSegmentsResult | null = null;
    if (mediaType === 'dash') {
      const mpdText = await loadPlaylistText(variantUrl, 'DASH', ac.signal);
      parsed = parseTrackSegments(mpdText, variantUrl, 'dash', req.variantId);
      parsedAudio = req.audioId
        ? parseTrackSegments(mpdText, variantUrl, 'dash', req.audioId)
        : null;
    } else {
      [parsed, parsedAudio] = await Promise.all([
        loadPlaylist(variantUrl, 'hình', ac.signal),
        audioUrl
          ? loadPlaylist(audioUrl, 'tiếng', ac.signal)
          : Promise.resolve(null),
      ]);
    }

    // Hard boundary: SAMPLE-AES/EME -> STOP. Must check BOTH playlists: audio can be protected
    // while video is not.
    if (parsed.isProtected || parsedAudio?.isProtected) {
      await updateHlsJob(jobId, {
        phase: 'error',
        error: DRM_UNSUPPORTED_ERROR(parsed.drmName ?? parsedAudio?.drmName),
      });
      return;
    }
    // W1.5 — cases we CAN parse but DELIBERATELY refuse to mux (e.g. multi-Period DASH, each
    // Period with a different init): muxing blindly would still be accepted by ffmpeg, the job
    // would still report "done", but the file would be corrupted. State the reason plainly instead.
    const refuse = parsed.unsupportedReason ?? parsedAudio?.unsupportedReason;
    if (refuse) {
      await updateHlsJob(jobId, { phase: 'error', error: refuse });
      return;
    }
    if (parsed.segments.length === 0) {
      await updateHlsJob(jobId, {
        phase: 'error',
        error: 'Playlist không có segment nào.',
      });
      return;
    }
    // An empty audio playlist = muxes to a SILENT file. Better to report an error than silently
    // hand over a broken file — that's exactly the §2.1 disease W1.1 was created to cure.
    if (parsedAudio && parsedAudio.segments.length === 0) {
      await updateHlsJob(jobId, {
        phase: 'error',
        error: 'Playlist tiếng không có segment nào.',
      });
      return;
    }

    const concurrency = req.concurrency;
    const total = parsed.segments.length + (parsedAudio?.segments.length ?? 0);

    // Enter 'fetching' RIGHT AWAY (even while ffmpeg is still loading) -> NO "dead" gap left.
    await updateHlsJob(jobId, {
      phase: 'fetching',
      segmentsTotal: total,
      segmentsDone: 0,
      bytesDownloaded: 0,
      startedAt: Date.now(),
    });

    // Progress COMBINED across every track: the user only cares "how much is left", not video vs audio.
    let done = 0;
    let bytesDownloaded = 0;
    const step = Math.max(1, Math.floor(total / 33));
    const onSegment = async (bytes: number): Promise<void> => {
      bytesDownloaded += bytes;
      done++;
      if (done % step === 0 || done === total) {
        await updateHlsJob(jobId, { segmentsDone: done, bytesDownloaded });
      }
    };

    session = await sessionPromise; // wait for the Worker to be ready before writing any bytes
    const activeSession = session;
    // Pressing Cancel WHILE MUXING: signal the Worker directly so it stops at the next packet batch.
    // Very different from the old ffmpeg build — ffmpeg.wasm's `exec` COULD NOT be interrupted,
    // cancel only took effect after muxing finished. MEASURED: postMessage reaches a Worker mid-mux
    // within ~5ms.
    ac.signal.addEventListener('abort', () => void activeSession.cancel(), {
      once: true,
    });

    const shared = {
      session: activeSession,
      concurrency,
      throwIfCancelled,
      signal: ac.signal,
      onSegment,
      // No await: this is only a display note, must not block the download loop.
      onRetry: (info: { attempt: number; total: number; reason: string }) => {
        void updateHlsJob(jobId, {
          note: `Mạng trục trặc (${info.reason}) — đang thử lại lần ${info.attempt}/${info.total}…`,
        });
      },
    };
    // Video then audio, sequentially: reuses the exact download loop already proven to work, and
    // audio is a dozen times lighter than video so the added time is negligible.
    const video = await downloadTrack({
      ...shared,
      parsed,
      prefix: parsedAudio ? 'v' : '',
    });
    const audio = parsedAudio
      ? await downloadTrack({ ...shared, parsed: parsedAudio, prefix: 'a' })
      : null;

    // Final gate before muxing: a zero-byte track guarantees a corrupted file. The old ffmpeg build
    // detected gaps via an `undefined` slot in the filename array; once bytes are appended into one
    // file, that trace disappears, so bytes must be counted instead. (The Worker also cross-checks
    // once more with `getSize()` on disk.)
    if (video.bytes === 0 || (audio !== null && audio.bytes === 0)) {
      throw new Error(
        `Tải về 0 byte (hình ${video.bytes}, tiếng ${audio?.bytes ?? 0}) — không ghép để tránh ra file hỏng.`,
      );
    }

    // Mux with libav.js inside the Worker: reads straight from OPFS, writes straight to OPFS.
    // Clear the "retrying" note: the download stage is done, leaving it would make the user think
    // there's still a network problem.
    await updateHlsJob(jobId, { phase: 'muxing', muxProgress: 0, note: '' });
    const tracks: MuxTrackSpec[] = audio
      ? [
          { prefix: 'v', kind: 'video', adtsToAsc: !parsed.hasInit },
          {
            prefix: 'a',
            kind: 'audio',
            adtsToAsc: !(parsedAudio?.hasInit ?? false),
          },
        ]
      : [{ prefix: '', kind: 'any', adtsToAsc: !parsed.hasInit }];

    lastMuxPct = -1;
    const outcome = await activeSession.mux(tracks, (fraction) => {
      const pct = Math.floor(fraction * 100);
      if (pct === lastMuxPct) return;
      lastMuxPct = pct;
      void updateHlsJob(jobId, { muxProgress: fraction });
    });
    if (!outcome.moovAtFront) {
      // Not an error: the file is still correct, it's just that moov ends up at the tail so
      // streaming over the network requires downloading everything before playback can start. Log
      // it so we still know the fallback path was taken.
      console.warn('[offscreen] phải lùi về moov ở cuối file cho job', jobId);
    }

    await updateHlsJob(jobId, { phase: 'saving' });

    // If the user cancelled while muxing/saving -> STOP, don't hand off the file for download
    // (avoid a "fake completion").
    throwIfCancelled();

    // 🔬 MEASURED (Edge 150, real extension, a 1.2 GB file): `getFile()` 0.0 ms +
    // `createObjectURL()` 0.1 ms, FLAT RSS, unchanged JS heap -> this blob is a REFERENCE to the
    // file on disk, NOT a copy in RAM. If it loaded everything into RAM the whole W3.1 OPFS
    // architecture would be pointless; so this figure is what needs to be re-measured if Chrome
    // ever changes this behavior.
    const outFile = await MuxSession.openOutput(outcome.outName);
    const blobUrl = URL.createObjectURL(outFile);
    activeBlobUrls.add(blobUrl);
    opfsByBlobUrl.set(blobUrl, outcome.outName);
    deliveredOpfs = outcome.outName;
    // Anti-leak fallback: auto-revoke after the TTL if background never reports revoke.
    setTimeout(() => revokeBlob(blobUrl), BLOB_TTL_MS);
    await browser.runtime.sendMessage({
      kind: 'download/blob',
      blobUrl,
      filename,
      mediaUrl,
      tabId,
      jobId,
      spoofRuleIds,
    });
    await updateHlsJob(jobId, {
      phase: 'done',
      segmentsDone: total,
    });
  } catch (e) {
    // The Worker reports cancellation with its own error class -> normalize both into one 'cancelled' branch.
    if (e instanceof CancelledError || e instanceof MuxCancelledError) {
      await updateHlsJob(jobId, { phase: 'cancelled', error: 'Đã huỷ' });
    } else {
      await updateHlsJob(jobId, { phase: 'error', error: describeError(e) });
    }
  } finally {
    // Clean up the OPFS file regardless of success/error/cancel. KEEP the result file if it has
    // already been handed off to background (a blob URL points at it) — it gets deleted on
    // `revoke` or once the TTL expires.
    if (session) {
      await session.cleanup(deliveredOpfs);
      session.dispose();
    }
    jobAborts.delete(jobId);
  }
}

function enqueueHlsJob(
  req: Extract<OffscreenRequest, { kind: 'hls/run' }>,
): void {
  // W2.7 — HEARTBEAT. Offscreen can be killed by Chrome at any moment (Task Manager, OOM, crash)
  // and it dies SILENTLY: no event reaches background, the job sits at 'fetching' forever.
  // This heartbeat is the only LIVE proof. An EMPTY patch is intentional — background only needs to
  // know "still there", it stamps `lastSeenAt` itself with its own clock.
  //
  // 🔴 TICKS FROM THE MOMENT IT'S QUEUED, NOT FROM WHEN IT RUNS — measured with e2e
  // `queued-not-reaped`: jobs run SEQUENTIALLY (only 1 ffmpeg instance), so job #2 sits idle in the
  // queue for the whole time job #1 is downloading. Placing the heartbeat inside `runHlsJob` would
  // leave job #2 silent for >60s and get **WRONGLY KILLED after 61.2s** by the W2.7 tick even though
  // offscreen is perfectly healthy. Killing a healthy download is WORSE than the hang W2.7 exists to
  // cure — exactly the "cap on total elapsed time" trap that W2.5/W2.6 already paid for twice.
  // Don't move this inside.
  const heartbeat = setInterval(() => {
    void updateHlsJob(req.jobId, {});
  }, HEARTBEAT_INTERVAL_MS);
  jobChain = jobChain
    .then(() => runHlsJob(req))
    .catch(() => undefined)
    // Clean up HERE, not inside `runHlsJob`: the heartbeat is created before the job runs, so it
    // must die after the job ends. Still ticking = a wasted message every 5 seconds, and a job
    // already settled at 'error' would have its timestamp accidentally revived by the heartbeat.
    .finally(() => clearInterval(heartbeat));
}

function revokeBlob(url: string): void {
  if (activeBlobUrls.has(url)) {
    URL.revokeObjectURL(url);
    activeBlobUrls.delete(url);
  }
  // By this point the download has ended (background reported revoke) or the TTL has expired ->
  // delete the OPFS file. MEASURED: deleting the file while `chrome.downloads` is still reading it
  // STILL finishes with the full byte count (POSIX-style unlink semantics), so there's no dangerous
  // window here.
  const opfsName = opfsByBlobUrl.get(url);
  if (opfsName !== undefined) {
    opfsByBlobUrl.delete(url);
    void removeOpfsFile(opfsName);
  }
}

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

async function runProgressiveDownload(
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

function asOffscreenRequest(m: unknown): OffscreenRequest | null {
  if (
    typeof m === 'object' &&
    m !== null &&
    (m as { target?: unknown }).target === 'offscreen'
  ) {
    return m as OffscreenRequest;
  }
  return null;
}

// Same contract as background (see the comment in entrypoints/background.ts): return `true`
// SYNCHRONOUSLY for the async branch, do NOT return a Promise. A message that isn't for offscreen
// -> return `undefined` so it does NOT hijack background's response channel.
browser.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender: unknown,
    sendResponse: (response?: unknown) => void,
  ): true | undefined => {
    const req = asOffscreenRequest(message);
    if (!req) return undefined;
    switch (req.kind) {
      case 'engine/selftest':
        void runEngineSelfTest()
          .then(
            (res: EngineSelfTestResponse) => sendResponse(res),
            (e: unknown) =>
              sendResponse({ ok: false, error: describeError(e) }),
          )
          .catch(() => undefined);
        return true;
      case 'hls/run':
        enqueueHlsJob(req);
        return undefined;
      case 'hls/cancel':
        // Cancellation can arrive BEFORE the job leaves the queue (jobChain is sequential) -> create
        // a controller that's already aborted so runHlsJob picks it up and exits immediately, rather
        // than finishing the download and only then discovering it was cancelled.
        {
          const existing = jobAborts.get(req.jobId);
          if (existing) existing.abort();
          else {
            const pre = new AbortController();
            pre.abort();
            jobAborts.set(req.jobId, pre);
            // Cancelling a job that's already finished (or never existed) would leave this entry
            // FOREVER — offscreen is a persistent page so the Map would just keep growing. Schedule
            // a cleanup: if the job was real, it already picked up the controller and runHlsJob
            // deletes it itself in `finally`, so deleting again here is harmless.
            setTimeout(() => {
              if (jobAborts.get(req.jobId) === pre) jobAborts.delete(req.jobId);
            }, 60_000);
          }
        }
        return undefined;
      case 'revoke':
        revokeBlob(req.url);
        return undefined;
      case 'download/run':
        // Progressive does NOT use ffmpeg/the virtual FS -> runs INDEPENDENTLY of jobChain (no need
        // to be sequential like HLS). runProgressiveDownload catches its own errors and reports them
        // to background, so this only needs to swallow the leftover rejection.
        void runProgressiveDownload(req).catch((e: unknown) =>
          console.warn(
            '[offscreen] tải progressive lỗi ngoài dự kiến:',
            describeError(e),
          ),
        );
        return undefined;
      case 'download/abort':
        progressiveAborts.get(req.key)?.abort();
        return undefined;
    }
  },
);

// W3.1 — sweeps orphaned OPFS files left by dead jobs (offscreen killed mid-flight, browser closed
// abruptly). MEASURED: OPFS files survive closeDocument, extension reload, and even a browser
// restart — nobody cleans them up automatically. Runs right when offscreen is set up: at that
// moment no job can possibly be running yet, so it can never accidentally delete a file still in use.
void sweepOrphanOpfsFiles()
  .then((n) => {
    if (n > 0) console.log('[offscreen] đã dọn', n, 'tệp tạm mồ côi');
  })
  .catch(() => undefined);

// W3.1 — engine prewarming is NO LONGER done here. The old ffmpeg build had to preload 32 MB of
// wasm since loading it took several seconds; libav.js is only 1.56 MB and its Worker is spun up
// IMMEDIATELY when a job starts, in parallel with downloading the playlist (`MuxSession.start` is
// called before the first `await` in runHlsJob), so the dead time is already covered without
// having to keep wasm alive for the whole session.
