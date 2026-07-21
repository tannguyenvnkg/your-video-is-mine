import { describe, expect, it } from 'vitest';
import { parse as parseMpd } from 'mpd-parser';
import { parseDashManifest, parseDashSegments } from './dash';

const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT30S" minBufferTime="PT2S">
 <Period>
  <AdaptationSet mimeType="video/mp4">
   <Representation id="1" bandwidth="1200000" width="640" height="360" codecs="avc1.42c01e">
    <BaseURL>video360.mp4</BaseURL>
    <SegmentBase indexRange="0-100"/>
   </Representation>
   <Representation id="2" bandwidth="2400000" width="1280" height="720" codecs="avc1.4d401f">
    <BaseURL>video720.mp4</BaseURL>
    <SegmentBase indexRange="0-100"/>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>`;

describe('parseDashManifest', () => {
  const r = parseDashManifest(MPD, 'https://ex.com/dir/stream.mpd');

  it('2 representations, sorted descending by height', () => {
    expect(r.variants).toHaveLength(2);
    expect(r.variants[0]!.height).toBe(720);
    expect(r.variants[1]!.height).toBe(360);
  });

  // ⚠️ This test PREVIOUSLY pinned `uri` = the media file ('…/video720.mp4') and that assumption
  // was WRONG — adversarial review W1.5 pointed out: every downstream layer treats `variantUrl`
  // as the MANIFEST DOCUMENT and calls `res.text()` + parses it, so returning .mp4 makes them
  // swallow the raw video file and try to parse it as XML. DASH track identity lives in `id`;
  // `uri` only needs to point to where the manifest can be fetched.
  it('variant uri is the MANIFEST, not the media file', () => {
    expect(r.variants[0]!.uri).toBe('https://ex.com/dir/stream.mpd');
  });

  it('isMaster is true when there is more than 1 variant', () => {
    expect(r.isMaster).toBe(true);
  });
});

// ===========================================================================
// W0.4 — HARD-CASE FIXTURE (DASH). The fixture above uses SegmentBase+BaseURL —
// the ONLY DASH shape where `resolvedUri` is an actual media file. The most
// common shape in the wild is SegmentTemplate, where resolvedUri IS the .mpd file.
//
// Same 3-layer test convention as utils/hls.test.ts: library contract (green) /
// it.fails (real red, auto-flips green once Batch 1 is fixed) / guard test.
// ===========================================================================

/** mediaGroups.AUDIO shape, ACTUALLY MEASURED on mpd-parser@1.4.0. */
interface MpdAudioRendition {
  language?: string;
  default?: boolean;
  playlists?: {
    attributes?: { NAME?: string };
    segments?: { resolvedUri?: string }[];
  }[];
}

// --- Fixture: SegmentTemplate + AdaptationSet audio ----------------------
// DASH ALWAYS separates audio -> this is the standard case, not an exception.
const MPD_TEMPLATE = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT60S" minBufferTime="PT2S">
 <Period id="p0">
  <AdaptationSet mimeType="video/mp4" segmentAlignment="true">
   <SegmentTemplate media="$RepresentationID$/seg-$Number$.m4s" initialization="$RepresentationID$/init.mp4" duration="4" startNumber="1" timescale="1"/>
   <Representation id="v720" bandwidth="2400000" width="1280" height="720" codecs="avc1.4d401f"/>
   <Representation id="v360" bandwidth="800000" width="640" height="360" codecs="avc1.42c01e"/>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4" lang="en" segmentAlignment="true">
   <SegmentTemplate media="$RepresentationID$/seg-$Number$.m4s" initialization="$RepresentationID$/init.mp4" duration="4" startNumber="1" timescale="1"/>
   <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2" audioSamplingRate="48000"/>
  </AdaptationSet>
 </Period>
</MPD>`;
const TPL_BASE = 'https://ex.com/dir/stream.mpd';

