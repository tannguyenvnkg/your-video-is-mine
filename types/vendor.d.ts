// Khai báo type tối thiểu cho m3u8-parser và mpd-parser (2 package KHÔNG kèm .d.ts).
// Chỉ khai báo các trường dự án dùng; phần còn lại để index signature `unknown`.

declare module 'm3u8-parser' {
  export interface M3u8Attributes {
    BANDWIDTH?: number;
    'AVERAGE-BANDWIDTH'?: number;
    RESOLUTION?: { width: number; height: number };
    CODECS?: string;
    NAME?: string;
    [key: string]: unknown;
  }

  export interface M3u8Key {
    method?: string;
    uri?: string;
    /** IV 16 byte, m3u8-parser trả về Uint32Array (4 x uint32). */
    iv?: Uint32Array;
    [key: string]: unknown;
  }

  export interface M3u8ByteRange {
    length: number;
    offset: number;
  }

  export interface M3u8Map {
    uri: string;
    key?: M3u8Key;
    byterange?: M3u8ByteRange;
  }

  export interface M3u8Segment {
    uri: string;
    duration?: number;
    key?: M3u8Key;
    map?: M3u8Map;
    byterange?: M3u8ByteRange;
    [key: string]: unknown;
  }

  export interface M3u8Playlist {
    uri: string;
    attributes?: M3u8Attributes;
    [key: string]: unknown;
  }

  export interface M3u8Manifest {
    playlists?: M3u8Playlist[];
    segments?: M3u8Segment[];
    mediaSequence?: number;
    targetDuration?: number;
    endList?: boolean;
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

  export interface MpdPlaylist {
    uri?: string;
    /** URL tuyệt đối đã resolve (mpd-parser điền sẵn). */
    resolvedUri?: string;
    attributes?: MpdAttributes;
    [key: string]: unknown;
  }

  export interface MpdManifest {
    playlists?: MpdPlaylist[];
    [key: string]: unknown;
  }

  export function parse(
    mpd: string,
    options?: { manifestUri?: string; [key: string]: unknown },
  ): MpdManifest;
}
