// Pure parsing of an HLS playlist (m3u8) -> list of quality variants + list of segments.
// No dependency on the chrome API. Handles both master playlists and media playlists directly.

import { Parser, type M3u8Rendition, type M3u8Segment } from 'm3u8-parser';
import { drmSystemFromHlsPlaylist } from './drm';
import type { RenditionInfo, VariantInfo } from './types';

export interface HlsParseResult {
  isMaster: boolean;
  variants: VariantInfo[];
  segmentCount?: number;
  keyMethod?: string;
  isProtected?: boolean;
  /** DRM vendor name to tell the user (only present when isProtected, since DRM is declared in the playlist). */
  drmName?: string;
}

/** Resolve a relative URL in the manifest to an absolute one. */
export function resolveUri(uri: string, baseUrl: string): string {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}

/** Display label for a variant: prefer "<height>p", then "<kbps> kbps", finally "Gốc" (Original). */
export function variantLabel(height?: number, bandwidth?: number): string {
  if (height && height > 0) return `${height}p`;
  if (bandwidth && bandwidth > 0) return `${Math.round(bandwidth / 1000)} kbps`;
  return 'Gốc';
}

/** Sort variants descending by resolution then bitrate (highest quality first). */
export function sortVariantsDesc(variants: VariantInfo[]): void {
  variants.sort(
    (a, b) =>
      (b.height ?? 0) - (a.height ?? 0) ||
      (b.bandwidth ?? 0) - (a.bandwidth ?? 0),
  );
}

/**
 * Settle on a unique `VariantInfo.id`.
 *
 * `preferred` is the format's natural identity (DASH: `Representation@id` via `attributes.NAME`).
 * It is NOT guaranteed unique — DASH only requires the id to be unique within one AdaptationSet, so
 * two AdaptationSets can still both declare `id="1"`. On collision, fall back to the index.
 *
 * ⚠️ Must re-check WITH A LOOP, not a single attempt: `@id` is set by whoever packaged the content,
 * and ISO 23009-1 §5.3.5.2 only forbids whitespace, so a representation can perfectly well already
 * be named `"a#2"` — exactly the shape we generate. Trying once and trusting it is enough would
 * return a DUPLICATE id, reproducing the exact "select one row, the whole group highlights" bug this
 * package exists to kill. The loop always terminates: each round appends another '#', so the string
 * keeps growing and can never fall back to a value already in `used`.
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

/** First encryption METHOD other than 'NONE' among the segment list. */
function firstKeyMethod(segments: M3u8Segment[]): string | undefined {
  for (const s of segments) {
    const method = s.key?.method;
    if (method && method !== 'NONE') return method;
  }
  return undefined;
}

type RawGroups = Record<string, Record<string, M3u8Rendition>>;

/** Flatten mediaGroups into a list of renditions (uri already resolved to absolute). */
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
        // Resolve ONLY when there's a real uri: a rendition with no URI means the track already lives
        // inside the variant (RFC 8216 §4.3.4.2.1). Resolving `undefined` would produce the master
        // URL itself -> a FABRICATED URL.
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
 * Rendition list for ONE variant: a copy of every rendition, with the `selected` flag on the one
 * this variant uses.
 *
 * Pick within the EXACT group the variant points to (`AUDIO=`), following RFC 8216 §4.3.4.1.1
 * order: `DEFAULT=YES` -> `AUTOSELECT=YES` -> the first entry in the group.
 * ⚠️ MUST look up via the variant's OWN group: X gives each video tier its own separate audio group
 * (`audio-128000`/`64000`/`32000`); taking the first `#EXT-X-MEDIA` would pair 128k audio with a
 * 480x270 video.
 * ⚠️ The `AUTOSELECT` tier is NOT redundant: dropping it means a group where `Commentary`
 * (AUTOSELECT=NO, has a URI) is declared BEFORE `Main` (AUTOSELECT=YES, no URI) would pick the
 * commentary track — video comes out right, audio is COMPLETELY WRONG, with no warning at all. The
 * declaration order in the manifest must not be allowed to decide this for us.
 * ⚠️ The final "take the first one" tier is ALSO not redundant: Twitter/X never declares `DEFAULT`
 * at all (measured on real manifests) -> relying on DEFAULT alone would miss and stay silently wrong,
 * same as before.
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
  // ⚠️ AUDIO-ONLY variant: its uri IS the audio playlist itself (HLS Authoring Spec §2.3 requires
  // the master to have an audio-only rendition; Apple/Shaka/Bento4/MediaConvert all emit one).
  // Selecting it means downloading the SAME playlist twice and then forcing `-map 0:v:0` onto an
  // input that HAS NO video -> ffmpeg exit code 234, job fails hard. Yet before W1.1 that very
  // variant downloaded fine (produced a valid audio-only file). Selecting nothing here = return the
  // proven-working single-input path, and no more double download.
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
        // An HLS master has no natural identity -> the index is the only thing guaranteed to distinguish it.
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
    // §7 — a master advertises DRM via #EXT-X-SESSION-KEY (it has no segments to infer it from).
    // Skipping this lets every DRM site slip through right at the quality-listing step.
    const masterDrm = drmSystemFromHlsPlaylist(text);
    return {
      isMaster: true,
      variants,
      ...(masterDrm ? { isProtected: true, drmName: masterDrm } : {}),
    };
  }

  const segments = manifest.segments ?? [];
  const keyMethod = firstKeyMethod(segments);
  const mediaDrm = drmSystemFromHlsPlaylist(text);
  return {
    isMaster: false,
    variants: [{ id: 'v0', uri: manifestUrl, name: 'Gốc' }],
    segmentCount: segments.length,
    keyMethod,
    isProtected: mediaDrm !== null || keyMethod === 'SAMPLE-AES',
    ...(mediaDrm ? { drmName: mediaDrm } : {}),
  };
}