describe('W0.4 mpd-parser contract: SegmentTemplate', () => {
  const m = parseMpd(MPD_TEMPLATE, { manifestUri: TPL_BASE });

  it('EVERY representation has resolvedUri = the .mpd file itself (not the media)', () => {
    // This is the root cause of "clicking 720p lights up every row": uri can't tell them apart.
    expect(m.playlists!.map((p) => p.resolvedUri)).toEqual([
      TPL_BASE,
      TPL_BASE,
    ]);
    expect(m.playlists![0]!.uri).toBe('');
  });

  it('real identity lives in attributes.NAME = the Representation id', () => {
    expect(m.playlists!.map((p) => p.attributes!.NAME)).toEqual([
      'v720',
      'v360',
    ]);
  });

  it('media segments DO have an absolute resolvedUri (downloadable data is right there)', () => {
    const segs = m.playlists![0]!.segments as { resolvedUri?: string }[];
    expect(segs[0]!.resolvedUri).toBe('https://ex.com/dir/v720/seg-1.m4s');
    expect(segs).toHaveLength(15);
  });

  it('audio lives at mediaGroups.AUDIO[group][label].playlists[0].segments[]', () => {
    const mg = m.mediaGroups as {
      AUDIO?: Record<string, Record<string, MpdAudioRendition>>;
    };
    const en = mg.AUDIO!.audio!.en!;
    expect(en.language).toBe('en');
    expect(en.playlists![0]!.attributes!.NAME).toBe('a128');
    expect(en.playlists![0]!.segments![0]!.resolvedUri).toBe(
      'https://ex.com/dir/a128/seg-1.m4s',
    );
  });
});

describe('W0.4/W1.5 DASH SegmentTemplate -> variants indistinguishable + lost audio', () => {
  const r = parseDashManifest(MPD_TEMPLATE, TPL_BASE);

  it('current state: 2 variants but uri is IDENTICAL (it is the .mpd file)', () => {
    expect(r.variants).toHaveLength(2);
    expect(new Set(r.variants.map((v) => v.uri)).size).toBe(1);
    expect(r.variants[0]!.uri).toBe(TPL_BASE);
  });

  // W1.5 DONE: `id` is taken from Representation@id (attributes.NAME) -> distinguishable even with matching uri.
  it('variant must have its own `id` (taken from attributes.NAME)', () => {
    const ids = r.variants.map((v) => v.id);
    expect(ids).toEqual(['v720', 'v360']);
  });

  // ✅ W1.5 second half: parseDashManifest now reads mediaGroups.AUDIO -> audio surfaces for popup selection.
  it('result must surface the a128 audio representation', () => {
    expect(JSON.stringify(r)).toContain('a128');
  });

  // GUARD: the audio AdaptationSet must NOT be mixed into the video-quality list.
  it('must not list audio as a video quality level', () => {
    expect(r.variants.map((v) => v.height)).toEqual([720, 360]);
  });
});

// --- Fixture: multi-Period DASH --------------------------------------------
// mpd-parser AUTOMATICALLY STITCHES multiple Periods into ONE playlist -> no
// special handling needed. BUT the Period boundary IS a real discontinuity,
// AND each Period has its OWN init segment -> HlsSegment.initUri (a single
// init for the whole playlist) cannot express this case.
const MPD_MULTI_PERIOD = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT20S" minBufferTime="PT2S">
 <Period id="p0" duration="PT10S">
  <AdaptationSet mimeType="video/mp4">
   <SegmentTemplate media="p0/$RepresentationID$-$Number$.m4s" initialization="p0/$RepresentationID$-init.mp4" duration="5" startNumber="1" timescale="1"/>
   <Representation id="v720" bandwidth="2400000" width="1280" height="720" codecs="avc1.4d401f"/>
  </AdaptationSet>
 </Period>
 <Period id="p1" duration="PT10S">
  <AdaptationSet mimeType="video/mp4">
   <SegmentTemplate media="p1/$RepresentationID$-$Number$.m4s" initialization="p1/$RepresentationID$-init.mp4" duration="5" startNumber="1" timescale="1"/>
   <Representation id="v720" bandwidth="2400000" width="1280" height="720" codecs="avc1.4d401f"/>
  </AdaptationSet>
 </Period>
