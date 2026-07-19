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
  /**
   * Playlist CON của một master ĐÃ PARSE (variant hình hoặc rendition tiếng) -> ẩn khỏi popup (W4.2).
   *
   * VÌ SAO ẨN: webRequest thấy MỌI `.m3u8` mà player fetch, nên một video tách tiếng hiện ra ĐÚNG
   * 3 dòng cùng nhãn "HLS" (master + video.m3u8 + audio.m3u8 — đã đo trên Edge thật). Trước W1.1,
   * dòng tiếng là cách DUY NHẤT lấy được tiếng nên còn có lý do tồn tại; từ sau W1.1 offscreen tự
   * ghép tiếng vào, nên nó chỉ còn là rác: bấm vào ra "video" chỉ có tiếng. Dòng master vẫn cho
   * chọn đủ chất lượng nên KHÔNG mất chức năng nào.
   */
  child?: boolean;
  /** URL master đã khai ra item này (giải thích vì sao bị ẩn; dùng cho nhãn ở W4.4). */
  parentUrl?: string;
  /**
   * W2.1 — bản chụp header THẬT mà player của trang đã gửi cho chính URL này (`onSendHeaders`),
   * tên header đã hạ chữ thường. Dùng để PHÁT LẠI thay vì BỊA Referer/Origin (§2.11).
   *
   * Vắng = chưa quan sát được request nào của player cho URL này (vd media phát hiện qua DOM, hoặc
   * content script báo sau khi request đã bay) -> caller PHẢI lùi về đường spoof Referer cũ.
   * Lọc/chia rổ bằng `planHeaderReplay` (utils/headers.ts) — KHÔNG dùng thẳng map này.
   */
  sentHeaders?: Record<string, string>;
}

/**
 * Một luồng tách rời khai bằng `#EXT-X-MEDIA` (HLS mediaGroups) — tiếng hoặc phụ đề.
 *
 * VÌ SAO MANG CẢ DANH SÁCH thay vì một `audioUri` đã resolve: W4.4 (cho user chọn ngôn ngữ) cần
 * thấy MỌI lựa chọn. Mang sẵn từ W1.1 thì thêm picker sau KHÔNG phải đổi lại giao thức
 * `messages.ts` lần nữa.
 */
export interface RenditionInfo {
  /**
   * W1.5 — danh tính track khi `uri` KHÔNG phân biệt nổi (DASH: mọi track chung một `.mpd`).
   * HLS không có id tự nhiên nên bỏ trống và vẫn định danh bằng `uri` như cũ.
   */
  id?: string;
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
  /**
   * Danh tính DUY NHẤT trong một manifest. BẮT BUỘC — không được suy ra từ `uri`.
   *
   * Nhiều master cho MỌI variant chung một `uri`: Apple master trỏ 3 variant vào cùng playlist,
   * còn DASH SegmentTemplate thì `resolvedUri` của mọi Representation đều là chính file .mpd.
   * Key/chọn theo `uri` ở popup vì thế sinh trùng key React và bấm "720p" thì MỌI dòng cùng sáng.
   */
  id: string;
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