/**
 * Every CHILD playlist URL a master declares: video variants + audio renditions (already resolved
 * to absolute).
 *
 * Used for W4.2: the player fetches both the master and its children, webRequest observes all of
 * them, so a single video ends up showing as several identical "HLS" rows in the popup. Knowing
 * this child set lets us hide them.
 *
 * ⚠️ The `isMaster` guard is NOT redundant: parsing a MEDIA playlist returns `variants: [{ uri: manifestUrl }]`
 * — i.e. ITSELF. Without the guard, every child playlist would declare itself a child of itself and
 * hide itself -> any site serving a media playlist directly (no master) would show an EMPTY popup.
 * ⚠️ Deduping with a Set is REQUIRED: `audioRenditions` carries renditions from EVERY group on EVERY
 * variant (§3.2 design), so the same audio URL shows up repeated across variants.
 */
export function childUrlsOfMaster(parsed: HlsParseResult): string[] {
  if (!parsed.isMaster) return [];
  const out = new Set<string>();
  for (const v of parsed.variants) {
    out.add(v.uri);
    // A rendition with no `uri` = audio already lives inside the variant (RFC 8216 §4.3.4.2.1) ->
    // there's no separate URL to hide. Fabricating one here would end up hiding the master itself.
    for (const r of v.audioRenditions ?? []) if (r.uri) out.add(r.uri);
  }
  return [...out];
}

// --- G5: segment analysis for downloading & decrypting ---

export type HlsEncryption = 'none' | 'aes-128' | 'sample-aes' | 'other';

/** A byte range within a larger file. `offset` is always ABSOLUTE (first byte, counted from 0). */
export interface HlsByteRange {
  length: number;
  offset: number;
}

export interface HlsSegment {
  /** Absolute URL of the segment (.ts/.m4s). */
  uri: string;
  /** duration (seconds). */
  duration: number;
  /** media sequence number (used as the default IV when #EXT-X-KEY doesn't declare one). */
  seq: number;
  keyMethod?: string;
  /** Absolute URL of the key. */
  keyUri?: string;
  /** 16-byte IV if declared explicitly in #EXT-X-KEY. */
  iv?: Uint8Array;
  /** Absolute URL of the init segment (fMP4) if #EXT-X-MAP is present. */
  initUri?: string;
  /**
   * 🔴 THE INIT'S OWN KEY — must NOT be inferred from the segment's `keyMethod`/`keyUri`.
   *
   * RFC 8216 §4.3.2.5 scopes keys by TAG POSITION: an `#EXT-X-KEY` covers the Media Initialization
   * Sections declared by `#EXT-X-MAP` between it and the next `#EXT-X-KEY`. So:
   *     KEY then MAP  -> init IS encrypted with that key
   *     MAP then KEY  -> init is CLEAR, only the segment is encrypted (valid and common: a clear
   *                      init lets the player read the codec before it goes to fetch the key)
   *
   * MEASURED (2026-07-20, m3u8-parser@7.2.0): the parser models this scope CORRECTLY via
   * `segment.map.key` — present in the first ordering, ABSENT in the second. The previous version
   * used the segment's key, so it decrypted an init that was actually clear -> padding error ->
   * wrongly killed a healthy stream while blaming the server. The e2e case `fmp4-clear-init` pins
   * this down. **Do not collapse these fields onto the segment's key.**
   */
  initKeyMethod?: string;
  /** Absolute URL of the init key (can be DIFFERENT from the segment key). */
  initKeyUri?: string;
  /** Explicit IV of the init. RFC requires an IV to be declared whenever the key covers the init. */
  initIv?: Uint8Array;
  /**
   * Byte range of the segment within a larger file (#EXT-X-BYTERANGE). Present = ALL segments
   * typically point to the SAME `uri`, differing only by range -> the fetch layer MUST send a
   * `Range` header, otherwise it downloads the entire large file once for EVERY segment (measured:
   * Apple fMP4 = 27MB x 101 times).
   */
  byterange?: HlsByteRange;
  /** Byte range of the init segment (#EXT-X-MAP BYTERANGE). See the note on the mapper. */
  initByterange?: HlsByteRange;
}