</MPD>`;

describe('W0.4 mpd-parser contract: multi-Period', () => {
  const m = parseMpd(MPD_MULTI_PERIOD, {
    manifestUri: 'https://ex.com/dir/multi.mpd',
  });
  const p = m.playlists![0]!;

  it('automatically stitches 2 Periods into ONE playlist with 4 segments', () => {
    expect(m.playlists).toHaveLength(1);
    const segs = p.segments as { resolvedUri?: string }[];
    expect(segs.map((s) => s.resolvedUri)).toEqual([
      'https://ex.com/dir/p0/v720-1.m4s',
      'https://ex.com/dir/p0/v720-2.m4s',
      'https://ex.com/dir/p1/v720-1.m4s',
      'https://ex.com/dir/p1/v720-2.m4s',
    ]);
  });

  it('Period boundary IS a real discontinuity (index 2)', () => {
    expect(p.discontinuityStarts).toEqual([2]);
    const segs = p.segments as { discontinuity?: boolean; timeline?: number }[];
    expect(segs[2]!.discontinuity).toBe(true);
    expect(segs.map((s) => s.timeline)).toEqual([0, 0, 10, 10]);
  });

  it('EACH Period has its OWN init segment -> one initUri for the whole playlist is WRONG', () => {
    const segs = p.segments as { map?: { resolvedUri?: string } }[];
    expect(segs.map((s) => s.map!.resolvedUri)).toEqual([
      'https://ex.com/dir/p0/v720-init.mp4',
      'https://ex.com/dir/p0/v720-init.mp4',
      'https://ex.com/dir/p1/v720-init.mp4',
      'https://ex.com/dir/p1/v720-init.mp4',
    ]);
  });
});

describe('W7.1 — DASH declaring DRM in the manifest must STOP (hard boundary §7)', () => {
  it('MPD with <ContentProtection> Widevine -> isProtected + names the vendor', () => {
    const mpd = `<?xml version="1.0"?><MPD><Period><AdaptationSet mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="1" bandwidth="800000" width="640" height="360"/>
      </AdaptationSet></Period></MPD>`;
    const r = parseDashManifest(mpd, 'https://x/m.mpd');
    expect(r.isProtected).toBe(true);
    expect(r.drmSystems).toContain('Widevine');
  });

  it('a normal MPD -> NOT protected (do not wrongly block clean video)', () => {
    const mpd = `<?xml version="1.0"?><MPD><Period><AdaptationSet mimeType="video/mp4">
      <Representation id="1" bandwidth="800000" width="640" height="360"/>
      </AdaptationSet></Period></MPD>`;
    const r = parseDashManifest(mpd, 'https://x/m.mpd');
    expect(r.isProtected).toBe(false);
    expect(r.drmSystems).toEqual([]);
  });
});

// --- W1.5: id collisions REALLY happen during parsing, not just at the function level ---------
// mpd-parser groups representations by BaseURL before merging by id, so two AdaptationSets that
// declare the SAME @id but differ in BaseURL survive as two separate playlists. DASH allows this:
// @id only needs to be unique WITHIN one AdaptationSet. Also add an @id that already carries a
// '#' character, matching the shape we generate ourselves.
const MPD_DUP_IDS = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT30S" minBufferTime="PT2S">
 <Period>
  <AdaptationSet mimeType="video/mp4">
   <BaseURL>vidA/</BaseURL>
   <Representation id="a#2" bandwidth="2400000" width="1280" height="720" codecs="avc1.4d401f">
    <SegmentBase indexRange="0-100"/>
   </Representation>
  </AdaptationSet>
  <AdaptationSet mimeType="video/mp4">
   <BaseURL>vidB/</BaseURL>
   <Representation id="a" bandwidth="1200000" width="854" height="480" codecs="avc1.42c01e">
    <SegmentBase indexRange="0-100"/>
   </Representation>
  </AdaptationSet>
  <AdaptationSet mimeType="video/mp4">
   <BaseURL>vidC/</BaseURL>
   <Representation id="a" bandwidth="600000" width="640" height="360" codecs="avc1.42c01e">
    <SegmentBase indexRange="0-100"/>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>`;

describe('W1.5 DASH: matching @id across AdaptationSets must still produce unique ids', () => {
  const r = parseDashManifest(MPD_DUP_IDS, 'https://ex.com/x/manifest.mpd');

  // Pin down the EXACT consequence the user sees: duplicate id = duplicate React key = clicking one row lights up the whole cluster.
  it('every variant has its own id even when the manifest declares duplicate @id', () => {
    expect(r.variants).toHaveLength(3);
    expect(new Set(r.variants.map((v) => v.id)).size).toBe(3);
  });
});

// ===========================================================================
// W1.5 SECOND HALF — parseDashSegments: DASH can actually be downloaded.
// Returns the EXACT HlsSegmentsResult shape to reuse the entire HLS fetch/mux machinery.
// ===========================================================================

// Multi-Period but EACH Period has a different init -> stitching blindly produces a SILENTLY corrupt file.
const MPD_MULTI_INIT = MPD_MULTI_PERIOD;

// SegmentBase: mpd-parser returns 0 segments, while resolvedUri IS a directly downloadable media file.
const MPD_SEGMENT_BASE = MPD;

