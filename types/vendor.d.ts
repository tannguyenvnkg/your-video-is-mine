// Khai báo type tối thiểu cho m3u8-parser và mpd-parser (2 package KHÔNG kèm .d.ts).
// Chỉ khai báo các trường dự án dùng; phần còn lại để index signature `unknown`.

declare module 'm3u8-parser' {
  export interface M3u8Attributes {
    BANDWIDTH?: number;
    'AVERAGE-BANDWIDTH'?: number;
    RESOLUTION?: { width: number; height: number };
    CODECS?: string;
    NAME?: string;
    /** GROUP-ID của nhóm tiếng tách rời mà variant này dùng (trỏ vào mediaGroups.AUDIO). */
    AUDIO?: string;
    /** GROUP-ID của nhóm phụ đề (trỏ vào mediaGroups.SUBTITLES). */
    SUBTITLES?: string;
    [key: string]: unknown;
  }

  /** Một rendition khai bằng #EXT-X-MEDIA. */
  export interface M3u8Rendition {
    default?: boolean;
    autoselect?: boolean;
    language?: string;
    /**
     * ⚠️ VẮNG HẲN (không phải undefined) khi #EXT-X-MEDIA không khai URI — đã đo thật ở
     * m3u8-parser@7.2.0. Theo RFC 8216 §4.3.4.2.1 nghĩa là luồng nằm sẵn trong mọi variant.
     * ⚠️ NGUYÊN VĂN manifest: parser KHÔNG resolve, phải tự resolveUri.
     */
    uri?: string;
    [key: string]: unknown;
  }

  /** mediaGroups[TYPE][GROUP-ID][NAME] — ⚠️ key trong group là NAME, không phải id. */
  export interface M3u8MediaGroups {
    AUDIO?: Record<string, Record<string, M3u8Rendition>>;
    SUBTITLES?: Record<string, Record<string, M3u8Rendition>>;
    [key: string]: unknown;
  }

  export interface M3u8Key {
    method?: string;
    uri?: string;
    /** IV 16 byte, m3u8-parser trả về Uint32Array (4 x uint32). */
    iv?: Uint32Array;
    [key: string]: unknown;
  }

  /**
   * Byterange của SEGMENT (#EXT-X-BYTERANGE).
   * ⚠️ m3u8-parser ĐÃ cộng dồn `offset` thành TUYỆT ĐỐI (thiếu `@offset` = nối tiếp segment trước)
   * -> đừng cộng dồn lần nữa, sẽ nhân đôi.
   */
  export interface M3u8ByteRange {
    length: number;
    offset: number;
  }

  /**
   * Byterange của #EXT-X-MAP — LUẬT KHÁC hẳn segment (đã đo thật):
   * KHÔNG cộng dồn, và thiếu `@offset` thì key `offset` **VẮNG HẲN** (không mặc định 0).
   * Theo RFC 8216 §4.3.2.5, vắng `@offset` nghĩa là bắt đầu từ byte 0.
   */
  export interface M3u8MapByteRange {
    length: number;
    offset?: number;
  }

  export interface M3u8Map {
    uri: string;
    key?: M3u8Key;
    byterange?: M3u8MapByteRange;
  }

  export interface M3u8Segment {
    uri: string;
    duration?: number;
    key?: M3u8Key;
    map?: M3u8Map;
    byterange?: M3u8ByteRange;
    /** W1.4 — CHỈ có mặt khi = true (parser không ghi `false`). */
    discontinuity?: boolean;
    [key: string]: unknown;
  }

  export interface M3u8Playlist {
    uri: string;
    attributes?: M3u8Attributes;
    [key: string]: unknown;
  }

  export interface M3u8Manifest {
    playlists?: M3u8Playlist[];
    mediaGroups?: M3u8MediaGroups;
    segments?: M3u8Segment[];
    mediaSequence?: number;
    targetDuration?: number;
    endList?: boolean;
    /**
     * W1.4 — CHỈ SỐ MẢNG `segments` (không phải media sequence). ĐO THẬT: chỉ số có thể LẶP khi
     * hai tag DISCONTINUITY đứng liền nhau, và có thể là 0 khi tag đứng trước segment đầu.
     */
    discontinuityStarts?: number[];
    /** Số lần đứt TRƯỚC cửa sổ playlist này — KHÔNG phải số chỗ nối bên trong nó. */
    discontinuitySequence?: number;
    [key: string]: unknown;
  }

  export class Parser {
    manifest: M3u8Manifest;
    push(chunk: string): void;
    end(): void;
  }
}

declare module 'mpd-parser' {
  export interface MpdAttributes {
    BANDWIDTH?: number;
    RESOLUTION?: { width: number; height: number };
    CODECS?: string;
    NAME?: string;
    [key: string]: unknown;
  }

  /** Đoạn byte — cùng shape với HLS: `offset` là byte đầu tiên (tính từ 0). */
  export interface MpdByteRange {
    length: number;
    offset: number;
  }

  /**
   * Một segment DASH đã được mpd-parser dựng sẵn.
   * ⚠️ `map` là init segment và mpd-parser gắn nó vào TỪNG segment — với MPD đa Period, mỗi
   * Period mang `map.resolvedUri` KHÁC nhau (đã đo, ghim ở utils/dash.test.ts).
   */
  export interface MpdSegment {
    uri?: string;
    resolvedUri?: string;
    duration?: number;
    /** mpd-parser đánh dấu segment ĐẦU của mỗi Period sau Period đầu tiên. */
    discontinuity?: boolean;
    byterange?: MpdByteRange;
    map?: {
      uri?: string;
      resolvedUri?: string;
      byterange?: MpdByteRange;
    };
    [key: string]: unknown;
  }

  export interface MpdPlaylist {
    uri?: string;
    /** URL tuyệt đối đã resolve (mpd-parser điền sẵn). */
    resolvedUri?: string;
    attributes?: MpdAttributes;
    segments?: MpdSegment[];
    /**
     * Chỉ số các segment mở đầu một Period mới, do mpd-parser tính khi khâu nhiều Period.
     * 🔬 ĐÃ ĐO: đây là tín hiệu đa-Period LUÔN có mặt — khác `map.resolvedUri`, thứ có thể GIỐNG
     * nhau giữa các Period khi template init nội suy ra cùng một URI.
     */
    discontinuityStarts?: number[];
    [key: string]: unknown;
  }

  /** Một AdaptationSet tiếng, đã dàn theo mediaGroups.AUDIO[group][label]. */
  export interface MpdAudioRendition {
    language?: string;
    default?: boolean;
    autoselect?: boolean;
    playlists?: MpdPlaylist[];
    [key: string]: unknown;
  }

  export interface MpdMediaGroups {
    AUDIO?: Record<string, Record<string, MpdAudioRendition>>;
    [key: string]: unknown;
  }

  export interface MpdManifest {
    playlists?: MpdPlaylist[];
    mediaGroups?: MpdMediaGroups;
    [key: string]: unknown;
  }

  export function parse(
    mpd: string,
    options?: { manifestUri?: string; [key: string]: unknown },
  ): MpdManifest;
}
