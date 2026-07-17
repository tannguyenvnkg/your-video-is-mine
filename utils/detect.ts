// Logic THUẦN phân loại media (không phụ thuộc chrome API) -> unit test được.
// HLS (.m3u8) là ưu tiên số 1 theo yêu cầu chủ dự án.

import type { MediaItem, MediaType, MediaDetectSource } from './types';

export interface DetectInput {
  url: string;
  contentType?: string | null;
}

// Đuôi file progressive: video tải trực tiếp.
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

// Đuôi file segment con của HLS/DASH -> KHÔNG phải media gốc, bỏ qua.
const SEGMENT_EXTS = new Set(['.ts', '.m4s', '.aac', '.vtt', '.m4a']);

// Content-Type nhận diện HLS.
const HLS_CONTENT_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/mpegurl',
  'vnd.apple.mpegurl',
]);

// Content-Type nhận diện DASH.
const DASH_CONTENT_TYPES = new Set(['application/dash+xml']);

// Content-Type của segment con -> bỏ qua.
const SEGMENT_CONTENT_TYPES = new Set(['video/mp2t', 'video/iso.segment']);

/** Lấy pathname (bỏ query/hash) từ URL, an toàn với URL không hợp lệ. */
export function getPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    // URL tương đối/không hợp lệ: cắt query & hash thủ công.
    const noHash = url.split('#', 1)[0] ?? url;
    return noHash.split('?', 1)[0] ?? noHash;
  }
}

/** Lấy đuôi file (kèm dấu chấm, lowercase) từ URL. '' nếu không có. */
export function getExtension(url: string): string {
  const path = getPathname(url);
  const slash = path.lastIndexOf('/');
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

/** Chuẩn hoá Content-Type: bỏ tham số sau ';', trim, lowercase. */
function normalizeContentType(ct?: string | null): string {
  return (ct ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

/** Segment con (init/.ts/.m4s...) -> không phải media gốc, cần bỏ qua. */
export function isLikelySegment(
  url: string,
  contentType?: string | null,
): boolean {
  const ext = getExtension(url);
  if (SEGMENT_EXTS.has(ext)) return true;
  if (SEGMENT_CONTENT_TYPES.has(normalizeContentType(contentType))) return true;
  // init segment fMP4: tên chứa 'init' (init.mp4, init-1.mp4, video_init.mp4...).
  const path = getPathname(url).toLowerCase();
  const file = path.slice(path.lastIndexOf('/') + 1);
  if (/(^|[._-])init([._-][^/]*)?\.(mp4|m4s)$/.test(file)) return true;
  return false;
}

/**
 * Phân loại media từ URL + Content-Type.
 * @returns MediaType hoặc null (không phải media, hoặc là segment con).
 */
export function classifyMedia(input: DetectInput): MediaType | null {
  // Segment con -> bỏ trước tiên.
  if (isLikelySegment(input.url, input.contentType)) return null;

  const ext = getExtension(input.url);
  const ct = normalizeContentType(input.contentType);

  // HLS ưu tiên số 1.
  if (ext === '.m3u8' || HLS_CONTENT_TYPES.has(ct)) return 'hls';

  // DASH.
  if (ext === '.mpd' || DASH_CONTENT_TYPES.has(ct)) return 'dash';

  // Progressive: content-type video/* hoặc đuôi file quen thuộc.
  if (ct.startsWith('video/')) return 'progressive';
  if (PROGRESSIVE_EXTS.has(ext)) return 'progressive';

  return null;
}

/** Hash chuỗi ổn định (FNV-1a 32-bit) -> id ngắn cho media. */
export function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 để thành unsigned; base36 cho gọn.
  return (h >>> 0).toString(36);
}

export function mediaId(url: string): string {
  return stableHash(url);
}

/** Rút gọn URL để hiển thị (giữ đầu + đuôi, chèn '…' ở giữa). */
export function shortenUrl(url: string, max = 60): string {
  if (url.length <= max) return url;
  const budget = max - 1; // trừ ký tự '…'
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
}

/** Dựng MediaItem từ một lần phát hiện. null nếu không phải media. */
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
  };
}

/**
 * Thêm/bổ sung media theo url:
 * - Chưa có url -> thêm mới.
 * - Đã có url -> MERGE các field còn thiếu (contentType/size/acceptRanges/pageUrl/title/...)
 *   từ bản phát hiện mới (vd onBeforeRequest thêm trước, onHeadersReceived bổ sung header sau).
 * @returns list (mới nếu thay đổi, cũ nếu không) + cờ changed.
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
  // Chỉ điền khi field cũ trống và field mới có giá trị (không ghi đè dữ liệu đã biết).
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
    title: pick(existing.title, item.title),
    width: pick(existing.width, item.width),
    height: pick(existing.height, item.height),
    durationSec: pick(existing.durationSec, item.durationSec),
  };

  if (!dirty) return { list, changed: false };
  const next = list.slice();
  next[idx] = merged;
  return { list: next, changed: true };
}

/**
 * W4.2 — đánh dấu các item là playlist CON của `parentUrl` (ẩn khỏi popup).
 *
 * Gọi khi vừa parse xong một master: `childUrls` là kết quả `childUrlsOfMaster()`.
 * Idempotent (đánh dấu lại không đổi gì) và KHÔNG đột biến list/item gốc.
 *
 * `changed: false` khi không có gì để đánh -> caller đừng ghi storage: ghi thừa sẽ bắn
 * `storage.onChanged` -> popup render lại vô ích.
 */
export function markChildren(
  list: MediaItem[],
  childUrls: readonly string[],
  parentUrl: string,
): { list: MediaItem[]; changed: boolean } {
  const set = new Set(childUrls);
  let changed = false;
  const next = list.map((m) => {
    // Master KHÔNG bao giờ là con của chính nó (thủ sẵn, dù childUrlsOfMaster đã loại).
    if (m.child || m.url === parentUrl || !set.has(m.url)) return m;
    changed = true;
    return { ...m, child: true, parentUrl };
  });
  return changed ? { list: next, changed } : { list, changed: false };
}

/** Item hiện lên popup: bỏ playlist con của master đã parse (W4.2). */
export function visibleMedia(list: MediaItem[]): MediaItem[] {
  return list.filter((m) => !m.child);
}
