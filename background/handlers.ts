import {
  applySpoof,
  removeSpoofRules,
  capturedContextOf,
  MAX_SPOOF_HOSTS,
} from '@/background/spoof';
import { withSpoofedFetch, pageUrlFor, capturedFor } from '@/background/net';
import {
  ensureOffscreen,
  sendToOffscreen,
} from '@/background/offscreen-bridge';
import { resolveTitle } from '@/background/title';
import {
  getTabMedia,
  getDownloadFolder,
  getFilenameTemplate,
  getConcurrency,
  allocateSpoofRuleId,
  putDownload,
  putHlsJob,
  updateDownload,
  updateHlsJob,
  getDownloads,
  getTabState,
  type DownloadState,
} from '@/utils/storage';
import { parseHlsManifest, spoofTargetsFromSegments } from '@/utils/hls';
import { parseDashManifest, parseTrackSegments } from '@/utils/dash';
import { hostFromUrl } from '@/utils/dnr';
import { buildDownloadFilename } from '@/utils/filename';
import { DRM_UNSUPPORTED_ERROR } from '@/utils/drm';
import { describeError } from '@/utils/errors';
import type {
  DownloadStartResponse,
  HlsDownloadResponse,
  HlsEstimateResponse,
  ManifestKind,
  VariantsResponse,
  YoutubeReextractRequest,
  YoutubeReextractResponse,
} from '@/utils/messages';

export async function handleVariants(
  url: string,
  mediaType: ManifestKind,
  tabId?: number,
): Promise<VariantsResponse> {
  try {
    const pageUrl = await pageUrlFor(tabId, url);
    // W2.2: spoof BEFORE fetching — a 403 must not kill the quality-selection step.
    // W2.1: replay the player's REAL headers for this exact manifest if they were captured.
    const res = await withSpoofedFetch(
      url,
      pageUrl,
      () => fetch(url, { credentials: 'include' }),
      await capturedFor(tabId, url),
    );
    if (!res.ok) return { ok: false, error: `Máy chủ trả mã ${res.status}.` };
    const text = await res.text();
    const parsed =
      mediaType === 'hls'
        ? parseHlsManifest(text, url)
        : parseDashManifest(text, url);
    if (parsed.variants.length === 0) {
      return { ok: false, error: 'Manifest không có chất lượng nào.' };
    }
    return { ok: true, isMaster: parsed.isMaster, variants: parsed.variants };
  } catch {
    return {
      ok: false,
      error: 'Không tải/parse được manifest (mạng hoặc CORS).',
    };
  }
}

