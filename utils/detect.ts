// PURE media classification logic (no chrome API dependency) -> unit testable.
// HLS (.m3u8) is priority number 1 per the project owner's requirement.

import type { MediaItem, MediaType, MediaDetectSource } from './types';

export interface DetectInput {
  url: string;
  contentType?: string | null;
}

// Progressive file extensions: directly downloadable video.
const PROGRESSIVE_EXTS = new Set([
  '.mp4',
  '.webm',
  '.m4v',
  '.mov',
  '.mkv',
  '.ogg',
  '.ogv',
  '.mpg',
  '.mpeg',
  '.avi',
  '.flv',
  '.3gp',
]);

// HLS/DASH child segment file extensions -> NOT original media, skip.
const SEGMENT_EXTS = new Set(['.ts', '.m4s', '.aac', '.vtt', '.m4a']);

// Content-Type identifying HLS.
const HLS_CONTENT_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/mpegurl',
  'vnd.apple.mpegurl',
]);

// Content-Type identifying DASH.
const DASH_CONTENT_TYPES = new Set(['application/dash+xml']);

// Content-Type of a child segment -> skip.
const SEGMENT_CONTENT_TYPES = new Set(['video/mp2t', 'video/iso.segment']);

/** Get the pathname (strip query/hash) from a URL, safe with invalid URLs. */
export function getPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    // Relative/invalid URL: strip query & hash manually.
    const noHash = url.split('#', 1)[0] ?? url;
    return noHash.split('?', 1)[0] ?? noHash;
  }
}

