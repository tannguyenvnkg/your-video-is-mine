// Runtime message protocol between content script / popup / options / offscreen and background.
// Discriminated union on the `kind` field for type safety.

import type { DownloadEntry, HlsJob } from './storage';
import type { MediaType, VariantInfo } from './types';

export interface DomMediaCandidate {
  url: string;
  contentTypeHint?: string;
}

/** Only HLS/DASH have a manifest to enumerate quality levels. */
export type ManifestKind = Extract<MediaType, 'hls' | 'dash'>;

export type VariantsResponse =
  | { ok: true; isMaster: boolean; variants: VariantInfo[] }
  | { ok: false; error: string };

// W2.5 — progressive now fetches bytes in offscreen BEFORE a chrome downloadId exists, so it returns
// `key` (a stable jobId) instead of downloadId. Popup uses the key to look up status + cancel.
export type DownloadStartResponse =
  { ok: true; key: string } | { ok: false; error: string };

/** ACK for 'download/progress' — offscreen awaits it to preserve update ordering (like hls/progress). */
export type DownloadProgressResponse = { ok: true };

export type EngineSelfTestResponse =
  { ok: true; size: number } | { ok: false; error: string };

export type HlsEstimateResponse =
  | {
      ok: true;
      protected: boolean;
      /** DRM vendor name for a clear notice (FairPlay/PlayReady/Widevine/...). */
      drmName?: string;
      segmentCount: number;
      durationSec: number;
      /** Estimated size (bytes) if bitrate is known. */
      estBytes?: number;
      /**
       * W1.4 — number of splices (timestamp resets, usually from ad insertion) inside the stream
       * about to be downloaded. > 0 -> popup MUST warn before downloading: we concatenate bytes then
       * `-c copy`; if ffmpeg hits non-monotonic DTS it produces a file with drifted audio/wrong
       * duration while still reporting "Download complete ✓".
       */
      discontinuityCount: number;
    }
  | { ok: false; error: string };

export type HlsDownloadResponse =
  { ok: true; jobId: string } | { ok: false; error: string };

// Track 2 — background asks the youtube.com content script to RE-EXTRACT fresh direct URLs at
// download time (sent via `browser.tabs.sendMessage`, NOT through the background router). Fresh
// because googlevideo URLs expire / are IP-locked, so a stored URL would 403.
export interface YoutubeReextractRequest {
  kind: 'youtube/reextract';
  videoId: string;
  /** cap the video height to the user's chosen quality. */
  maxHeight?: number;
}

export type YoutubeReextractResponse =
  | {
      ok: true;
      videoUrl: string;
      audioUrl: string;
      title?: string;
      /** Actually resolved video height -> the filename labels the DELIVERED quality, not the
       *  requested one (the download-time client pool can differ from detection time). */
      videoHeight?: number;
      /** Content-Length of each track if InnerTube reported it (used for the progress total). */
      videoBytes?: number;
      audioBytes?: number;
    }
  | { ok: false; error: string };

/** ACK for 'hls/progress' — offscreen awaits it to preserve update ordering. */
export type HlsProgressResponse = { ok: true };