export async function handleDownload(
  url: string,
  tabId: number,
): Promise<DownloadStartResponse> {
  // W7.1 — HARD BOUNDARY §7: also block the progressive path, not just HLS.
  const drmBlocked = await drmBlockReason(tabId);
  if (drmBlocked) return { ok: false, error: drmBlocked };
  // W2.5 — ROUTE THROUGH OFFSCREEN instead of calling chrome.downloads.download({url}) directly.
  // MEASURED 2026-07-18: a direct download does NOT receive the DNR modifyHeaders rule (the server
  // sees Referer:NONE -> 403 on an anti-hotlink site). offscreen's fetch() is a tab-less
  // xmlhttprequest -> MATCHES the spoof rule -> passes the 403. chrome.downloads.download now only
  // ever receives a blob: URL (VDH invariant).
  //
  // Hoisted out of the try so the catch can clean it up: the rule is applied BEFORE ensureOffscreen;
  // if it throws before putDownload, the id isn't stored anywhere -> only the cold-start sweep would
  // clean it. Remove it right away in the catch to avoid leaking it for the rest of the session.
  let ruleId: number | undefined;
  const key = crypto.randomUUID();
  try {
    const media = (await getTabMedia(tabId)).find((m) => m.url === url);
    // Spoof Referer/Origin to bypass hotlink-protection/403 (non-DRM). Own id for this download (W2.4).
    ruleId = await allocateSpoofRuleId();
    await applySpoof(ruleId, url, media?.pageUrl, capturedContextOf(media));
    const folder = await getDownloadFolder();
    const filename = buildDownloadFilename({
      url,
      // W4.3 — no longer using `media?.title`: it's almost always empty on the network detection path.
      title: await resolveTitle(tabId, media),
      height: media?.height,
      contentType: media?.contentType,
      folder,
      template: await getFilenameTemplate(),
      pageUrl: media?.pageUrl ?? media?.detectPageUrl,
    });
    // In-flight entry (FETCH phase inside offscreen) — no chromeDownloadId yet, popup shows "Downloading…".
    await putDownload({
      key,
      mediaUrl: url,
      filename,
      state: 'in_progress',
      startedAt: Date.now(),
      // W2.7 — first heartbeat: also covers the case "offscreen died before it could pick up the work".
      lastSeenAt: Date.now(),
      spoofRuleIds: [ruleId],
    });
    await ensureOffscreen();
    // Not awaited: offscreen's fetch can run long, it reports progress via download/progress. BUT the
    // send must be error-caught (offscreen hasn't registered its listener yet) -> otherwise the entry
    // stays stuck at 'in_progress' forever.
    void browser.runtime
      .sendMessage({
        target: 'offscreen',
        kind: 'download/run',
        key,
        url,
        filename,
        mediaUrl: url,
        tabId,
        spoofRuleIds: [ruleId],
      })
      .catch(async (e: unknown) => {
        if (ruleId !== undefined) await removeSpoofRules([ruleId]);
        await updateDownload(key, {
          state: 'interrupted',
          error: `Không gửi được việc sang bộ xử lý: ${describeError(e)}`,
        });
      });
    return { ok: true, key };
  } catch (e) {
    // Clean up a rule that was applied but never got handed off to offscreen — avoids a session-long leak.
    if (ruleId !== undefined) await removeSpoofRules([ruleId]);
    await updateDownload(key, {
      state: 'interrupted',
      error: e instanceof Error ? e.message : 'Không bắt đầu tải được.',
    });
    return {
      ok: false,
      error: 'Không bắt đầu tải được (URL có thể hết hạn/403 hoặc bị chặn).',
    };
  }
}

/** Server returned an error code — keep `status` so the message still points in the right direction (403 = anti-hotlink). */
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/**
 * W7.1 — HARD BOUNDARY §7. Once a tab is revealed to use DRM/EME, every DOWNLOAD path closes, with
 * a clear reason given.
 *
 * Returns the error message if it must block, `null` if clean. Placed in background (not the popup)
 * because the popup is just one of the entry points — blocking here seals every path.
 *
 * 🔴 This is REFUSAL code, not decryption code: we only detect it to say "not supported".
 */
export async function drmBlockReason(tabId?: number): Promise<string | null> {
  if (tabId === undefined || tabId < 0) return null;
  try {
    const systems = (await getTabState(tabId)).drmSystems ?? [];
    if (systems.length === 0) return null;
    // Drop the generic entry if a named vendor is already known -> the message states the real name
    // instead of "unknown".
    const named = systems.filter((s) => s !== 'DRM không rõ');
    return DRM_UNSUPPORTED_ERROR(
      named.length > 0 ? named.join(', ') : undefined,
    );
  } catch {
    return null; // storage read failed -> don't block unjustly.
  }
}