describe('W1.5 parseDashSegments — video', () => {
  const r = parseDashSegments(MPD_TEMPLATE, TPL_BASE, 'v720');

  it('returns absolute segments for exactly the selected representation', () => {
    expect(r.segments).toHaveLength(15);
    expect(r.segments[0]!.uri).toBe('https://ex.com/dir/v720/seg-1.m4s');
    expect(r.segments[0]!.duration).toBe(4);
  });

  it('init segment is taken from segments[0].map', () => {
    expect(r.hasInit).toBe(true);
    expect(r.segments[0]!.initUri).toBe('https://ex.com/dir/v720/init.mp4');
  });

  it('DASH has no HLS-style AES-128 -> encryption none, no key', () => {
    expect(r.encryption).toBe('none');
    expect(r.isProtected).toBe(false);
    expect(r.segments[0]!.keyUri).toBeUndefined();
    expect(r.segments[0]!.keyMethod).toBeUndefined();
  });

  it('total duration is summed from the segments', () => {
    expect(r.totalDuration).toBe(60);
  });

  // W1.4 — `discontinuityCount` is a REQUIRED field of HlsSegmentsResult, so DASH must always fill
  // it in (one Period = no boundary at all). Missing it -> the upper layer reads `undefined`, compares
  // it with `> 0`, gets false: a §2.1-style silent failure rather than a loud error.
  it('one Period -> discontinuityCount = 0 (no false warning)', () => {
    expect(r.discontinuityCount).toBe(0);
  });

  // Selects the CORRECT representation, not just the first one encountered.
  it('selecting v360 yields v360 segments', () => {
    const r360 = parseDashSegments(MPD_TEMPLATE, TPL_BASE, 'v360');
    expect(r360.segments[0]!.uri).toBe('https://ex.com/dir/v360/seg-1.m4s');
  });
});

describe('W1.5 parseDashSegments — audio (DASH ALWAYS separates audio)', () => {
  it('looks up the audio representation by id', () => {
    const r = parseDashSegments(MPD_TEMPLATE, TPL_BASE, 'a128');
    expect(r.segments).toHaveLength(15);
    expect(r.segments[0]!.uri).toBe('https://ex.com/dir/a128/seg-1.m4s');
    expect(r.segments[0]!.initUri).toBe('https://ex.com/dir/a128/init.mp4');
  });
});

describe('W1.5 parseDashManifest must surface audio for popup selection', () => {
  const r = parseDashManifest(MPD_TEMPLATE, TPL_BASE);

  it('each variant carries a list of audio renditions, with exactly ONE selected', () => {
    const rends = r.variants[0]!.audioRenditions;
    expect(rends).toBeDefined();
    expect(rends!.map((x) => x.id)).toEqual(['a128']);
    expect(rends!.filter((x) => x.selected)).toHaveLength(1);
  });
});

describe('W1.5 HONESTLY BLOCK the cases that would produce silently corrupt files', () => {
  // Each Period has its own init: downloadTrack only loads the FIRST init then appends every
  // segment after it -> ffmpeg still accepts it, the job still reports "done", but the file is WRONG.
  // Better to stop and say so plainly.
  it('multi-Period with different inits -> states the unsupported reason, does NOT stay silent', () => {
    const r = parseDashSegments(
      MPD_MULTI_INIT,
      'https://ex.com/dir/multi.mpd',
      'v720',
    );
    expect(r.unsupportedReason).toBeTruthy();
    expect(r.unsupportedReason).toContain('Period');
  });

  // SegmentBase: 0 segments but resolvedUri is a directly downloadable .mp4 file -> must point to
  // that URL instead of reporting "playlist has no segments" (technically true, but entirely wrong about the cause).
  it('SegmentBase -> points to the direct-download URL instead of a confusing empty report', () => {
    const r = parseDashSegments(
      MPD_SEGMENT_BASE,
      'https://ex.com/dir/stream.mpd',
      '2',
    );
    expect(r.segments).toHaveLength(0);
    expect(r.directUrl).toBe('https://ex.com/dir/video720.mp4');
  });
});

describe('W1.5 id lookup must NOT hit the wrong representation when @id collides', () => {
  it('an id disambiguated with a suffix looks up the correctly disambiguated one', () => {
    const m = parseDashManifest(MPD_DUP_IDS, 'https://ex.com/x/manifest.mpd');
    const ids = m.variants.map((v) => v.id);
    // Each id must look up EXACTLY the representation with its own uri.
    const uris = ids.map(
      (id) =>
        parseDashSegments(MPD_DUP_IDS, 'https://ex.com/x/manifest.mpd', id)
          .directUrl,
    );
    expect(new Set(uris).size).toBe(3);
  });
});

