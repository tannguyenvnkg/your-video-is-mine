// Pure parsing of DASH manifest (.mpd) -> list of quality representations + list of segments.
// mpd-parser normalizes MPD into an HLS-like shape (playlists[] + attributes + absolute resolvedUri).

import {
  parse,
  type MpdManifest,
  type MpdPlaylist,
  type MpdSegment,
} from 'mpd-parser';
import type { RenditionInfo, VariantInfo } from './types';
import {
  countDiscontinuities,
  parseHlsSegments,
  sortVariantsDesc,
  uniqueVariantId,
  variantLabel,
  type HlsSegment,
  type HlsSegmentsResult,
} from './hls';
import { drmSystemsInMpd } from './drm';

export interface DashParseResult {
  isMaster: boolean;
  variants: VariantInfo[];
  /**
   * W7.1 — DASH declares DRM right in the manifest via `<ContentProtection>`. Before W7.1 we did NOT
   * read this tag, so DRM videos slipped past the "Quality" step and only failed at the download stage — confusing for the user.
   */
  isProtected: boolean;
  /** Names of the declared DRM systems (to state EXACTLY what is blocking, not a generic message). */
  drmSystems: string[];
}

/**
 * A single DASH track (video or audio) with its finalized identity.
 *
 * 🔴 WHY IDS ARE ASSIGNED IN ONE SHARED PASS for both video and audio: `parseDashSegments` looks up
 * a track by id. If video and audio numbered ids in two separate namespaces, one id could point to
 * TWO tracks — picking 1080p could accidentally download audio instead, with no error at all. A single
 * `used` set and a single ordering (video first, audio second) make `dashTracks()` the SINGLE SOURCE
 * OF TRUTH for identity.
 */
interface DashTrack {
  id: string;
  kind: 'video' | 'audio';
  playlist: MpdPlaylist;
  /** Label of the audio AdaptationSet (only audio tracks have this). */
  label?: string;
  groupId?: string;
  language?: string;
  isDefault?: boolean;
}

/**
 * List EVERY track of an MPD with a globally unique id.
 *
 * ⚠️ Don't look up by `attributes.NAME` directly elsewhere: DASH only requires `Representation@id`
 * to be unique WITHIN a single AdaptationSet, so two AdaptationSets can still both declare `id="1"`.
 * `uniqueVariantId` disambiguates them with a suffix, and every other place MUST reuse that exact
 * disambiguated id.
 */
function dashTracks(manifest: MpdManifest): DashTrack[] {
  const used = new Set<string>();
  const out: DashTrack[] = [];

  const playlists = manifest.playlists ?? [];
  playlists.forEach((p, index) => {
    out.push({
      id: uniqueVariantId(p.attributes?.NAME, index, used),
      kind: 'video',
      playlist: p,
    });
  });

  // Audio lives at mediaGroups.AUDIO[group][label].playlists[] (verified in practice against mpd-parser@1.4.0).
  const groups = manifest.mediaGroups?.AUDIO ?? {};
  let audioIndex = playlists.length;
  for (const [groupId, group] of Object.entries(groups)) {
    for (const [label, rendition] of Object.entries(group)) {
      for (const p of rendition.playlists ?? []) {
        out.push({
          id: uniqueVariantId(p.attributes?.NAME, audioIndex, used),
          kind: 'audio',
          playlist: p,
          label,
          groupId,
          ...(rendition.language !== undefined
            ? { language: rendition.language }
            : {}),
          isDefault: rendition.default === true,
        });
        audioIndex++;
      }
    }
  }
  return out;
}

/**
 * Audio renditions for the popup to pick from.
 *
 * ⚠️ Do NOT reuse HLS's `renditionsForVariant`: that function decides "which one is selected" by
 * comparing `uri`, but DASH SegmentTemplate gives EVERY track the SAME `resolvedUri` (the .mpd file
 * itself). Comparing by uri here would mean NOTHING is ever `selected` -> the popup finds no audio
 * -> muxes a MUTE file with no layer reporting an error. This is exactly the §2.1 disease that W1.1
 * was created to fix. So DASH selects by `default`, falling back to the first one, and identifies by
 * `id`, not by `uri`.
 */