export async function handleHlsEstimate(
  variantUrl: string,
  bandwidth?: number,
  audioUrl?: string,
  tabId?: number,
  mediaType?: 'hls' | 'dash',
  variantId?: string,
  audioId?: string,
): Promise<HlsEstimateResponse> {
  // W7.1 — the TAB's DRM flag (EME) is a signal INDEPENDENT of the playlist: SAMPLE-AES shows up in
  // the playlist, while Widevine/PlayReady leave NO trace there and only surface via EME. Knowing
  // upfront lets us answer immediately, without spending a single request.
  const drmBlocked = await drmBlockReason(tabId);
  if (drmBlocked) {
    return {
      ok: true,
      protected: true,
      segmentCount: 0,
      durationSec: 0,
      // No playlist has been fetched yet (DRM blocked it first) -> nothing is known about splice
      // points. The popup stops at the `protected` branch before reading this far, so 0 here means
      // "no data", not "measured and clean".
      discontinuityCount: 0,
    };
  }
  // W2.2: spoof Referer/Origin around the estimate fetch — same §2.3 reasoning as handleVariants.
  // The estimate usually points at the same host as video; a different audio host (if any) is fully
  // covered by W2.3.
  const pageUrl = await pageUrlFor(tabId, variantUrl);
  try {
    return await withSpoofedFetch(
      variantUrl,
      pageUrl,
      () =>
        estimateFromPlaylists(
          variantUrl,
          bandwidth,
          audioUrl,
          mediaType,
          variantId,
          audioId,
        ),
      await capturedFor(tabId, variantUrl),
    );
  } catch (e) {
    if (e instanceof HttpError) {
      return { ok: false, error: `Máy chủ trả mã ${e.status}.` };
    }
    return {
      ok: false,
      error: 'Không tải/parse được playlist (mạng hoặc CORS).',
    };
  }
}

async function estimateFromPlaylists(
  variantUrl: string,
  bandwidth?: number,
  audioUrl?: string,
  mediaType?: 'hls' | 'dash',
  variantId?: string,
  audioId?: string,
): Promise<HlsEstimateResponse> {
  // The HTTP status MUST survive all the way to the user: "Server returned code 403." points
  // straight at anti-hotlink protection, while "network or CORS" points in a completely wrong
  // direction — exactly the "real reason evaporates" pattern this very session just patched in the
  // ffmpeg layer. Throw a dedicated HttpError so the catch block can tell them apart.
  const fetchParse = async (url: string) => {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new HttpError(res.status);
    return parseTrackSegments(await res.text(), url, mediaType, variantId);
  };
  // W1.1: the job will also download the audio playlist -> the estimate must inspect it too,
  // otherwise the popup reports "10 segments" and then the progress bar runs up to 21 — looks like a bug.
  //
  // ⚠️ A broken audio playlist must NOT block the download path: this is only the ESTIMATE step. The
  // audio host can differ from the video host, so the estimate's spoof (which only covers the video
  // host) doesn't reach it -> on an anti-hotlink site, the audio playlist can easily 403 right here
  // and still download fine later in handleHlsDownload. Letting Promise.all reject would cost the user
  // the download button entirely over one estimate number — trading a small annoyance for a dead end.
  // W1.5 — DASH keeps BOTH video AND audio in the SAME .mpd file, so `variantUrl === audioUrl`.
  // Calling fetchParse twice would download the whole manifest twice just for one estimate number;
  // fetching once and parsing both tracks is enough and costs no extra network.
  let parsed: Awaited<ReturnType<typeof fetchParse>>;
  let audio: Awaited<ReturnType<typeof fetchParse>> | null;
  if (mediaType === 'dash') {
    const res = await fetch(variantUrl, { credentials: 'include' });
    if (!res.ok) throw new HttpError(res.status);
    const text = await res.text();
    parsed = parseTrackSegments(text, variantUrl, 'dash', variantId);
    audio = audioId
      ? parseTrackSegments(text, variantUrl, 'dash', audioId)
      : null;
  } else {
    [parsed, audio] = await Promise.all([
      fetchParse(variantUrl),
      audioUrl ? fetchParse(audioUrl).catch(() => null) : Promise.resolve(null),
    ]);
  }
  // Duration is the MAX, NOT the sum: video and audio run IN PARALLEL, not back to back.
  const durationSec = Math.max(parsed.totalDuration, audio?.totalDuration ?? 0);
  // #EXT-X-STREAM-INF's BANDWIDTH already includes the audio rendition (RFC 8216 §4.3.4.2) -> do
  // NOT add anything on top, adding more would double-count it.
  const estBytes =
    bandwidth && bandwidth > 0
      ? Math.round((bandwidth / 8) * durationSec)
      : undefined;
  return {
    ok: true,
    protected: parsed.isProtected || (audio?.isProtected ?? false),
    // Name the DRM vendor explicitly: a bare "not supported" makes the user think the extension is broken.
    ...(parsed.drmName || audio?.drmName
      ? { drmName: parsed.drmName ?? audio?.drmName }
      : {}),
    segmentCount: parsed.segments.length + (audio?.segments.length ?? 0),
    durationSec,
    estBytes,
    // W1.4 — MAX, NOT sum: video and audio are two views of the SAME timeline, so the same ad-break
    // splice point shows up in BOTH playlists. Adding them would double-count. Take the max so
    // whichever playlist declares it more completely wins — missing a splice point is the silent failure.
    discontinuityCount: Math.max(
      parsed.discontinuityCount,
      audio?.discontinuityCount ?? 0,
    ),
  };
}

