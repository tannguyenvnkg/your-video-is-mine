import {
  sendRuntimeMessage,
  type YoutubeReextractRequest,
  type YoutubeReextractResponse,
} from '@/utils/messages';
import {
  avcHeights,
  buildPlayerRequestBody,
  classifyPlayability,
  extractVideoId,
  pickFormats,
  YT_CLIENT_ANDROID,
  YT_CLIENT_IOS,
  YT_DEFAULT_MAX_HEIGHT,
  YT_PLAYER_ENDPOINT,
  type YtClientContext,
  type YtPlayabilityStatus,
  type YtStreamingData,
} from '@/utils/youtube';

// Track 2 — YouTube "fast path" detector (isolated world).
//
// MEASURED 2026-07-22 (see docs/superpowers/specs/2026-07-22-youtube-fast-path-design.md): the WEB
// player is SABR-only (adaptiveFormats carry no `url`), but a same-origin POST to youtubei/v1/player
// impersonating the ANDROID (fallback IOS) app client returns adaptiveFormats WITH direct
// googlevideo URLs and, for mainstream videos, no `n`/cipher — a downloadable avc1+AAC pair.
//
// This script only DETECTS + reports the video (Phase 2). It sends the videoId + heights, never the
// URLs (those expire / are IP-locked). Fetching + muxing is Phase 3. It runs in the isolated world
// so it can call `browser.runtime`; the InnerTube fetch is same-origin with youtube.com, so cookies
// ride along (needed only for age-gated videos — public ones work unauthenticated).

interface YtPlayerResponse {
  playabilityStatus?: YtPlayabilityStatus;
  streamingData?: YtStreamingData;
  videoDetails?: { title?: string; videoId?: string };
}

// 🔴 MUST time out: without this, a stalled fetch (dropped connection / captive portal that swallows
// the request with no HTTP error) makes `callPlayer` never settle -> `reextract` never settles -> the
// content script's onMessage listener (which returned `true` to keep the channel open) never calls
// sendResponse -> background's `tabs.sendMessage` await hangs FOREVER, before any HlsJob record exists
// for the reaper to catch. That is precisely this project's #1 failure class (a silent 100% hang).
const PLAYER_TIMEOUT_MS = 12_000;

