// Parse HLS playlist (m3u8) THUẦN -> danh sách variant chất lượng + danh sách segment.
// Không phụ thuộc chrome API. Xử lý cả master playlist lẫn media playlist trực tiếp.

import { Parser, type M3u8Rendition, type M3u8Segment } from 'm3u8-parser';
import type { RenditionInfo, VariantInfo } from './types';

export interface HlsParseResult {
  isMaster: boolean;
  variants: VariantInfo[];
  segmentCount?: number;
  keyMethod?: string;
  isProtected?: boolean;
}

/** Resolve URL tương đối trong manifest thành tuyệt đối. */
export function resolveUri(uri: string, baseUrl: string): string {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}

/** Nhãn hiển thị cho variant: ưu tiên "<height>p", rồi "<kbps> kbps", cuối cùng "Gốc". */
export function variantLabel(height?: number, bandwidth?: number): string {
  if (height && height > 0) return `${height}p`;
  if (bandwidth && bandwidth > 0) return `${Math.round(bandwidth / 1000)} kbps`;
  return 'Gốc';
}

/** Sắp xếp variant giảm dần theo độ phân giải rồi bitrate (chất lượng cao lên đầu). */
export function sortVariantsDesc(variants: VariantInfo[]): void {
  variants.sort(
    (a, b) =>
      (b.height ?? 0) - (a.height ?? 0) ||
      (b.bandwidth ?? 0) - (a.bandwidth ?? 0),
  );
}

/** METHOD mã hoá đầu tiên khác 'NONE' trong danh sách segment. */
function firstKeyMethod(segments: M3u8Segment[]): string | undefined {
  for (const s of segments) {
    const method = s.key?.method;
    if (method && method !== 'NONE') return method;
  }
  return undefined;
}

type RawGroups = Record<string, Record<string, M3u8Rendition>>;

/** Dàn phẳng mediaGroups thành danh sách rendition (uri đã resolve tuyệt đối). */
function flattenGroups(groups: RawGroups, manifestUrl: string): RenditionInfo[] {
  const out: RenditionInfo[] = [];
  for (const [groupId, group] of Object.entries(groups)) {
    for (const [name, r] of Object.entries(group)) {
      out.push({
        groupId,
        name,
        // CHỈ resolve khi có uri thật: rendition không URI nghĩa là luồng nằm sẵn trong variant
        // (RFC 8216 §4.3.4.2.1). Resolve `undefined` sẽ nặn ra chính URL master -> URL BỊA.
        ...(r.uri ? { uri: resolveUri(r.uri, manifestUrl) } : {}),
        ...(r.language !== undefined ? { language: r.language } : {}),
        default: r.default === true,
        autoselect: r.autoselect === true,
      });
    }
  }
  return out;
}

/**
 * Danh sách rendition cho MỘT variant: bản sao của mọi rendition, cờ `selected` ở cái variant dùng.
 *
 * Chọn trong ĐÚNG group mà variant trỏ tới (`AUDIO=`), ưu tiên `DEFAULT=YES`, không có thì lấy cái
 * đầu group.
 * ⚠️ Fallback "lấy cái đầu" KHÔNG phải cho có: Twitter/X không khai `DEFAULT` bao giờ (đã đo trên
 * manifest thật) -> mọi rendition `default=false` -> chỉ dựa vào DEFAULT sẽ chọn TRƯỢT và câm y cũ.
 * ⚠️ Phải tra qua group của CHÍNH variant: X cấp mỗi tier hình một group tiếng riêng
 * (`audio-128000`/`64000`/`32000`), lấy `#EXT-X-MEDIA` đầu tiên sẽ ghép tiếng 128k vào hình 480x270.
 */
function renditionsForVariant(
  all: RenditionInfo[],
  groupId: string | undefined,
): RenditionInfo[] | undefined {
  if (all.length === 0) return undefined;
  const copies = all.map((r) => ({ ...r }));
  if (groupId === undefined) return copies;
  const mine = copies.filter((r) => r.groupId === groupId);
  const chosen = mine.find((r) => r.default) ?? mine[0];
  if (chosen) chosen.selected = true;
  return copies;
}