export async function handleHlsDownload(
  variantUrl: string,
  mediaUrl: string,
  tabId: number,
  height?: number,
  audioUrl?: string,
  mediaType?: 'hls' | 'dash',
  variantId?: string,
  audioId?: string,
): Promise<HlsDownloadResponse> {
  // W7.1 — HARD BOUNDARY §7: refuse IMMEDIATELY, before applying any spoof rule or firing any request.
  const drmBlocked = await drmBlockReason(tabId);
  if (drmBlocked) return { ok: false, error: drmBlocked };
  // Hoisted out of the try so the catch can still clean up: if it throws BEFORE putHlsJob, the id
  // isn't stored anywhere; if ensureOffscreen throws AFTER putHlsJob, the job stays stuck at 'queued'
  // (storage.onChanged has no terminal branch to clean it) -> removing directly via the id we're
  // already holding is the most reliable approach.
  const spoofRuleIds: number[] = [];
  try {
    const media = (await getTabMedia(tabId)).find((m) => m.url === mediaUrl);
    const pageUrl = media?.pageUrl;
    // W2.1 — the REAL headers the player sent for this exact manifest. Captured by the EXACT media
    // URL, NOT via a `pageUrlFor`-style fallback (which returns any item on the tab): pageUrl is a
    // page-level fact so it can be borrowed, but headers are a request-level fact — borrowing from
    // another media item would be a new kind of fabrication.
    const captured = capturedContextOf(media);
    // Every applied rule MUST be tracked so it can be CLEANED UP: a DNR session rule lives for the
    // rest of the browser session (§2.10) -> missing one leaks it until the browser closes. W2.4:
    // each host gets its OWN id (not derived from the host) so two downloads on the same host don't
    // steal each other's rule. `spoofedHosts` is only for DEDUPING (one rule per host for this job),
    // while `spoofRuleIds` is what actually gets cleaned up.
    const spoofedHosts = new Set<string>();
    const spoof = async (url: string): Promise<void> => {
      const host = hostFromUrl(url);
      if (
        !host ||
        spoofedHosts.has(host) ||
        spoofedHosts.size >= MAX_SPOOF_HOSTS
      )
        return;
      const ruleId = await allocateSpoofRuleId();
      await applySpoof(ruleId, url, pageUrl, captured);
      spoofedHosts.add(host);
      spoofRuleIds.push(ruleId);
    };
    // Spoof the video + audio playlist hosts (audio can be on a separate CDN — W1.1).
    await spoof(variantUrl);
    if (audioUrl) await spoof(audioUrl);
    // W2.3: parse the playlist FIRST, then spoof EVERY host of segment/key/init. These are very often
    // on a different CDN host than the playlist (the AES key host is ALMOST ALWAYS different, and is
    // also the thing that most often checks Referer) -> missing one means the job reaches 'fetching'
    // and every segment 403s. The rule is applied HERE, BEFORE offscreen fetches any segment.
    // Best-effort: if the playlist 403s at this step, offscreen still retries on its own; we only lose
    // the "different host" coverage.
    //
    // W1.5 — parse using the CORRECT format: feeding a .mpd into the HLS parser yields 0 segments
    // WITHOUT throwing -> 0 segment hosts get spoofed -> the job reaches 'fetching' and then 403s
    // cleanly, silently.
    // DASH keeps both video and audio in one .mpd, so dedupe by URL: same document, two tracks.
    const playlistJobs: { url: string; trackId?: string }[] =
      mediaType === 'dash'
        ? [
            { url: variantUrl, ...(variantId ? { trackId: variantId } : {}) },
            ...(audioId ? [{ url: variantUrl, trackId: audioId }] : []),
          ]
        : (audioUrl ? [variantUrl, audioUrl] : [variantUrl]).map((url) => ({
            url,
          }));
    const textCache = new Map<string, string | null>();
    for (const job of playlistJobs) {
      try {
        if (!textCache.has(job.url)) {
          const res = await fetch(job.url, { credentials: 'include' });
          textCache.set(job.url, res.ok ? await res.text() : null);
        }
        const text = textCache.get(job.url);
        if (text == null) continue;
        const parsed = parseTrackSegments(
          text,
          job.url,
          mediaType,
          job.trackId,
        );
        for (const url of spoofTargetsFromSegments(parsed.segments)) {
          await spoof(url);
        }
        // DASH SegmentBase: the whole representation is just ONE .mp4 file that downloads directly
        // -> there's no segment to mux. Route it to the progressive path (W2.5) instead of letting
        // offscreen report "playlist has no segments" — technically true but entirely the wrong reason.
        if (parsed.directUrl) await spoof(parsed.directUrl);
      } catch {
        // best-effort — host discovery must never be allowed to break the download path.
      }
    }
    const folder = await getDownloadFolder();
    const filename = buildDownloadFilename({
      url: variantUrl,
      // W4.3 — this is the MAIN download path (HLS/DASH) and also where `media?.title` is empty most often.
      title: await resolveTitle(tabId, media),
      height: height ?? media?.height,
      folder,
      template: await getFilenameTemplate(),
      pageUrl: media?.pageUrl ?? media?.detectPageUrl,
    });
    const jobId = crypto.randomUUID();
    await putHlsJob({
      id: jobId,
      mediaUrl,
      variantUrl,
      // 'queued', NOT 'loading': offscreen hasn't run a single line yet. Only offscreen is allowed to
      // set 'loading' (main.ts), so a job stuck at 'queued' means the message never arrived.
      phase: 'queued',
      segmentsTotal: 0,
      segmentsDone: 0,
      filename,
      tabId,
      // W2.7 — the FIRST heartbeat, set right when the job is created. This gives the case
      // "offscreen died before it could pick up the work" (job stuck at 'queued') a timestamp for the
      // detection tick to find, instead of falling outside the net.
      lastSeenAt: Date.now(),
      // Stored so it can be CLEANED UP on EVERY terminal branch (done/error/cancelled), not just the
      // success branch via handleBlobDownload — W2.3 expanded the host set so a leak on error would
      // be worse without this.
      spoofRuleIds,
    });
    await ensureOffscreen();
    // Not awaited: the job runs long, offscreen reports progress via storage, not via the response.
    // BUT errors must be caught — swallowing them here would mean a dropped message (e.g. offscreen
    // hasn't registered its listener yet) leaves the job stuck at 'queued' FOREVER with no error line at all.
    void browser.runtime
      .sendMessage({
        target: 'offscreen',
        kind: 'hls/run',
        jobId,
        variantUrl,
        audioUrl,
        filename,
        mediaUrl,
        tabId,
        spoofRuleIds,
        // W1.5 — missing these 3 fields makes offscreen feed the .mpd into the HLS parser, and the
        // job dies silently.
        mediaType,
        variantId,
        audioId,
        // Offscreen cannot read settings itself (no chrome.storage) -> read them here and pass them along.
        concurrency: await getConcurrency(),
      })
      .catch(async (e: unknown) => {
        await updateHlsJob(jobId, {
          phase: 'error',
          error: `Không gửi được việc sang bộ xử lý video: ${describeError(e)}`,
        });
      });
    return { ok: true, jobId };
  } catch (e) {
    // Clean up every rule applied before throwing (see the hoist comment at the top of this function)
    // — otherwise an orphaned id would only get cleaned up by the cold-start sweep.
    if (spoofRuleIds.length) await removeSpoofRules(spoofRuleIds);
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Không khởi tạo được tải HLS.',
    };
  }
}