/** Message sent TO BACKGROUND (from content/popup/options/offscreen). */
export type RuntimeMessage =
  | { kind: 'media/dom'; candidates: DomMediaCandidate[] }
  | { kind: 'media/mse'; url: string }
  // Track 2 — the youtube.com content script impersonated an InnerTube app client and confirmed the
  // video is downloadable. Carries only the videoId + display metadata + available heights: the
  // direct googlevideo URLs EXPIRE and are IP-locked, so they are re-extracted at download time (the
  // stored item never holds a stale URL). `heights` come from `avcHeights` (avc1 <= 1080).
  | {
      kind: 'media/youtube';
      videoId: string;
      title?: string;
      heights: number[];
    }
  // Track 2 — popup asks background to download a YouTube video. `tabId` is where the content script
  // lives (background re-extracts fresh URLs from it); `height` is the chosen quality (avc1 <= it).
  | {
      kind: 'youtube/download';
      videoId: string;
      tabId: number;
      height?: number;
    }
  // W7.1 — content script reports the page requesting DRM/EME. Empty `keySystem` = DRM is known to
  // be present but the vendor is unknown (signal comes from the 'encrypted' event, which doesn't
  // expose the system name).
  | { kind: 'media/drm'; keySystem: string }
  // content script sniffed an HLS/DASH manifest disguised under another extension (reads
  // #EXTM3U/<MPD from the body).
  | { kind: 'media/manifest'; url: string; mediaType: ManifestKind }
  // W2.2: `tabId` lets background look up `media.pageUrl` -> spoof Referer TIGHTLY around the
  // manifest fetch. Without it the first fetch goes out bare and a hotlink-protected site 403s
  // right at the quality-selection step.
  | {
      kind: 'manifest/variants';
      url: string;
      mediaType: ManifestKind;
      tabId?: number;
    }
  | { kind: 'download/progressive'; url: string; tabId: number }
  | { kind: 'engine/selftest' }
  // popup -> background: estimate size + check for DRM before downloading HLS.
  | {
      kind: 'hls/estimate';
      variantUrl: string;
      bandwidth?: number;
      /** W1.1: separate audio playlist — the job will download it TOO, so the estimate must include it. */
      audioUrl?: string;
      /** W2.2: looks up `media.pageUrl` to spoof Referer before fetching the estimate playlist. */
      tabId?: number;
      /**
       * W1.5 — manifest format. Absent = 'hls' (every download before W1.5).
       *
       * 🔴 URL CANNOT identify a DASH track: with SegmentTemplate, the `resolvedUri` of EVERY
       * representation (including audio) is the `.mpd` file itself. So `variantId`/`audioId` must be
       * included — without them the layer below just grabs the first representation: a user picking
       * 1080p gets 240p, or audio gets downloaded as video, with NOT a single line of error.
       */
      mediaType?: ManifestKind;
      /** W1.5 — video representation id (DASH). See `VariantInfo.id`. */
      variantId?: string;
      /** W1.5 — audio representation id (DASH). See `RenditionInfo.id`. */
      audioId?: string;
    }
  // popup -> background: start downloading & muxing HLS.
  | {
      kind: 'hls/download';
      variantUrl: string;
      mediaUrl: string;
      tabId: number;
      height?: number;
      /**
       * Separate AUDIO playlist URL (W1.1) — taken from the variant's `selected` rendition.
       * Absent = audio already inside the variant -> single-input path.
       * W4.4 (language selection) just needs to send a different URL here, NO protocol change needed.
       */
      audioUrl?: string;
      /**
       * W1.5 — manifest format. Absent = 'hls' (every download before W1.5).
       *
       * 🔴 URL CANNOT identify a DASH track: with SegmentTemplate, the `resolvedUri` of EVERY
       * representation (including audio) is the `.mpd` file itself. So `variantId`/`audioId` must be
       * included — without them the layer below just grabs the first representation: a user picking
       * 1080p gets 240p, or audio gets downloaded as video, with NOT a single line of error.
       */
      mediaType?: ManifestKind;
      /** W1.5 — video representation id (DASH). See `VariantInfo.id`. */
      variantId?: string;
      /** W1.5 — audio representation id (DASH). See `RenditionInfo.id`. */
      audioId?: string;
    }
  // offscreen -> background: update HLS job progress.
  // Offscreen CANNOT write chrome.storage directly (only has chrome.runtime) -> every state change
  // must go through here for background to write on its behalf. This is a Chrome constraint, not a choice.
  | { kind: 'hls/progress'; jobId: string; patch: Partial<HlsJob> }
  // offscreen -> background: a file is ready (HLS muxed, or progressive fetch done), ask background to SAVE it.
  | {
      kind: 'download/blob';
      blobUrl: string;
      filename: string;
      mediaUrl: string;
      tabId: number;
      jobId: string;
      /**
       * W2.4 — id of EVERY spoof session rule applied for this job (one id per host: video + audio +
       * segment/key/init on a different host). Offscreen just carries it to hand back to background so
       * it can clean up exactly those rules — offscreen has NO chrome.declarativeNetRequest so it
       * cannot delete them itself.
       */
      spoofRuleIds?: number[];
      /**
       * W2.5 — present when this blob belongs to a PROGRESSIVE download (not HLS). It's the key of the
       * in-flight DownloadEntry so background attaches the chromeDownloadId to that exact entry
       * (instead of creating a new one). Absent = the old HLS flow -> background creates a
       * DownloadEntry keyed by jobId.
       */
      downloadKey?: string;
    }
  // offscreen -> background: progressive fetch progress (W2.5). Offscreen cannot write storage
  // (only has chrome.runtime) so it reports through here; background calls updateDownload on its
  // behalf. ACK to preserve ordering.
  | { kind: 'download/progress'; key: string; patch: Partial<DownloadEntry> }
  | { kind: 'hls/cancel'; jobId: string }
  // W2.5 — cancel by KEY (jobId) instead of downloadId: while fetching in offscreen there is no
  // chromeDownloadId yet. Background picks the right path itself: chromeDownloadId present ->
  // chrome.downloads.cancel; absent -> tell offscreen to abort the fetch.
  | { kind: 'download/cancel'; key: string };

