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

/**
 * Chốt một `VariantInfo.id` duy nhất.
 *
 * `preferred` là danh tính tự nhiên của định dạng (DASH: `Representation@id` qua `attributes.NAME`).
 * Nó KHÔNG chắc duy nhất — DASH chỉ đòi id duy nhất trong một AdaptationSet, nên hai AdaptationSet
 * vẫn có thể cùng khai `id="1"`. Đụng nhau thì chốt bằng chỉ số.
 *
 * ⚠️ Phải soi lại BẰNG VÒNG LẶP, không phải một phép thử: `@id` do người đóng gói đặt và ISO
 * 23009-1 §5.3.5.2 chỉ cấm khoảng trắng, nên một representation hoàn toàn có thể tên sẵn là
 * `"a#2"` — đúng dạng ta sinh ra. Thử một lần rồi tin là đủ sẽ trả về id TRÙNG, tái lập đúng con
 * bug "bấm một dòng sáng cả cụm" mà gói này sinh ra để diệt. Vòng lặp luôn dừng: mỗi lượt nối
 * thêm một '#' nên chuỗi dài ra, không thể quay lại giá trị đã có trong `used`.
 */
export function uniqueVariantId(
  preferred: string | undefined,
  index: number,
  used: Set<string>,
): string {
  const base = preferred?.trim() ? preferred.trim() : `v${index}`;
  let id = base;
  while (used.has(id)) id = `${id}#${index}`;
  used.add(id);
  return id;
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
function flattenGroups(
  groups: RawGroups,
  manifestUrl: string,
): RenditionInfo[] {
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
 * Chọn trong ĐÚNG group mà variant trỏ tới (`AUDIO=`), theo thứ tự RFC 8216 §4.3.4.1.1:
 * `DEFAULT=YES` -> `AUTOSELECT=YES` -> cái đầu group.
 * ⚠️ Phải tra qua group của CHÍNH variant: X cấp mỗi tier hình một group tiếng riêng
 * (`audio-128000`/`64000`/`32000`), lấy `#EXT-X-MEDIA` đầu tiên sẽ ghép tiếng 128k vào hình 480x270.
 * ⚠️ Bậc `AUTOSELECT` KHÔNG thừa: bỏ nó thì group có `Commentary` (AUTOSELECT=NO, có URI) đứng
 * TRƯỚC `Main` (AUTOSELECT=YES, không URI) sẽ chọn trúng tiếng bình luận — file ra hình đúng,
 * tiếng SAI HOÀN TOÀN, không một cảnh báo. Thứ tự khai trong manifest không được quyết định thay ta.
 * ⚠️ Bậc cuối "lấy cái đầu" cũng KHÔNG thừa: Twitter/X không khai `DEFAULT` bao giờ (đã đo trên
 * manifest thật) -> chỉ dựa vào DEFAULT sẽ chọn TRƯỢT và câm y cũ.
 */
function renditionsForVariant(
  all: RenditionInfo[],
  groupId: string | undefined,
  variantUri: string,
): RenditionInfo[] | undefined {
  if (all.length === 0) return undefined;
  const copies = all.map((r) => ({ ...r }));
  if (groupId === undefined) return copies;
  const mine = copies.filter((r) => r.groupId === groupId);
  const chosen =
    mine.find((r) => r.default) ?? mine.find((r) => r.autoselect) ?? mine[0];
  // ⚠️ Variant AUDIO-ONLY: uri của nó CHÍNH LÀ playlist tiếng (HLS Authoring Spec §2.3 bắt buộc
  // master có một rendition audio-only; Apple/Shaka/Bento4/MediaConvert đều phát). Chọn nó nghĩa là
  // tải CÙNG một playlist hai lần rồi ép `-map 0:v:0` lên một input KHÔNG có hình -> ffmpeg mã 234,
  // job lỗi cứng. Mà trước W1.1 chính variant đó tải được (ra file chỉ-tiếng hợp lệ). Không chọn gì
  // ở đây = trả về đường một-input đã chứng minh chạy, và hết tải đôi.
  if (chosen && chosen.uri !== variantUri) chosen.selected = true;
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
    const allAudio = flattenGroups(
      manifest.mediaGroups?.AUDIO ?? {},
      manifestUrl,
    );

    const usedIds = new Set<string>();
    const variants: VariantInfo[] = playlists.map((p, index) => {
      const attr = p.attributes ?? {};
      const res = attr.RESOLUTION;
      const bandwidth = attr.BANDWIDTH ?? attr['AVERAGE-BANDWIDTH'];
      const uri = resolveUri(p.uri, manifestUrl);
      const audioRenditions = renditionsForVariant(allAudio, attr.AUDIO, uri);
      return {
        // Master HLS không có danh tính tự nhiên -> chỉ số là thứ duy nhất chắc chắn phân biệt được.
        id: uniqueVariantId(undefined, index, usedIds),
        uri,
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
    variants: [{ id: 'v0', uri: manifestUrl, name: 'Gốc' }],
    segmentCount: segments.length,
    keyMethod,
    isProtected: keyMethod === 'SAMPLE-AES',
  };
}

/**
 * Mọi URL playlist CON mà một master khai ra: variant hình + rendition tiếng (đã resolve tuyệt đối).
 *
 * Dùng cho W4.2: player fetch cả master lẫn con, webRequest thấy hết, nên một video hiện thành
 * nhiều dòng "HLS" giống hệt nhau trong popup. Biết tập con này thì ẩn được chúng đi.
 *
 * ⚠️ Guard `isMaster` KHÔNG thừa: parse một MEDIA playlist trả về `variants: [{ uri: manifestUrl }]`
 * — tức CHÍNH NÓ. Bỏ guard thì mỗi playlist con tự khai mình là con của chính mình rồi tự ẩn ->
 * site nào phát thẳng media playlist (không master) sẽ có popup TRỐNG TRƠN.
 * ⚠️ Dedupe bằng Set là BẮT BUỘC: `audioRenditions` mang rendition của MỌI group ở MỌI variant
 * (thiết kế §3.2), nên cùng một URL tiếng xuất hiện lặp ở mỗi variant.
 */
export function childUrlsOfMaster(parsed: HlsParseResult): string[] {
  if (!parsed.isMaster) return [];
  const out = new Set<string>();
  for (const v of parsed.variants) {
    out.add(v.uri);
    // Rendition không có `uri` = tiếng nằm sẵn trong variant (RFC 8216 §4.3.4.2.1) -> không có
    // URL riêng nào để ẩn. Nặn ra một cái ở đây sẽ ẩn nhầm chính master.
    for (const r of v.audioRenditions ?? []) if (r.uri) out.add(r.uri);
  }
  return [...out];
}

// --- G5: phân tích segment để tải & giải mã ---

export type HlsEncryption = 'none' | 'aes-128' | 'sample-aes' | 'other';

/** Một đoạn byte trong file lớn. `offset` luôn TUYỆT ĐỐI (byte đầu tiên, tính từ 0). */
export interface HlsByteRange {
  length: number;
  offset: number;
}

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
  /**
   * Đoạn byte của segment trong file lớn (#EXT-X-BYTERANGE). Có mặt = MỌI segment thường trỏ
   * CÙNG một `uri`, chỉ khác đoạn -> tầng fetch BẮT BUỘC gửi header `Range`, nếu không sẽ tải
   * nguyên file lớn một lần cho MỖI segment (đo thật: Apple fMP4 = 27MB x 101 lần).
   */
  byterange?: HlsByteRange;
  /** Đoạn byte của init segment (#EXT-X-MAP BYTERANGE). Xem chú thích ở mapper. */
  initByterange?: HlsByteRange;
}

export interface HlsSegmentsResult {
  segments: HlsSegment[];
  encryption: HlsEncryption;
  /** true nếu nội dung được bảo vệ (SAMPLE-AES/EME) -> KHÔNG hỗ trợ, phải DỪNG. */
  isProtected: boolean;
  totalDuration: number;
  /** có init segment fMP4 không. */
  hasInit: boolean;
  /**
   * W1.5 — playlist parse được nhưng ta CỐ Ý không tải: nêu lý do người thường hiểu được.
   *
   * Khác `isProtected` (ranh giới DRM) ở chỗ đây là giới hạn kỹ thuật của ta, và khác "0 segment"
   * ở chỗ nó nói ĐÚNG nguyên nhân. Sinh ra vì DASH đa Period ghép mù sẽ ra file hỏng mà ffmpeg
   * vẫn nhận -> job báo "xong" trong khi file sai. Giao file hỏng im lặng tệ hơn từ chối thẳng.
   */
  unsupportedReason?: string;
  /**
   * W1.5 — không có segment nào NHƯNG có một file media tải thẳng được (DASH SegmentBase: cả
   * representation chỉ là một .mp4 + indexRange). Tầng trên định tuyến sang luồng progressive.
   */
  directUrl?: string;
}

/**
 * W2.3 — MỘT url đại diện cho MỖI host xuất hiện trong danh sách segment (segment.uri, keyUri,
 * initUri). Background dùng để bật spoof Referer/Origin cho MỌI host TRƯỚC khi tải.
 *
 * Vì sao cần: §2.4 — segment rất hay ở CDN khác host với playlist, và key AES gần như LUÔN ở host
 * khác, lại là thứ hay kiểm Referer nhất. Chỉ spoof host playlist thì job tới 'fetching' rồi mọi
 * segment/key 403 -> "Tải segment lỗi sau 4 lần thử: HTTP 403". Trả một url/host (không phải cả
 * host trần) để applySpoof dựng được Referer, và để không nở rule theo số segment.
 */
export function spoofTargetsFromSegments(segments: HlsSegment[]): string[] {
  const byHost = new Map<string, string>();
  const add = (url?: string): void => {
    if (!url) return;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    if (!byHost.has(host)) byHost.set(host, url);
  };
  for (const s of segments) {
    add(s.uri);
    add(s.keyUri);
    add(s.initUri);
  }
  return [...byHost.values()];
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
    // W1.3 — HAI luật byterange KHÁC NHAU, đừng gộp làm một (đã đo thật ở m3u8-parser@7.2.0):
    //  - segment: parser ĐÃ cộng dồn offset thành TUYỆT ĐỐI (thiếu `@offset` = nối tiếp segment
    //    trước). Cộng dồn thêm lần nữa = nhân đôi offset = đọc sai chỗ.
    //  - #EXT-X-MAP: KHÔNG cộng dồn, và thiếu `@offset` thì key `offset` VẮNG HẲN. RFC 8216
    //    §4.3.2.5: vắng `@offset` nghĩa là bắt đầu từ byte 0 — KHÔNG phải nối tiếp gì cả.
    const br = s.byterange;
    const mapBr = s.map?.byterange;
    return {
      uri: resolveUri(s.uri, manifestUrl),
      duration: typeof s.duration === 'number' ? s.duration : 0,
      seq: baseSeq + i,
      keyMethod: key?.method,
      keyUri: key?.uri ? resolveUri(key.uri, manifestUrl) : undefined,
      iv: ivToBytes(key?.iv),
      initUri: s.map?.uri ? resolveUri(s.map.uri, manifestUrl) : undefined,
      ...(br ? { byterange: { length: br.length, offset: br.offset } } : {}),
      ...(mapBr
        ? { initByterange: { length: mapBr.length, offset: mapBr.offset ?? 0 } }
        : {}),
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