function audioRenditionsOf(
  tracks: DashTrack[],
  manifestUrl: string,
): RenditionInfo[] | undefined {
  const audio = tracks.filter((t) => t.kind === 'audio');
  if (audio.length === 0) return undefined;
  const chosen = audio.find((t) => t.isDefault) ?? audio[0];
  return audio.map((t) => ({
    id: t.id,
    groupId: t.groupId ?? 'audio',
    name: t.label ?? t.id,
    // DASH identifies a track by `id`; `uri` only exists so the spoof/estimate layer has a real URL to use.
    uri: t.playlist.resolvedUri ?? manifestUrl,
    ...(t.language !== undefined ? { language: t.language } : {}),
    default: t.isDefault === true,
    autoselect: t.isDefault === true,
    ...(t === chosen ? { selected: true } : {}),
  }));
}

export function parseDashManifest(
  text: string,
  manifestUrl: string,
): DashParseResult {
  const manifest = parse(text, { manifestUri: manifestUrl });
  const tracks = dashTracks(manifest);
  const audioRenditions = audioRenditionsOf(tracks, manifestUrl);

  const variants: VariantInfo[] = tracks
    .filter((t) => t.kind === 'video')
    .map((t, index) => {
      const attr = t.playlist.attributes ?? {};
      const res = attr.RESOLUTION;
      const base = variantLabel(res?.height, attr.BANDWIDTH);
      return {
        // DASH's REAL identity is Representation@id — mpd-parser puts it in attributes.NAME.
        // With SegmentTemplate, the `uri` of every representation is the same .mpd file, so it's useless.
        id: t.id,
        // 🔴 ALWAYS the manifest URL, NOT `resolvedUri`.
        // With SegmentBase, `resolvedUri` is the actual .mp4 file — returning that would make every
        // downstream layer (estimate, spoof-host detection, offscreen), which treats `variantUrl` as
        // THE MANIFEST DOCUMENT, fetch the whole video file and then `res.text()` and parse it as XML.
        // DASH's track identity lives in `id`, so `uri` only needs to point to where the manifest is.
        uri: manifestUrl,
        // No resolution -> append an index number to disambiguate.
        name: res?.height ? base : `${base} #${index + 1}`,
        bandwidth: attr.BANDWIDTH,
        width: res?.width,
        height: res?.height,
        codecs: attr.CODECS,
        // DASH ALWAYS separates audio -> carry the list along so the popup can send `audioId` when downloading.
        ...(audioRenditions ? { audioRenditions } : {}),
      };
    });

  sortVariantsDesc(variants);
  // Scanned on the RAW TEXT, not via mpd-parser: mpd-parser ignores <ContentProtection> entirely.
  const drmSystems = drmSystemsInMpd(text);
  return {
    isMaster: variants.length > 1,
    variants,
    isProtected: drmSystems.length > 0,
    drmSystems,
  };
}

/**
 * Parse segments according to the manifest's ACTUAL format — the ONE branch point between HLS and DASH.
 *
 * 🔴 Why this must exist: `parseHlsSegments` swallows XML WITHOUT throwing — m3u8-parser returns an
 * empty manifest. Feeding it a .mpd makes the estimate report "0 segments", the spoof-host detection
 * step finds 0 hosts, and the job runs through to 'fetching' then a clean 403. All of it stays GREEN
 * and SILENT. Every place that used to call `parseHlsSegments` directly on a user-chosen URL MUST go
 * through here instead.
 *
 * ⚠️ The `'hls' | 'dash'` type is hand-written, NOT imported as `ManifestKind` from `messages.ts`:
 * `messages.ts` drags in `storage.ts`, and this file is imported by offscreen — where `chrome.storage`
 * does NOT exist. A wrong import here is a runtime TypeError that tsc/eslint/vitest all miss.
 */
export function parseTrackSegments(
  text: string,
  url: string,
  mediaType: 'hls' | 'dash' | undefined,
  trackId?: string,
): HlsSegmentsResult {
  return mediaType === 'dash'
    ? parseDashSegments(text, url, trackId)
    : parseHlsSegments(text, url);
}

/** Convert a single mpd-parser segment into the correct `HlsSegment` shape. */
function toHlsSegment(s: MpdSegment, index: number): HlsSegment {
  return {
    // resolvedUri is already absolute (mpd-parser resolves it against BaseURL + manifestUri).
    uri: s.resolvedUri ?? s.uri ?? '',
    duration: typeof s.duration === 'number' ? s.duration : 0,
    // DASH has no media sequence; `seq` is only used as the default IV for HLS AES-128, so here it's
    // just a plain index. Still filled in so the required field has a well-defined value.
    seq: index,
    // Deliberately WITHOUT keyMethod/keyUri/iv: DASH's encryption is CENC = DRM, which falls under the
    // REFUSAL boundary (§7), not something to decrypt. This makes the AES-128 branch in offscreen dead code.
    ...(s.map?.resolvedUri ? { initUri: s.map.resolvedUri } : {}),
    ...(s.byterange ? { byterange: s.byterange } : {}),
    ...(s.map?.byterange ? { initByterange: s.map.byterange } : {}),
  };
}