/** Get the file extension (including the dot, lowercase) from a URL. '' if none. */
export function getExtension(url: string): string {
  const path = getPathname(url);
  const slash = path.lastIndexOf('/');
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

/** Normalize Content-Type: strip parameters after ';', trim, lowercase. */
function normalizeContentType(ct?: string | null): string {
  return (ct ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

/** Child segment (init/.ts/.m4s...) -> not original media, must be skipped. */
export function isLikelySegment(
  url: string,
  contentType?: string | null,
): boolean {
  const ext = getExtension(url);
  if (SEGMENT_EXTS.has(ext)) return true;
  if (SEGMENT_CONTENT_TYPES.has(normalizeContentType(contentType))) return true;
  // fMP4 init segment: name contains 'init' (init.mp4, init-1.mp4, video_init.mp4...).
  const path = getPathname(url).toLowerCase();
  const file = path.slice(path.lastIndexOf('/') + 1);
  if (/(^|[._-])init([._-][^/]*)?\.(mp4|m4s)$/.test(file)) return true;
  return false;
}

/**
 * Classify media from URL + Content-Type.
 * @returns MediaType or null (not media, or a child segment).
 */
export function classifyMedia(input: DetectInput): MediaType | null {
  // Child segment -> skip first.
  if (isLikelySegment(input.url, input.contentType)) return null;

  const ext = getExtension(input.url);
  const ct = normalizeContentType(input.contentType);

  // HLS is priority number 1.
  if (ext === '.m3u8' || HLS_CONTENT_TYPES.has(ct)) return 'hls';

  // DASH.
  if (ext === '.mpd' || DASH_CONTENT_TYPES.has(ct)) return 'dash';

  // Progressive: content-type video/* or a known file extension.
  if (ct.startsWith('video/')) return 'progressive';
  if (PROGRESSIVE_EXTS.has(ext)) return 'progressive';

  return null;
}

/** Stable string hash (FNV-1a 32-bit) -> short id for media. */
export function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 to make it unsigned; base36 for compactness.
  return (h >>> 0).toString(36);
}

export function mediaId(url: string): string {
  return stableHash(url);
}

/** Shorten a URL for display (keep head + tail, insert '…' in the middle). */
export function shortenUrl(url: string, max = 60): string {
  if (url.length <= max) return url;
  const budget = max - 1; // subtract the '…' character
  const head = Math.ceil(budget / 2);
  const tail = Math.floor(budget / 2);
  return `${url.slice(0, head)}…${url.slice(url.length - tail)}`;
}

export interface BuildMediaInput extends DetectInput {
  tabId: number;
  pageUrl?: string;
  title?: string;
  size?: number;
  acceptRanges?: boolean;
  detectSource?: MediaDetectSource;
  detectedAt: number;
  /** W2.1 — the REAL headers the player sent for this URL (from `onSendHeaders`). */
  sentHeaders?: Record<string, string>;
}

/** Build a MediaItem from a single detection. null if not media. */
export function buildMediaItem(input: BuildMediaInput): MediaItem | null {
  const type = classifyMedia(input);
  if (!type) return null;
  return {
    id: mediaId(input.url),
    type,
    url: input.url,
    tabId: input.tabId,
    pageUrl: input.pageUrl,
    title: input.title,
    contentType: input.contentType ?? undefined,
    size: input.size,
    acceptRanges: input.acceptRanges,
    detectedAt: input.detectedAt,
    detectSource: input.detectSource ?? 'network',
    sentHeaders: input.sentHeaders,
  };
}

/**
 * Add/augment media by url:
 * - url not present -> add new.
 * - url already present -> MERGE in missing fields (contentType/size/acceptRanges/pageUrl/title/...)
 *   from the new detection (e.g. onBeforeRequest adds first, onHeadersReceived fills in headers later).
 * @returns the list (new one if changed, old one otherwise) + a changed flag.
 */
export function upsertMedia(
  list: MediaItem[],
  item: MediaItem,
): { list: MediaItem[]; changed: boolean } {
  const idx = list.findIndex((m) => m.url === item.url);
  if (idx < 0) {
    return { list: [...list, item], changed: true };
  }

  const existing = list[idx]!;
  let dirty = false;
  // Only fill in when the old field is empty and the new field has a value (never overwrite known data).
  const pick = <T>(cur: T | undefined, inc: T | undefined): T | undefined => {
    if (
      (cur === undefined || cur === null) &&
      inc !== undefined &&
      inc !== null
    ) {
      dirty = true;
      return inc;
    }
    return cur;
  };

  const merged: MediaItem = {
    ...existing,
    contentType: pick(existing.contentType, item.contentType),
    size: pick(existing.size, item.size),
    acceptRanges: pick(existing.acceptRanges, item.acceptRanges),
    pageUrl: pick(existing.pageUrl, item.pageUrl),
    // 🔴 W4.3 — `detectPageUrl` IS DELIBERATELY ABSENT from this merge list. Don't "fix" this by
    // adding it: an earlier version did add it and adversarial review caught that as a BUG. The meaning of
    // this field is "the page URL at the time the media was FIRST detected" — filling it in late on the
    // merge branch means stamping page-A media with page-B's URL (the same media URL gets re-reported
    // after the user has navigated an SPA page). The sameDocument gate would then turn around and
    // CONFIRM the wrong thing, which is worse than having no gate at all.
    // Missing the stamp closes the gate and we fall back to a name derived from the URL — better a missing name than a WRONG one.
    title: pick(existing.title, item.title),
    width: pick(existing.width, item.width),
    height: pick(existing.height, item.height),
    durationSec: pick(existing.durationSec, item.durationSec),
    // 🔴 W2.1 — MUST be present in this merge list. `onBeforeRequest` creates the item FIRST,
    // `onSendHeaders` captures the headers LATER, so headers ALWAYS arrive on the merge branch, never on
    // the add-new branch. Without this line, `{...existing}` swallows the captured snapshot and `dirty`
    // never gets set -> changed=false -> addTabMedia writes nothing -> W2.1 dies 100% with zero errors surfacing.
    sentHeaders: pick(existing.sentHeaders, item.sentHeaders),
  };

  if (!dirty) return { list, changed: false };
  const next = list.slice();
  next[idx] = merged;
  return { list: next, changed: true };
}

/**
 * W4.2 — mark items as CHILD playlists of `parentUrl` (hidden from the popup).
 *
 * Called right after a master finishes parsing: `childUrls` is the result of `childUrlsOfMaster()`.
 * Idempotent (marking again changes nothing) and does NOT mutate the original list/items.
 *
 * `changed: false` when there's nothing to mark -> the caller should skip writing to storage: an
 * unnecessary write would fire `storage.onChanged` -> the popup re-renders for nothing.
 */
export function markChildren(
  list: MediaItem[],
  childUrls: readonly string[],
  parentUrl: string,
): { list: MediaItem[]; changed: boolean } {
  const set = new Set(childUrls);
  let changed = false;
  const next = list.map((m) => {
    // A master is NEVER its own child (defensive, even though childUrlsOfMaster already excludes it).
    if (m.child || m.url === parentUrl || !set.has(m.url)) return m;
    changed = true;
    return { ...m, child: true, parentUrl };
  });
  return changed ? { list: next, changed } : { list, changed: false };
}

/** Items shown in the popup: exclude child playlists of an already-parsed master (W4.2). */
export function visibleMedia(list: MediaItem[]): MediaItem[] {
  return list.filter((m) => !m.child);
}
