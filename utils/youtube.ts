// Pure helpers for the YouTube "fast path" downloader (Track 2).
//
// These are the decision-making bits that must be unit-testable in isolation: extracting a video
// id from a URL, classifying the InnerTube playabilityStatus, and choosing which video+audio
// adaptive formats to download. Everything here is side-effect free — no fetch, no chrome API.
//
// Context (measured 2026-07-22): the youtube.com WEB player is SABR-only (adaptiveFormats carry no
// `url`). We instead call youtubei/v1/player impersonating the ANDROID (fallback IOS) client, which
// returns adaptiveFormats WITH direct googlevideo `url`s and, for mainstream videos, no `n`/cipher.
// See docs/superpowers/specs/2026-07-22-youtube-fast-path-design.md.

/** A single InnerTube stream format (subset of fields we use). */
export interface YtFormat {
  itag: number;
  /** direct googlevideo URL — ABSENT when the format is cipher-only (unusable without a descrambler). */
  url?: string;
  /** e.g. `video/mp4; codecs="avc1.640028"` or `audio/mp4; codecs="mp4a.40.2"`. */
  mimeType: string;
  bitrate?: number;
  width?: number;
  height?: number;
  /** byte length as a string (InnerTube returns it stringified). */
  contentLength?: string;
  audioQuality?: string;
  /** present instead of `url` when the URL is signature-ciphered. */
  signatureCipher?: string;
  cipher?: string;
}

export interface YtStreamingData {
  /** progressive (muxed) formats — mostly gone / throttled; we don't use these. */
  formats?: YtFormat[];
  /** adaptive (separate audio/video) formats — the ones we pick from. */
  adaptiveFormats?: YtFormat[];
  serverAbrStreamingUrl?: string;
}

export interface YtPlayabilityStatus {
  status?: string;
  reason?: string;
}

/** Coarse outcome of a player request, used to choose the UI message. */
export type Playability = 'ok' | 'login_required' | 'unplayable' | 'unknown';

/**
 * InnerTube client context we impersonate. The WEB player is SABR-only; the ANDROID/IOS app clients
 * return adaptiveFormats WITH direct `url`s and (for mainstream videos) no `n`/cipher. Versions are
 * the ones MEASURED to work on 2026-07-22 — bump them together with a re-measurement, never blindly.
 */
export interface YtClientContext {
  clientName: string;
  clientVersion: string;
  hl: string;
  gl: string;
  /** ANDROID only. */
  androidSdkVersion?: number;
  /** IOS only. */
  deviceModel?: string;
}

/** Primary client (measured: 19 adaptive + 1 progressive direct URLs). */
export const YT_CLIENT_ANDROID: YtClientContext = {
  clientName: 'ANDROID',
  clientVersion: '20.10.38',
  androidSdkVersion: 34,
  hl: 'en',
  gl: 'US',
};

/** Equal-quality fallback (measured: 8 adaptive direct URLs). */
export const YT_CLIENT_IOS: YtClientContext = {
  clientName: 'IOS',
  clientVersion: '20.10.4',
  deviceModel: 'iPhone16,2',
  hl: 'en',
  gl: 'US',
};

/** Same-origin InnerTube player endpoint. No API key needed (measured: works without `&key=`). */
export const YT_PLAYER_ENDPOINT =
  'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

export interface YtPlayerRequestBody {
  context: { client: YtClientContext };
  videoId: string;
  contentCheckOk: true;
  racyCheckOk: true;
}

/**
 * Builds the exact `youtubei/v1/player` POST body the Phase 0 probe verified. `contentCheckOk` /
 * `racyCheckOk` skip the "this may be inappropriate" interstitial that otherwise strips streamingData.
 */