/**
 * From an MPD + track id -> a segment list in the EXACT `HlsSegmentsResult` shape.
 *
 * Returns exactly the type that `downloadTrack` in offscreen already accepts, so DASH reuses HLS's
 * WHOLE fetch/backpressure/retry/mux machinery instead of growing a second download pipeline.
 */
export function parseDashSegments(
  text: string,
  manifestUrl: string,
  trackId?: string,
): HlsSegmentsResult {
  const manifest = parse(text, { manifestUri: manifestUrl });
  const tracks = dashTracks(manifest);
  const track =
    (trackId !== undefined
      ? tracks.find((t) => t.id === trackId)
      : undefined) ?? tracks.find((t) => t.kind === 'video');

  const drmSystems = drmSystemsInMpd(text);
  const base: HlsSegmentsResult = {
    segments: [],
    encryption: 'none',
    isProtected: drmSystems.length > 0,
    totalDuration: 0,
    hasInit: false,
    discontinuityCount: 0,
  };
  if (!track) {
    return {
      ...base,
      unsupportedReason: `Không tìm thấy luồng "${trackId ?? '?'}" trong manifest DASH.`,
    };
  }

  const raw = track.playlist.segments ?? [];
  const segments = raw.map(toHlsSegment);
  const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);

  // SegmentBase/BaseURL: mpd-parser does NOT build segments (verified in practice) but `resolvedUri`
  // IS a directly downloadable media file. Reporting "playlist has no segments" here would be
  // literally true but entirely wrong about the cause, so surface the direct-download path instead
  // so the layer above can route it to the progressive flow.
  if (segments.length === 0) {
    const direct = track.playlist.resolvedUri;
    // Keep `directUrl` so the caller can route to the progressive flow, BUT the reason must still be
    // stated right now: nobody consumes `directUrl` yet, so staying silent here means the job just
    // dies with "playlist has no segments" — exactly the confusing dead end this branch exists to avoid.
    if (direct && direct !== manifestUrl) {
      return {
        ...base,
        directUrl: direct,
        unsupportedReason:
          'Representation DASH này là một tệp liền (SegmentBase) chứ không chia segment — chưa hỗ trợ tải dạng này.',
      };
    }
    return {
      ...base,
      unsupportedReason: 'Manifest DASH không khai segment nào tải được.',
    };
  }

  // 🔴 Multi-Period: mpd-parser STITCHES the Periods together into ONE playlist by itself, but
  // `downloadTrack` only loads the FIRST init and appends every segment after it. ffmpeg still
  // accepts it, the job still "finishes", but the file is WRONG.
  //
  // 🔬 VERIFIED IN PRACTICE (mpd-parser@1.4.0) — the first version of this guard checked "are there
  // multiple distinct inits" and was WRONG: with SegmentTemplate, `initialization` interpolates to
  // the SAME URI in every Period, so there's only 1 init and the guard never fires. Worse:
  // `startNumber` resets on every Period, so segment URLs REPEAT (verified: seg-1, seg-2, seg-1,
  // seg-2) -> blindly muxing produces the SAME 10 seconds concatenated twice, packaged as a 20-second
  // video. The CORRECT signal is `discontinuityStarts` — mpd-parser always fills it in when stitching Periods.
  const periodStarts = track.playlist.discontinuityStarts ?? [];
  const inits = new Set(
    segments.map((s) => s.initUri).filter((u): u is string => Boolean(u)),
  );
  const result: HlsSegmentsResult = {
    segments,
    encryption: 'none',
    isProtected: drmSystems.length > 0,
    totalDuration,
    hasInit: inits.size > 0,
    // W1.4 — filled in to satisfy the contract fully. For DASH this number is REPORTING ONLY: a
    // Period boundary gets outright REFUSED by the guard right below, rather than downgraded to a
    // warning like HLS does.
    discontinuityCount: countDiscontinuities(
      track.playlist.segments ?? [],
      periodStarts,
    ),
  };
  if (periodStarts.length > 0 || inits.size > 1) {
    return {
      ...result,
      unsupportedReason:
        'Manifest DASH có nhiều Period (thường do chèn quảng cáo) — ghép thẳng lại sẽ ra file sai, nên chưa hỗ trợ.',
    };
  }
  return result;
}