/**
 * Track 2 — download a YouTube video. Re-extracts FRESH direct URLs from the content script (the only
 * context that returns them), then dispatches a 2-URL mux job to offscreen. NO spoof rule: googlevideo
 * URLs carry their own auth params and download 206 with a plain cross-origin fetch (measured).
 *
 * Progress is tracked in an HlsJob record (reused verbatim) so the popup's existing job UI applies.
 */
export async function handleYoutubeDownload(
  videoId: string,
  tabId: number,
  height?: number,
): Promise<HlsDownloadResponse> {
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    // 🔴 RE-EXTRACT, never trust a stored URL: googlevideo links expire (a few hours) + are IP-locked.
    let re: YoutubeReextractResponse;
    try {
      const req: YoutubeReextractRequest = {
        kind: 'youtube/reextract',
        videoId,
        maxHeight: height,
      };
      // Timeout backstop: the content script's own fetch already times out, so it should always
      // respond — but if the tab is unresponsive (never calls sendResponse), `tabs.sendMessage`
      // would hang this request forever, before any HlsJob exists for the reaper to catch. Race it.
      re = await Promise.race([
        browser.tabs.sendMessage(
          tabId,
          req,
        ) as Promise<YoutubeReextractResponse>,
        new Promise<YoutubeReextractResponse>((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: false,
                error:
                  'Trang YouTube không phản hồi (hãy tải lại trang rồi bấm lại).',
              }),
            30_000,
          ),
        ),
      ]);
    } catch {
      return {
        ok: false,
        error:
          'Không liên hệ được trang YouTube (hãy mở/tải lại trang video rồi bấm lại).',
      };
    }
    if (!re || !re.ok) {
      return {
        ok: false,
        error: re?.error ?? 'Không lấy được liên kết tải từ YouTube.',
      };
    }
    const folder = await getDownloadFolder();
    const filename = buildDownloadFilename({
      url: canonicalUrl,
      title: re.title,
      // Label the file with the DELIVERED height (re.videoHeight), not the requested one — the
      // download-time client pool can resolve a different quality than detection advertised.
      height: re.videoHeight ?? height,
      // Output is always remuxed to .mp4 (avc1 + AAC) regardless of the source container.
      contentType: 'video/mp4',
      folder,
      template: await getFilenameTemplate(),
      pageUrl: canonicalUrl,
    });
    const jobId = crypto.randomUUID();
    await putHlsJob({
      id: jobId,
      mediaUrl: canonicalUrl,
      variantUrl: re.videoUrl,
      phase: 'queued',
      segmentsTotal: 0,
      segmentsDone: 0,
      filename,
      tabId,
      lastSeenAt: Date.now(),
    });
    await ensureOffscreen();
    void browser.runtime
      .sendMessage({
        target: 'offscreen',
        kind: 'youtube/run',
        jobId,
        filename,
        mediaUrl: canonicalUrl,
        tabId,
        videoUrl: re.videoUrl,
        audioUrl: re.audioUrl,
        videoBytes: re.videoBytes,
        audioBytes: re.audioBytes,
      })
      .catch(async (e: unknown) => {
        await updateHlsJob(jobId, {
          phase: 'error',
          error: `Không gửi được việc sang bộ xử lý video: ${describeError(e)}`,
        });
      });
    return { ok: true, jobId };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Không bắt đầu tải YouTube được.',
    };
  }
}