/** POSTs the player request for one client. Returns null on any network/parse failure (fail soft). */
async function callPlayer(
  videoId: string,
  client: YtClientContext,
): Promise<YtPlayerResponse | null> {
  try {
    const res = await fetch(YT_PLAYER_ENDPOINT, {
      method: 'POST',
      // Same-origin on youtube.com -> cookies are sent (matters only for age-gated videos).
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPlayerRequestBody(videoId, client)),
      signal: AbortSignal.timeout(PLAYER_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as YtPlayerResponse;
  } catch {
    // Includes the timeout abort -> fail soft (detection retries; reextract returns ok:false).
    return null;
  }
}

/**
 * `ok` — a candidate was reported.
 * `walled` — YouTube gave a real per-video "no" (bot/age wall, or no usable avc1+AAC pair). Definitive
 *            → never retry (retrying can't change the answer, and hammering the endpoint invites bot
 *            detection).
 * `transient` — no client even produced a usable classification (network/HTTP failure, or an
 *            unrecognized response). Could be a momentary blip OR a systemic break (YouTube rotated
 *            the client contract) → the caller retries a bounded number of times.
 */
type DetectOutcome = 'ok' | 'walled' | 'transient';

/**
 * Tries ANDROID then IOS. Reports a `media/youtube` candidate on the first client that returns a
 * playable response with a downloadable avc1+AAC pair.
 *
 * A per-video "no" fails softly (no row) — v1 targets the happy path. But a WHOLE-SURFACE failure is
 * logged: this project's #1 failure class is a silent 100% kill, and a rotated InnerTube client
 * version would otherwise make every video look "walled" with no trace.
 */
async function detectAndReport(videoId: string): Promise<DetectOutcome> {
  let sawDefinitive = false;
  for (const client of [YT_CLIENT_ANDROID, YT_CLIENT_IOS]) {
    const pr = await callPlayer(videoId, client);
    if (!pr) continue; // network/HTTP failure -> transient; try the next client.
    const play = classifyPlayability(pr.playabilityStatus);
    if (play === 'login_required' || play === 'unplayable') {
      sawDefinitive = true; // a real verdict: not downloadable for us.
      continue;
    }
    if (play !== 'ok') continue; // 'unknown' = unrecognized shape -> treat as transient.
    const sd = pr.streamingData;
    // Confirm a real video+audio pair is fetchable (heights alone don't prove usable audio). No pair,
    // or no advertisable height, is a real per-video "no", not a transient error.
    if (!pickFormats(sd)) {
      sawDefinitive = true;
      continue;
    }
    const heights = avcHeights(sd);
    if (heights.length === 0) {
      sawDefinitive = true;
      continue;
    }
    void sendRuntimeMessage({
      kind: 'media/youtube',
      videoId,
      title: pr.videoDetails?.title,
      heights,
    });
    return 'ok';
  }
  if (sawDefinitive) return 'walled';
  // Neither client produced a usable classification. Momentary network issue — OR YouTube changed the
  // InnerTube contract / rejected our hardcoded client version, in which case EVERY video dies here
  // with no other signal. Leave a breadcrumb so "feature is dead" is distinguishable from "this video
  // is walled" (see docs/superpowers/specs/2026-07-22-youtube-fast-path-design.md — breaks ~monthly).
  console.warn(
    `[yvim youtube] no downloadable formats for ${videoId} via ANDROID/IOS — network blip, or the ` +
      `InnerTube client version may need re-measuring.`,
  );
  return 'transient';
}

/**
 * Re-extracts FRESH direct URLs for a chosen quality at download time. Called by background via
 * `browser.tabs.sendMessage` — it must run here (same-origin, cookied) because that's the only
 * context measured to return direct URLs, and the URLs must be fresh (they expire / are IP-locked).
 */
async function reextract(
  videoId: string,
  maxHeight?: number,
): Promise<YoutubeReextractResponse> {
  for (const client of [YT_CLIENT_ANDROID, YT_CLIENT_IOS]) {
    const pr = await callPlayer(videoId, client);
    if (!pr) continue;
    if (classifyPlayability(pr.playabilityStatus) !== 'ok') continue;
    const picked = pickFormats(pr.streamingData, {
      maxHeight: maxHeight ?? YT_DEFAULT_MAX_HEIGHT,
    });
    if (!picked) continue;
    // The usable pool guarantees a url; re-check to satisfy the type and be safe.
    const videoUrl = picked.video.url;
    const audioUrl = picked.audio.url;
    if (!videoUrl || !audioUrl) continue;
    return {
      ok: true,
      videoUrl,
      audioUrl,
      title: pr.videoDetails?.title,
      videoHeight: picked.video.height,
      videoBytes: Number(picked.video.contentLength) || undefined,
      audioBytes: Number(picked.audio.contentLength) || undefined,
    };
  }
  return {
    ok: false,
    error:
      'Không lấy được liên kết tải (YouTube có thể đã đổi cơ chế, hoặc video bị chặn).',
  };
}

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',
  main() {
    // Download-time re-extraction: background -> here -> fresh URLs. Returns `true` synchronously to
    // keep the message channel open for the async response.
    browser.runtime.onMessage.addListener(
      (
        msg: unknown,
        _sender: unknown,
        sendResponse: (r?: unknown) => void,
      ): true | undefined => {
        const m = msg as Partial<YoutubeReextractRequest> | null;
        if (
          !m ||
          m.kind !== 'youtube/reextract' ||
          typeof m.videoId !== 'string'
        )
          return undefined;
        void reextract(m.videoId, m.maxHeight).then(sendResponse, () =>
          sendResponse({ ok: false, error: 'Lỗi khi lấy liên kết tải.' }),
        );
        return true;
      },
    );

    // Per-video state:
    //  - `inflight` blocks a concurrent double-probe (claimed BEFORE the await, with no await between
    //    the guard check and the add, so the initial run + `yt-navigate-finish` + `popstate` + the 3s
    //    poll can't race).
    //  - `settled` = reached a terminal verdict (reported, walled, or gave up) -> never re-probe;
    //    this is what stops the poll from spamming the endpoint.
    //  - a TRANSIENT failure is retried up to MAX_ATTEMPTS times (a blip at document_idle / cold
    //    session shouldn't foreclose a genuinely downloadable video forever), then settled.
    const inflight = new Set<string>();
    const settled = new Set<string>();
    const attempts = new Map<string, number>();
    const MAX_ATTEMPTS = 3;

    async function tick(): Promise<void> {
      const videoId = extractVideoId(location.href);
      if (!videoId || settled.has(videoId) || inflight.has(videoId)) return;
      inflight.add(videoId);
      try {
        const outcome = await detectAndReport(videoId);
        if (outcome === 'ok' || outcome === 'walled') {
          settled.add(videoId);
        } else {
          const n = (attempts.get(videoId) ?? 0) + 1;
          attempts.set(videoId, n);
          if (n >= MAX_ATTEMPTS) settled.add(videoId); // stop retrying; never spam.
        }
      } catch {
        // never let detection break the page.
      } finally {
        inflight.delete(videoId);
      }
    }

    void tick();
    // YouTube is a SPA: navigating video A -> B fires no main_frame request. `yt-navigate-finish`
    // is dispatched by the Polymer app on every in-app navigation (observable from the isolated
    // world since it shares the DOM); it bubbles, so `window` catches it too. `popstate` covers
    // back/forward. All of these funnel through the `attempted` guard, so extra firings are free.
    const onNav = (): void => void tick();
    document.addEventListener('yt-navigate-finish', onNav);
    window.addEventListener('yt-navigate-finish', onNav);
    window.addEventListener('popstate', onNav);
    // Backstop for navigations that don't fire the event reliably; the `attempted` guard keeps this
    // to one request per new video, so the poll itself never spams.
    setInterval(() => void tick(), 3000);
  },
});