export interface HlsSegmentsResult {
  segments: HlsSegment[];
  encryption: HlsEncryption;
  /** true if the content is protected (SAMPLE-AES/DRM) -> NOT supported, must STOP. */
  isProtected: boolean;
  /** DRM vendor name (FairPlay/PlayReady/Widevine/...) to state clearly, not just "not supported". */
  drmName?: string;
  totalDuration: number;
  /** whether there is an fMP4 init segment. */
  hasInit: boolean;
  /**
   * W1.5 — the playlist parses fine but we DELIBERATELY refuse to download it: give a reason an
   * ordinary person can understand.
   *
   * Differs from `isProtected` (the DRM boundary) in that this is one of OUR technical limitations,
   * and differs from "0 segments" in that it states the ACTUAL cause. Introduced because blindly
   * concatenating a multi-Period DASH stream produces a corrupt file that ffmpeg still accepts ->
   * the job reports "done" while the file is wrong. Silently handing over a broken file is worse
   * than an outright refusal.
   */
  unsupportedReason?: string;
  /**
   * W1.5 — no segments at all BUT there is a media file that can be downloaded directly (DASH
   * SegmentBase: the whole representation is just one .mp4 + indexRange). The layer above routes
   * this to the progressive-download path.
   */
  directUrl?: string;
  /**
   * W1.4 — number of SEAMS (timestamp resets) INSIDE the segment list about to be concatenated,
   * usually from a mid-stream ad insertion. > 0 means byte-concat + `-c copy` will hand ffmpeg a
   * NON-monotonic DTS stream -> the file plays fine at first then desyncs audio/freezes/reports the
   * wrong duration, while the 'Non-monotonous DTS' warning only lands in `console.debug` -> the user
   * still sees "Download complete ✓".
   *
   * REQUIRED (not optional) is DELIBERATE: if this field were allowed to be absent, every layer
   * above comparing `undefined > 0` would get false and the warning would vanish WITHOUT A SOUND —
   * exactly the class of bug §2.1 targets.
   */
  discontinuityCount: number;
}

/**
 * W1.4 — count the REAL SEAMS inside the segment list we're about to concatenate.
 *
 * 🔬 MEASURED (m3u8-parser@7.2.0, probed 2026-07-19) — **`discontinuityStarts.length` is WRONG IN
 * BOTH DIRECTIONS**, don't "simplify" back to it:
 *  - A tag positioned BEFORE the first segment -> `[0]`. That's a reset marker relative to a portion
 *    we do NOT download; inside the concatenated file there **is no seam at all**. Counting it =
 *    scaring the user for nothing (wrongly kills a healthy download).
 *  - Two ADJACENT tags -> `[1,1]`: the index is **repeated**, but there's only ONE seam -> double
 *    counted.
 *  - `#EXT-X-DISCONTINUITY-SEQUENCE:3` with no accompanying tag -> `[]` (correctly 0): it counts
 *    breaks BEFORE this window, not inside it. Don't use it for counting.
 *
 * So the rule is: **DISTINCT indices GREATER THAN 0**. Merge both sources (the `discontinuityStarts`
 * array and the per-segment flag) because they're two views of the same thing — when they disagree,
 * taking the union is the safe side: missing a seam means a silently broken file, while the `Set`
 * already guards against double-counting.
 */