export function buildPlayerRequestBody(
  videoId: string,
  client: YtClientContext,
): YtPlayerRequestBody {
  return {
    context: { client },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Extracts an 11-char video id from any common YouTube URL form (watch?v=, youtu.be/, /shorts/,
 * /embed/) or from a bare id. Returns null when the input is not a YouTube video reference.
 */
export function extractVideoId(input: string): string | null {
  const raw = input.trim();
  if (VIDEO_ID_RE.test(raw)) return raw;

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }

  const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
  const isYouTube =
    host === 'youtube.com' ||
    host === 'youtube-nocookie.com' ||
    host === 'youtu.be';
  if (!isYouTube) return null;

  // youtu.be/<id>
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0] ?? '';
    return VIDEO_ID_RE.test(id) ? id : null;
  }

  // youtube.com/watch?v=<id>
  const v = u.searchParams.get('v');
  if (v && VIDEO_ID_RE.test(v)) return v;

  // youtube.com/shorts/<id> or /embed/<id>
  const seg = u.pathname.match(/^\/(?:shorts|embed|v)\/([^/?#]+)/)?.[1];
  if (seg && VIDEO_ID_RE.test(seg)) return seg;

  return null;
}

/**
 * Classifies the InnerTube `playabilityStatus`. `LOGIN_REQUIRED` covers both the age gate and the
 * "confirm you're not a bot" / poToken wall — both mean "we can't download this without extra auth".
 */
export function classifyPlayability(
  status: YtPlayabilityStatus | null | undefined,
): Playability {
  switch (status?.status) {
    case 'OK':
      return 'ok';
    case 'LOGIN_REQUIRED':
      return 'login_required';
    case 'UNPLAYABLE':
    case 'ERROR':
    case 'LIVE_STREAM_OFFLINE':
      return 'unplayable';
    default:
      return 'unknown';
  }
}

export interface PickedFormats {
  video: YtFormat;
  audio: YtFormat;
}

export interface PickOptions {
  /** cap the chosen video height (default 1080). */
  maxHeight?: number;
  /** preferred video codec; falls back to any usable video when none match (default 'avc1'). */
  preferVideoCodec?: 'avc1' | 'any';
}

const hasUsableUrl = (f: YtFormat): boolean =>
  typeof f.url === 'string' && f.url.length > 0;

/** Default video-height cap (H.264 max we target). Shared so pickers and the download agree. */
export const YT_DEFAULT_MAX_HEIGHT = 1080;

/**
 * The ONE video-candidate set both `pickFormats` (what we download) and `avcHeights` (what the
 * picker shows) build on. Structurally shared so the two can NEVER diverge — a past class of bug
 * here was "advertise resolution X, silently download codec/res Y". Rules: direct `url` present,
 * a POSITIVE known height within the cap, avc1 preferred; fall back to any usable video only when
 * NO avc1 has a url. A format with no `height` is unrepresentable in the picker AND unrankable, so
 * it is excluded from BOTH (never selected, never advertised).
 */
function usableVideoPool(
  sd: YtStreamingData | null | undefined,
  maxHeight: number,
): YtFormat[] {
  const formats = sd?.adaptiveFormats;
  if (!formats) return [];
  const usable = formats.filter(
    (f) =>
      hasUsableUrl(f) &&
      f.mimeType.startsWith('video/') &&
      (f.height ?? 0) > 0 &&
      (f.height ?? 0) <= maxHeight,
  );
  const avc1 = usable.filter((f) => f.mimeType.includes('avc1'));
  return avc1.length > 0 ? avc1 : usable;
}

/**
 * Chooses ONE video + ONE audio adaptive format to download and remux.
 *
 * v1 rules (measured happy path): only formats with a direct `url` are usable (cipher-only formats
 * need a descrambler we don't build yet). Prefer H.264 (avc1) video within `maxHeight` and AAC
 * (mp4a) audio for the widest player compatibility; fall back to any usable video/audio otherwise.
 * Returns null when a usable video+audio pair can't be formed.
 */
export function pickFormats(
  sd: YtStreamingData | null | undefined,
  opts: PickOptions = {},
): PickedFormats | null {
  const maxHeight = opts.maxHeight ?? YT_DEFAULT_MAX_HEIGHT;
  const preferVideoCodec = opts.preferVideoCodec ?? 'avc1';

  const formats = sd?.adaptiveFormats;
  if (!formats || formats.length === 0) return null;

  // Video pool: SHARED with `avcHeights` so the picker and the download can't disagree. When the
  // caller opts out of avc1 preference, fall back to the raw usable-video set (still height-gated).
  const videos =
    preferVideoCodec === 'avc1'
      ? usableVideoPool(sd, maxHeight)
      : formats.filter(
          (f) =>
            hasUsableUrl(f) &&
            f.mimeType.startsWith('video/') &&
            (f.height ?? 0) > 0 &&
            (f.height ?? 0) <= maxHeight,
        );
  const audios = formats.filter(
    (f) => hasUsableUrl(f) && f.mimeType.startsWith('audio/'),
  );
  if (videos.length === 0 || audios.length === 0) return null;

  // Highest resolution, then highest bitrate (pool already applied the avc1 preference).
  const video = [...videos].sort(
    (a, b) =>
      (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0),
  )[0];

  // Audio: prefer AAC (mp4a), then highest bitrate.
  const aac = audios.filter((f) => f.mimeType.includes('mp4a'));
  const audioPool = aac.length > 0 ? aac : audios;
  const audio = [...audioPool].sort(
    (a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0),
  )[0];

  // Both pools are non-empty (checked above); the guard also satisfies noUncheckedIndexedAccess.
  if (!video || !audio) return null;
  return { video, audio };
}

/**
 * Distinct video heights the user can actually download (usable `url`, `<= maxHeight`), highest
 * first. Prefers avc1 — this is the quality-picker list, so it must match what `pickFormats` will
 * ACTUALLY choose (avc1 first). Only falls back to non-avc1 heights when NO avc1 has a direct url.
 * Cipher-only formats (no `url`) are excluded — offering a height we can't fetch would be a lie.
 */
export function avcHeights(
  sd: YtStreamingData | null | undefined,
  maxHeight = YT_DEFAULT_MAX_HEIGHT,
): number[] {
  // Same pool `pickFormats` downloads from -> every advertised height is one we can actually deliver.
  const set = new Set<number>();
  for (const f of usableVideoPool(sd, maxHeight))
    if (f.height) set.add(f.height);
  return [...set].sort((a, b) => b - a);
}
