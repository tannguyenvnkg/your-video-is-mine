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
}