export async function handleBlobDownload(
  blobUrl: string,
  filename: string,
  mediaUrl: string,
  _tabId: number,
  jobId: string,
  spoofRuleIds?: number[],
  downloadKey?: string,
): Promise<void> {
  // Bytes are already fetched -> remove the spoof rule for EVERY host (HLS: video/audio/segment;
  // progressive: 1 host).
  if (spoofRuleIds?.length) void removeSpoofRules(spoofRuleIds);
  // W2.5: progressive hands off via downloadKey -> ATTACH chromeDownloadId to the EXACT entry that's
  // fetching (don't create a new one, or the popup will show 2 rows). HLS has no downloadKey ->
  // create an entry keyed by jobId.
  const key = downloadKey ?? jobId;
  try {
    const downloadId = await browser.downloads.download({
      url: blobUrl,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    if (downloadKey) {
      // User already CANCELLED during fetch->save (entry is already 'interrupted'; at that point
      // there was no chromeDownloadId yet, so handleDownloadCancel only aborted offscreen — harmless
      // since the fetch had finished) -> cancel this freshly created blob download too + revoke it,
      // DO NOT write 'complete' over the user's cancel.
      const cur = (await getDownloads())[key];
      if (cur?.state === 'interrupted') {
        void browser.downloads.cancel(downloadId).catch(() => undefined);
        void sendToOffscreen({ kind: 'revoke', url: blobUrl });
        return;
      }
      // Entry already exists (fetch phase) -> merge in the real id + blobUrl; keep state in_progress
      // (onChanged will flip it).
      await updateDownload(key, { chromeDownloadId: downloadId, blobUrl });
      // Race guard: a small blob can COMPLETE before downloads.onChanged manages to match the entry
      // (at that point chromeDownloadId hasn't persisted yet -> onChanged skips it -> entry stuck at
      // 'in_progress'). Re-read the state IMMEDIATELY: if already terminal, write it now + revoke the
      // blob (avoids depending on onChanged's timing).
      const [d] = await browser.downloads.search({ id: downloadId });
      if (d && d.state !== 'in_progress') {
        await updateDownload(key, {
          state: d.state as DownloadState,
          ...(d.error ? { error: d.error } : {}),
        });
        void sendToOffscreen({ kind: 'revoke', url: blobUrl });
      }
    } else {
      await putDownload({
        key,
        mediaUrl,
        filename,
        state: 'in_progress',
        chromeDownloadId: downloadId,
        blobUrl,
      });
    }
  } catch (e) {
    // Could not save -> report the error at the EXACT place the popup is watching: progressive watches
    // DownloadEntry, HLS watches the job.
    const msg = e instanceof Error ? e.message : 'Không lưu được file về máy.';
    if (downloadKey) {
      await updateDownload(key, { state: 'interrupted', error: msg });
    } else {
      await updateHlsJob(jobId, { phase: 'error', error: msg });
    }
  }
}

/**
 * W2.5 — cancel a progressive download by KEY. Two phases, two ways to cancel:
 * - already has chromeDownloadId (currently SAVING) -> chrome.downloads.cancel;
 * - doesn't yet (currently FETCHING inside offscreen) -> tell offscreen to abort the fetch + remove
 *   the spoof rule + mark it cancelled.
 */
export async function handleDownloadCancel(key: string): Promise<void> {
  const entry = (await getDownloads())[key];
  if (!entry) return;
  if (entry.chromeDownloadId !== undefined) {
    void browser.downloads
      .cancel(entry.chromeDownloadId)
      .catch(() => undefined);
    return;
  }
  void browser.runtime
    .sendMessage({ target: 'offscreen', kind: 'download/abort', key })
    .catch(() => undefined);
  if (entry.spoofRuleIds?.length) void removeSpoofRules(entry.spoofRuleIds);
  await updateDownload(key, { state: 'interrupted', error: 'Đã huỷ' });
}