export function parseHlsManifest(
  text: string,
  manifestUrl: string,
): HlsParseResult {
  const parser = new Parser();
  parser.push(text);
  parser.end();
  const manifest = parser.manifest;

  const playlists = manifest.playlists ?? [];
  if (playlists.length > 0) {
    const allAudio = flattenGroups(manifest.mediaGroups?.AUDIO ?? {}, manifestUrl);

    const variants: VariantInfo[] = playlists.map((p) => {
      const attr = p.attributes ?? {};
      const res = attr.RESOLUTION;
      const bandwidth = attr.BANDWIDTH ?? attr['AVERAGE-BANDWIDTH'];
      const audioRenditions = renditionsForVariant(allAudio, attr.AUDIO);
      return {
        uri: resolveUri(p.uri, manifestUrl),
        name: variantLabel(res?.height, bandwidth),
        bandwidth,
        width: res?.width,
        height: res?.height,
        codecs: attr.CODECS,
        ...(audioRenditions ? { audioRenditions } : {}),
      };
    });
    sortVariantsDesc(variants);
    return { isMaster: true, variants };
  }

  const segments = manifest.segments ?? [];
  const keyMethod = firstKeyMethod(segments);
  return {
    isMaster: false,
    variants: [{ uri: manifestUrl, name: 'Gốc' }],
    segmentCount: segments.length,
    keyMethod,
    isProtected: keyMethod === 'SAMPLE-AES',
  };
}

// --- G5: phân tích segment để tải & giải mã ---

export type HlsEncryption = 'none' | 'aes-128' | 'sample-aes' | 'other';

export interface HlsSegment {
  /** URL tuyệt đối của segment (.ts/.m4s). */
  uri: string;
  /** thời lượng (giây). */
  duration: number;
  /** media sequence number (dùng làm IV mặc định khi #EXT-X-KEY không khai báo IV). */
  seq: number;
  keyMethod?: string;
  /** URL tuyệt đối của key. */
  keyUri?: string;
  /** IV 16 byte nếu khai báo tường minh trong #EXT-X-KEY. */
  iv?: Uint8Array;
  /** URL tuyệt đối của init segment (fMP4) nếu có #EXT-X-MAP. */
  initUri?: string;
}

export interface HlsSegmentsResult {
  segments: HlsSegment[];
  encryption: HlsEncryption;
  /** true nếu nội dung được bảo vệ (SAMPLE-AES/EME) -> KHÔNG hỗ trợ, phải DỪNG. */
  isProtected: boolean;
  totalDuration: number;
  /** có init segment fMP4 không. */
  hasInit: boolean;
}

/** Chuyển IV kiểu Uint32Array (m3u8-parser, 4 x uint32 big-endian) sang 16 byte. */
function ivToBytes(iv?: Uint32Array): Uint8Array | undefined {
  if (!iv || iv.length < 4) return undefined;
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 4; i++) view.setUint32(i * 4, iv[i]! >>> 0, false);
  return bytes;
}

/**
 * Từ một MEDIA playlist -> danh sách segment (uri tuyệt đối, thời lượng, key/IV, init).
 * Xác định kiểu mã hoá; SAMPLE-AES/khác AES-128 -> isProtected (DỪNG, không hỗ trợ).
 */
export function parseHlsSegments(
  text: string,
  manifestUrl: string,
): HlsSegmentsResult {
  const parser = new Parser();
  parser.push(text);
  parser.end();
  const manifest = parser.manifest;

  const raw = manifest.segments ?? [];
  const baseSeq =
    typeof manifest.mediaSequence === 'number' ? manifest.mediaSequence : 0;

  const segments: HlsSegment[] = raw.map((s, i) => {
    const key = s.key;
    return {
      uri: resolveUri(s.uri, manifestUrl),
      duration: typeof s.duration === 'number' ? s.duration : 0,
      seq: baseSeq + i,
      keyMethod: key?.method,
      keyUri: key?.uri ? resolveUri(key.uri, manifestUrl) : undefined,
      iv: ivToBytes(key?.iv),
      initUri: s.map?.uri ? resolveUri(s.map.uri, manifestUrl) : undefined,
    };
  });

  const method = firstKeyMethod(raw);
  const encryption: HlsEncryption =
    method === 'AES-128'
      ? 'aes-128'
      : method === 'SAMPLE-AES'
        ? 'sample-aes'
        : method
          ? 'other'
          : 'none';

  return {
    segments,
    encryption,
    // AES-128 giải mã được -> KHÔNG protected. SAMPLE-AES/khác (thường EME/DRM) -> protected.
    isProtected: encryption === 'sample-aes' || encryption === 'other',
    totalDuration: segments.reduce((sum, s) => sum + s.duration, 0),
    hasInit: segments.some((s) => s.initUri !== undefined),
  };
}