export function countDiscontinuities(
  segments: readonly { discontinuity?: boolean }[],
  discontinuityStarts?: readonly number[],
): number {
  const seams = new Set<number>();
  for (const i of discontinuityStarts ?? []) {
    if (Number.isInteger(i) && i > 0 && i < segments.length) seams.add(i);
  }
  segments.forEach((s, i) => {
    if (i > 0 && s.discontinuity === true) seams.add(i);
  });
  return seams.size;
}

/**
 * W2.3 — ONE representative url per HOST appearing in the segment list (segment.uri, keyUri,
 * initUri). Used by background to turn on Referer/Origin spoofing for EVERY host BEFORE downloading.
 *
 * Why it's needed: §2.4 — segments are very often on a CDN with a different host than the playlist,
 * and the AES key is almost ALWAYS on yet another host, which also happens to be the thing most
 * likely to check Referer. Spoofing only the playlist host means the job reaches 'fetching' and then
 * every segment/key 403s -> "Segment download failed after 4 attempts: HTTP 403". Returning one
 * url/host (not the bare host) lets applySpoof construct the Referer, and keeps the rule count from
 * growing with the segment count.
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
    // The init's key can be a DIFFERENT URI from the segment key (and the AES key is almost always
    // on a different host) — missing it means the job reaches 'fetching' and then dies with a 403
    // right at the init-key-fetch step.
    add(s.initKeyUri);
  }
  return [...byHost.values()];
}

/** Convert a Uint32Array-style IV (m3u8-parser, 4 x uint32 big-endian) to 16 bytes. */
function ivToBytes(iv?: Uint32Array): Uint8Array | undefined {
  if (!iv || iv.length < 4) return undefined;
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 4; i++) view.setUint32(i * 4, iv[i]! >>> 0, false);
  return bytes;
}

/**
 * From a MEDIA playlist -> segment list (absolute uri, duration, key/IV, init).
 * Determines the encryption type; SAMPLE-AES/anything other than AES-128 -> isProtected (STOP, not supported).
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
    // W1.3 — TWO DIFFERENT byterange rules, don't merge them into one (measured for real on
    // m3u8-parser@7.2.0):
    //  - segment: the parser has ALREADY accumulated the offset into an ABSOLUTE one (missing
    //    `@offset` = follows right after the previous segment). Accumulating again = doubling the
    //    offset = reading the wrong spot.
    //  - #EXT-X-MAP: NOT accumulated, and when `@offset` is missing the `offset` key is ABSENT
    //    entirely. RFC 8216 §4.3.2.5: a missing `@offset` means starting at byte 0 — NOT following
    //    on from anything.
    const br = s.byterange;
    const mapBr = s.map?.byterange;
    // The INIT's key comes from `s.map.key`, NOT `s.key` — see the note on HlsSegment.initKeyMethod.
    // A missing `map.key` means the init falls OUTSIDE the scope of every #EXT-X-KEY, i.e. it's clear.
    const mapKey = s.map?.key;
    return {
      uri: resolveUri(s.uri, manifestUrl),
      duration: typeof s.duration === 'number' ? s.duration : 0,
      seq: baseSeq + i,
      keyMethod: key?.method,
      keyUri: key?.uri ? resolveUri(key.uri, manifestUrl) : undefined,
      iv: ivToBytes(key?.iv),
      initUri: s.map?.uri ? resolveUri(s.map.uri, manifestUrl) : undefined,
      initKeyMethod: mapKey?.method,
      initKeyUri: mapKey?.uri ? resolveUri(mapKey.uri, manifestUrl) : undefined,
      initIv: ivToBytes(mapKey?.iv),
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

  // §7 — inspect the RAW TEXT directly: m3u8-parser swallows `segment.key` for FairPlay/PlayReady/
  // Widevine, so any inference from `encryption` (which derives from segment.key) sees the DRM
  // playlist as "clean". MEASURED.
  const drmName = drmSystemFromHlsPlaylist(text);
  return {
    segments,
    encryption,
    // AES-128 can be decrypted -> NOT protected. SAMPLE-AES/other (usually EME/DRM) -> protected.
    isProtected:
      drmName !== null || encryption === 'sample-aes' || encryption === 'other',
    ...(drmName ? { drmName } : {}),
    totalDuration: segments.reduce((sum, s) => sum + s.duration, 0),
    hasInit: segments.some((s) => s.initUri !== undefined),
    discontinuityCount: countDiscontinuities(raw, manifest.discontinuityStarts),
  };
}