/** Message sent FROM background TO offscreen (has `target: 'offscreen'` to distinguish it). */
export type OffscreenRequest =
  | { target: 'offscreen'; kind: 'engine/selftest' }
  | {
      target: 'offscreen';
      kind: 'hls/run';
      jobId: string;
      variantUrl: string;
      filename: string;
      mediaUrl: string;
      tabId: number;
      /** W2.4 — id of every spoof rule for the job -> offscreen sends it back so background cleans up the right rules. */
      spoofRuleIds?: number[];
      /** W1.1: separate audio playlist. Present -> offscreen downloads 2 sets of segments then muxes 2 inputs. */
      audioUrl?: string;
      /**
       * Number of parallel download threads. MUST be read from settings by background and passed in:
       * offscreen has NO `chrome.storage` (only `chrome.runtime`) so it cannot read it itself.
       */
      concurrency: number;
      /**
       * W1.5 — manifest format. Absent = 'hls' (every download before W1.5).
       *
       * 🔴 URL CANNOT identify a DASH track: with SegmentTemplate, the `resolvedUri` of EVERY
       * representation (including audio) is the `.mpd` file itself. So `variantId`/`audioId` must be
       * included — without them the layer below just grabs the first representation: a user picking
       * 1080p gets 240p, or audio gets downloaded as video, with NOT a single line of error.
       */
      mediaType?: ManifestKind;
      /** W1.5 — video representation id (DASH). See `VariantInfo.id`. */
      variantId?: string;
      /** W1.5 — audio representation id (DASH). See `RenditionInfo.id`. */
      audioId?: string;
    }
  | { target: 'offscreen'; kind: 'revoke'; url: string }
  | { target: 'offscreen'; kind: 'hls/cancel'; jobId: string }
  // Track 2 — download the two direct googlevideo URLs (video + audio) range-chunked, mux them with
  // the SAME libav worker the HLS/DASH path uses, produce one .mp4. Reuses the HlsJob progress record.
  | {
      target: 'offscreen';
      kind: 'youtube/run';
      jobId: string;
      filename: string;
      mediaUrl: string;
      tabId: number;
      videoUrl: string;
      audioUrl: string;
      /** Content-Length per track if known -> exact progress total (else discovered via a Range probe). */
      videoBytes?: number;
      audioBytes?: number;
    }
  // Track 2 — cancel a running YouTube job (abort the in-flight range fetch / stop the mux).
  | { target: 'offscreen'; kind: 'youtube/cancel'; jobId: string }
  // W2.5 — progressive download via offscreen: fetch bytes (Range chunks for large files) while the
  // spoof rule is active, build a Blob, send download/blob back. `chrome.downloads.download` therefore
  // ONLY ever receives a blob: URL.
  | {
      target: 'offscreen';
      kind: 'download/run';
      key: string;
      url: string;
      filename: string;
      mediaUrl: string;
      tabId: number;
      /** id of the applied spoof rule -> carried along so background can clean it up (offscreen doesn't touch DNR). */
      spoofRuleIds?: number[];
    }
  // W2.5 — cancel a progressive fetch in flight inside offscreen (abort the AbortController).
  | { target: 'offscreen'; kind: 'download/abort'; key: string };