// ===========================================================================
// Caught by adversarial review of W1.5's second half — ACTUALLY MEASURED, not inferred.
// ===========================================================================

// Multi-Period but the init template interpolates to the SAME URI (the most common SegmentTemplate shape).
// 🔬 ACTUALLY MEASURED on mpd-parser@1.4.0: 2 Periods -> 1 playlist, 4 segments, a single shared init, and
// REPEATED media URIs: seg-v0-1, seg-v0-2, seg-v0-1, seg-v0-2 (startNumber resets per Period).
// => The "multiple different inits" guard does NOT fire, and blind stitching produces the SAME 10
//    seconds appended twice, packaged as a 20-second video. ffmpeg accepts it, the job reports "done". SILENT corruption.
const MPD_MULTI_PERIOD_SAME_INIT = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT20S" minBufferTime="PT2S">
 <Period id="p0" duration="PT10S">
  <AdaptationSet mimeType="video/mp4">
   <SegmentTemplate media="seg-$RepresentationID$-$Number$.m4s" initialization="init-$RepresentationID$.mp4" duration="5" startNumber="1" timescale="1"/>
   <Representation id="v0" bandwidth="100000" width="640" height="360" codecs="avc1.42c01e"/>
  </AdaptationSet>
 </Period>
 <Period id="p1" duration="PT10S">
  <AdaptationSet mimeType="video/mp4">
   <SegmentTemplate media="seg-$RepresentationID$-$Number$.m4s" initialization="init-$RepresentationID$.mp4" duration="5" startNumber="1" timescale="1"/>
   <Representation id="v0" bandwidth="100000" width="640" height="360" codecs="avc1.42c01e"/>
  </AdaptationSet>
 </Period>
</MPD>`;

describe('W1.5 multi-Period must be blocked even when inits are IDENTICAL', () => {
  const r = parseDashSegments(
    MPD_MULTI_PERIOD_SAME_INIT,
    'https://x.test/m.mpd',
    'v0',
  );

  it('pins the measured phenomenon: segment URIs REPEAT because startNumber resets per Period', () => {
    expect(r.segments).toHaveLength(4);
    expect(new Set(r.segments.map((s) => s.uri)).size).toBe(2);
  });

  it('must state an unsupported reason, must NOT stitch out a file with duplicated content', () => {
    expect(r.unsupportedReason).toBeTruthy();
    expect(r.unsupportedReason).toContain('Period');
  });

  // W1.4 — the "one Period -> 0" case above is satisfied by a HARDCODED 0, so on its own it doesn't
  // prove parseDashSegments actually calls countDiscontinuities. A Period boundary is a REAL
  // boundary, so this is the one case that forces the number to come from the manifest itself.
  it('a Period boundary is a real boundary -> counts to 1 (not a hardcoded 0)', () => {
    expect(r.discontinuityCount).toBe(1);
  });
});

describe('W1.5 DASH: variant uri MUST be the manifest, not a media file', () => {
  // Every downstream layer (estimate/spoof/offscreen) treats `variantUrl` as the MANIFEST DOCUMENT
  // and parses its text. With SegmentBase, `resolvedUri` is a .mp4 file -> returning it means the
  // downstream layer fetches the raw video file, calls `res.text()` on it, and parses it as XML.
  // DASH track identity is `id`, so uri does NOT need to carry any information beyond where to fetch the manifest.
  it('SegmentBase: uri is still .mpd, not .mp4', () => {
    const m = parseDashManifest(MPD, 'https://ex.com/dir/stream.mpd');
    expect(m.variants[0]!.uri).toBe('https://ex.com/dir/stream.mpd');
  });

  it('SegmentTemplate: uri is also .mpd', () => {
    const m = parseDashManifest(MPD_TEMPLATE, TPL_BASE);
    expect(m.variants.every((v) => v.uri === TPL_BASE)).toBe(true);
  });
});

describe('W1.5 SegmentBase that cannot be downloaded yet must SAY SO, not lead into a dead end', () => {
  it('states a legible reason instead of letting the job die with "no segments"', () => {
    const r = parseDashSegments(MPD, 'https://ex.com/dir/stream.mpd', '2');
    expect(r.segments).toHaveLength(0);
    expect(r.unsupportedReason).toBeTruthy();
    // Still keeps the direct-download path for the follow-up work that routes to progressive.
    expect(r.directUrl).toBe('https://ex.com/dir/video720.mp4');
  });
});
