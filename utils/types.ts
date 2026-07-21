// Media data types shared between background / content / popup / offscreen.
// Used from Stage 1 (media detection) onward.

export type MediaType = 'hls' | 'dash' | 'progressive' | 'blob';

/** How the media was detected. */
export type MediaDetectSource = 'network' | 'dom' | 'mse';

export interface MediaItem {
  /** stable id (hash of the url). */
  id: string;
  type: MediaType;
  /** original URL of the manifest/media (resolved to absolute). */
  url: string;
  /** tab that detected the media. */
  tabId: number;
  /** URL of the page containing the media (for filename, display). */
  pageUrl?: string;
  /**
   * W4.3 — page URL AT THE MOMENT OF DETECTION, stamped by `addTabMedia` from `TabMediaState.navUrl`.
   *
   * Deliberately SEPARATED from `pageUrl`: `pageUrl` is the source used to build the Referer for
   * bypassing 403s (W2.1/W2.4), touching it means touching a network layer that's already been
   * carefully measured. This field is ONLY for filenames — compared against the page's current
   * URL at download time to know whether the media still belongs to the open page (SPA video change).
   */
  detectPageUrl?: string;
  /** page title. */
  title?: string;
  contentType?: string;
  /** size (bytes) if known from Content-Length. */
  size?: number;
  /** server supports range requests (hint that progressive download is possible). */
  acceptRanges?: boolean;
  /** epoch ms at detection time. */
  detectedAt: number;
  /** detection method (network / dom / mse). */
  detectSource?: MediaDetectSource;
  /** resolution if known (filled in at G2 when parsing the manifest). */
  width?: number;
  height?: number;
  /** duration (seconds) if known. */
  durationSec?: number;
  /**
   * Suspected protected content (DRM/EME or SAMPLE-AES via EME).
   * true -> download NOT allowed (filled in at G5). Hard boundary per roadmap §7.
   */
  protected?: boolean;
  /**
   * CHILD playlist of an ALREADY-PARSED master (video variant or audio rendition) -> hidden from
   * the popup (W4.2).
   *
   * WHY HIDDEN: webRequest sees EVERY `.m3u8` the player fetches, so a video with a separate
   * audio track shows up as EXACTLY 3 rows all labeled "HLS" (master + video.m3u8 + audio.m3u8 —
   * measured on real Edge). Before W1.1, the audio row was the ONLY way to get audio so it had a
   * reason to exist; since W1.1 offscreen muxes the audio in itself, so it's now just clutter:
   * clicking it produces a "video" that's audio-only. The master row still lets users pick full
   * quality so NO functionality is lost.
   */
  child?: boolean;
  /** URL of the master that declared this item (explains why it's hidden; used for the label at W4.4). */
  parentUrl?: string;
  /**
   * W2.1 — snapshot of the REAL headers the page's player sent for this exact URL
   * (`onSendHeaders`), header names lowercased. Used to REPLAY instead of FABRICATING
   * Referer/Origin (§2.11).
   *
   * Absent = no request from the player was ever observed for this URL (e.g. media detected via
   * DOM, or the content script reported it after the request had already gone out) -> the caller
   * MUST fall back to the old Referer-spoofing path. Filter/bucket using `planHeaderReplay`
   * (utils/headers.ts) — do NOT use this map directly.
   */
  sentHeaders?: Record<string, string>;
}

/**
 * A separate stream declared via `#EXT-X-MEDIA` (HLS mediaGroups) — audio or subtitles.
 *
 * WHY CARRY THE WHOLE LIST instead of one resolved `audioUri`: W4.4 (letting the user pick a
 * language) needs to see EVERY option. Carrying it since W1.1 means adding the picker later does
 * NOT require changing the `messages.ts` protocol again.
 */
export interface RenditionInfo {
  /**
   * W1.5 — track identity for when `uri` CANNOT distinguish tracks (DASH: every track shares one
   * `.mpd`). HLS has no natural id so this is left blank and identity is still keyed on `uri` as before.
   */
  id?: string;
  /** GROUP-ID from `#EXT-X-MEDIA`; a variant points to a group via `AUDIO=` / `SUBTITLES=`. */
  groupId: string;
  /** NAME — the key within the group, also the label shown to the user. */
  name: string;
  /**
   * Absolute URL of the rendition playlist.
   *
   * ABSENT when `#EXT-X-MEDIA` doesn't declare a URI. Per RFC 8216 §4.3.4.2.1 that means this
   * stream is ALREADY embedded in the variant -> nothing to download separately -> keep the
   * existing single-input path.
   */
  uri?: string;
  language?: string;
  default: boolean;
  autoselect: boolean;
  /**
   * true on EXACTLY ONE rendition in the list: the one this variant ACTUALLY uses.
   * (`selected` with `uri` absent = the stream is already embedded in the variant, nothing to
   * download separately.)
   */
  selected?: boolean;
}

/** A quality level (HLS variant / DASH representation) for the user to choose (G2). */
export interface VariantInfo {
  /**
   * UNIQUE identity within one manifest. REQUIRED — must not be inferred from `uri`.
   *
   * Many masters give EVERY variant the same `uri`: an Apple master points 3 variants at the same
   * playlist, and for DASH SegmentTemplate every Representation's `resolvedUri` is the .mpd file
   * itself. Keying/selecting by `uri` in the popup therefore produces duplicate React keys, and
   * clicking "720p" lights up EVERY row at once.
   */
  id: string;
  /** absolute URL of the media playlist / representation. */
  uri: string;
  /** display label, e.g. "720p" or "800 kbps". */
  name: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  /**
   * Separate audio stream (`#EXT-X-MEDIA:TYPE=AUDIO`) from EVERY group in the master, using the
   * `selected` flag this variant uses. Absent = the master declares no separate audio -> audio is
   * embedded in the variant.
   *
   * Dropping this field is exactly the SILENT bug pattern (§2.1): the data is right there in the
   * manifest and gets thrown away.
   */
  audioRenditions?: RenditionInfo[];
}