export async function sendRuntimeMessage(msg: RuntimeMessage): Promise<void> {
  try {
    await browser.runtime.sendMessage(msg);
  } catch {
    // background may not be ready yet; safe to ignore.
  }
}

export async function requestVariants(
  url: string,
  mediaType: ManifestKind,
  tabId?: number,
): Promise<VariantsResponse> {
  try {
    const res = await browser.runtime.sendMessage({
      kind: 'manifest/variants',
      url,
      mediaType,
      tabId,
    });
    return res as VariantsResponse;
  } catch {
    return { ok: false, error: 'Không kết nối được background.' };
  }
}

export async function requestDownload(
  url: string,
  tabId: number,
): Promise<DownloadStartResponse> {
  try {
    const res = await browser.runtime.sendMessage({
      kind: 'download/progressive',
      url,
      tabId,
    });
    return res as DownloadStartResponse;
  } catch {
    return { ok: false, error: 'Không kết nối được background.' };
  }
}

export async function requestEngineSelfTest(): Promise<EngineSelfTestResponse> {
  try {
    const res = await browser.runtime.sendMessage({ kind: 'engine/selftest' });
    return res as EngineSelfTestResponse;
  } catch {
    return { ok: false, error: 'Không kết nối được background.' };
  }
}

export async function requestHlsEstimate(
  variantUrl: string,
  bandwidth?: number,
  audioUrl?: string,
  tabId?: number,
  mediaType?: ManifestKind,
  variantId?: string,
  audioId?: string,
): Promise<HlsEstimateResponse> {
  try {
    const res = await browser.runtime.sendMessage({
      kind: 'hls/estimate',
      variantUrl,
      bandwidth,
      audioUrl,
      tabId,
      mediaType,
      variantId,
      audioId,
    });
    return res as HlsEstimateResponse;
  } catch {
    return { ok: false, error: 'Không kết nối được background.' };
  }
}

export async function requestHlsDownload(
  variantUrl: string,
  mediaUrl: string,
  tabId: number,
  height?: number,
  audioUrl?: string,
  mediaType?: ManifestKind,
  variantId?: string,
  audioId?: string,
): Promise<HlsDownloadResponse> {
  try {
    const res = await browser.runtime.sendMessage({
      kind: 'hls/download',
      variantUrl,
      mediaUrl,
      tabId,
      height,
      audioUrl,
      mediaType,
      variantId,
      audioId,
    });
    return res as HlsDownloadResponse;
  } catch {
    return { ok: false, error: 'Không kết nối được background.' };
  }
}

/** Track 2 — ask background to download a YouTube video (it re-extracts fresh URLs from the tab). */
export async function requestYoutubeDownload(
  videoId: string,
  tabId: number,
  height?: number,
): Promise<HlsDownloadResponse> {
  try {
    const res = await browser.runtime.sendMessage({
      kind: 'youtube/download',
      videoId,
      tabId,
      height,
    });
    return res as HlsDownloadResponse;
  } catch {
    return { ok: false, error: 'Không kết nối được background.' };
  }
}

/** Cancel a running HLS job. */
export async function requestHlsCancel(jobId: string): Promise<void> {
  try {
    await browser.runtime.sendMessage({ kind: 'hls/cancel', jobId });
  } catch {
    // ignore
  }
}

/** Cancel a running progressive download (by jobId key — W2.5). */
export async function requestDownloadCancel(key: string): Promise<void> {
  try {
    await browser.runtime.sendMessage({ kind: 'download/cancel', key });
  } catch {
    // ignore
  }
}
