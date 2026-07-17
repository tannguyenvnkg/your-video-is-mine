// Kiểu dữ liệu media dùng chung giữa background / content / popup / offscreen.
// Dùng từ Giai đoạn 1 (phát hiện media) trở đi.

export type MediaType = 'hls' | 'dash' | 'progressive' | 'blob';

/** Cách phát hiện ra media. */
export type MediaDetectSource = 'network' | 'dom' | 'mse';

export interface MediaItem {
  /** id ổn định (hash từ url). */
  id: string;
  type: MediaType;
  /** URL gốc của manifest/media (đã resolve tuyệt đối). */
  url: string;
  /** tab phát hiện ra media. */
  tabId: number;
  /** URL trang chứa media (đặt tên file, hiển thị). */
  pageUrl?: string;
  /** tiêu đề trang. */
  title?: string;
  contentType?: string;
  /** kích thước (byte) nếu biết từ Content-Length. */
  size?: number;
  /** server hỗ trợ range request (gợi ý progressive tải được). */
  acceptRanges?: boolean;
  /** epoch ms lúc phát hiện. */
  detectedAt: number;
  /** cách phát hiện (network / dom / mse). */
  detectSource?: MediaDetectSource;
  /** độ phân giải nếu biết (điền ở G2 khi parse manifest). */
  width?: number;
  height?: number;
  /** thời lượng (giây) nếu biết. */
  durationSec?: number;
  /**
   * Nghi ngờ nội dung được bảo vệ (DRM/EME hoặc SAMPLE-AES qua EME).
   * true -> KHÔNG cho tải (điền ở G5). Ranh giới cứng theo §7 lộ trình.
   */
  protected?: boolean;
}

/**
 * Một luồng tách rời khai bằng `#EXT-X-MEDIA` (HLS mediaGroups) — tiếng hoặc phụ đề.
 *
 * VÌ SAO MANG CẢ DANH SÁCH thay vì một `audioUri` đã resolve: W4.4 (cho user chọn ngôn ngữ) cần
 * thấy MỌI lựa chọn. Mang sẵn từ W1.1 thì thêm picker sau KHÔNG phải đổi lại giao thức
 * `messages.ts` lần nữa.
 */
export interface RenditionInfo {
  /** GROUP-ID của `#EXT-X-MEDIA`; variant trỏ tới group qua `AUDIO=` / `SUBTITLES=`. */
  groupId: string;
  /** NAME — key trong group, cũng là nhãn hiển thị cho user. */
  name: string;
  /**
   * URL tuyệt đối của playlist rendition.
   *
   * VẮNG khi `#EXT-X-MEDIA` không khai URI. Theo RFC 8216 §4.3.4.2.1 điều đó nghĩa là luồng này
   * ĐÃ nằm sẵn trong variant -> KHÔNG có gì để tải riêng -> giữ nguyên đường một-input.
   */
  uri?: string;
  language?: string;
  default: boolean;
  autoselect: boolean;
  /**
   * true ở ĐÚNG MỘT rendition của danh sách: cái mà variant này THẬT SỰ dùng.
   * (`selected` mà `uri` vắng = luồng nằm sẵn trong variant, không cần tải riêng.)
   */
  selected?: boolean;
}

/** Một mức chất lượng (variant HLS / representation DASH) để user chọn (G2). */
export interface VariantInfo {
  /** URL tuyệt đối của media playlist / representation. */
  uri: string;
  /** nhãn hiển thị, vd "720p" hoặc "800 kbps". */
  name: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  /**
   * Luồng tiếng tách rời (`#EXT-X-MEDIA:TYPE=AUDIO`) của MỌI group trong master, cờ `selected` ở
   * cái variant này dùng. Vắng = master không khai tiếng tách rời -> tiếng nằm trong variant.
   *
   * Bỏ qua trường này chính là bệnh CÂM (§2.1): dữ liệu nằm sẵn trong manifest và bị vứt đi.
   */
  audioRenditions?: RenditionInfo[];
}
