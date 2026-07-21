// Minimal type declarations for m3u8-parser and mpd-parser (2 packages that do NOT ship a .d.ts).
// Only declares the fields the project uses; everything else falls to the `unknown` index signature.

declare module 'm3u8-parser' {
  export interface M3u8Attributes {
    BANDWIDTH?: number;
    'AVERAGE-BANDWIDTH'?: number;
    RESOLUTION?: { width: number; height: number };
    CODECS?: string;
    NAME?: string;
    /** GROUP-ID of the separate audio group this variant uses (points into mediaGroups.AUDIO). */
    AUDIO?: string;
    /** GROUP-ID of the subtitle group (points into mediaGroups.SUBTITLES). */
    SUBTITLES?: string;
    [key: string]: unknown;
  }

  /** A rendition declared via #EXT-X-MEDIA. */
  export interface M3u8Rendition {
    default?: boolean;
    autoselect?: boolean;
    language?: string;
    /**
     * ⚠️ COMPLETELY ABSENT (not undefined) when #EXT-X-MEDIA declares no URI — actually measured on
     * m3u8-parser@7.2.0. Per RFC 8216 §4.3.4.2.1 this means the stream is already present in every variant.
     * ⚠️ VERBATIM from the manifest: the parser does NOT resolve it, resolveUri must be called manually.
     */
    uri?: string;
    [key: string]: unknown;
  }

  /** mediaGroups[TYPE][GROUP-ID][NAME] — ⚠️ the key within a group is NAME, not id. */
  export interface M3u8MediaGroups {
    AUDIO?: Record<string, Record<string, M3u8Rendition>>;
    SUBTITLES?: Record<string, Record<string, M3u8Rendition>>;
    [key: string]: unknown;
  }

  export interface M3u8Key {
    method?: string;
    uri?: string;
    /** 16-byte IV, m3u8-parser returns it as a Uint32Array (4 x uint32). */
    iv?: Uint32Array;
    [key: string]: unknown;
  }

  /**
   * Byterange of a SEGMENT (#EXT-X-BYTERANGE).
   * ⚠️ m3u8-parser has ALREADY accumulated `offset` into an ABSOLUTE value (missing `@offset` =
   * continues from the previous segment) -> don't accumulate it again, it will double.
   */
  export interface M3u8ByteRange {
    length: number;
    offset: number;
  }

  /**
   * Byterange of #EXT-X-MAP — a COMPLETELY DIFFERENT rule from segments (actually measured):
   * NOT accumulated, and when `@offset` is missing the `offset` key is **COMPLETELY ABSENT** (not defaulted to 0).
   * Per RFC 8216 §4.3.2.5, an absent `@offset` means starting at byte 0.
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
    /** W1.4 — ONLY present when = true (the parser never writes `false`). */
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
     * W1.4 — INDEX into the `segments` array (not a media sequence). ACTUALLY MEASURED: the index
     * can REPEAT when two DISCONTINUITY tags sit right next to each other, and can be 0 when the tag precedes the first segment.
     */
    discontinuityStarts?: number[];
    /** Number of discontinuities BEFORE this playlist window — NOT the count of boundaries inside it. */
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

  /** A byte range — same shape as HLS: `offset` is the first byte (0-based). */
  export interface MpdByteRange {
    length: number;
    offset: number;
  }

  /**
   * A DASH segment already built by mpd-parser.
   * ⚠️ `map` is the init segment and mpd-parser attaches it to EVERY segment — for a multi-Period
   * MPD, each Period carries a DIFFERENT `map.resolvedUri` (measured, pinned in utils/dash.test.ts).
   */
  export interface MpdSegment {
    uri?: string;
    resolvedUri?: string;
    duration?: number;
    /** mpd-parser marks the FIRST segment of every Period after the first one. */
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
    /** Absolute, already-resolved URL (filled in by mpd-parser). */
    resolvedUri?: string;
    attributes?: MpdAttributes;
    segments?: MpdSegment[];
    /**
     * Indexes of the segments that open a new Period, computed by mpd-parser when stitching multiple Periods.
     * 🔬 ACTUALLY MEASURED: this is the ALWAYS-present multi-Period signal — unlike `map.resolvedUri`,
     * which can be IDENTICAL across Periods when the init template interpolates to the same URI.
     */
    discontinuityStarts?: number[];
    [key: string]: unknown;
  }

  /** An audio AdaptationSet, laid out under mediaGroups.AUDIO[group][label]. */
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
