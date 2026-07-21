import { describe, expect, it } from 'vitest';
import { Parser } from 'm3u8-parser';
import {
  childUrlsOfMaster,
  countDiscontinuities,
  parseHlsManifest,
  parseHlsSegments,
  resolveUri,
  spoofTargetsFromSegments,
  uniqueVariantId,
  variantLabel,
} from './hls';

describe('W1.5 uniqueVariantId — variant identity must never collide', () => {
  it('uses the natural name when present, index when absent', () => {
    const used = new Set<string>();
    expect(uniqueVariantId('v720', 0, used)).toBe('v720');
    expect(uniqueVariantId(undefined, 1, used)).toBe('v1');
    // An empty/whitespace string is NOT an identity -> must fall back to index.
    expect(uniqueVariantId('   ', 2, used)).toBe('v2');
  });

  // DASH only requires Representation@id to be unique WITHIN one AdaptationSet -> two AdaptationSet
  // can still both declare id="1". Colliding and keeping it as-is reproduces exactly the bug being fixed.
  it('colliding names get split apart by index, never returns a duplicate', () => {
    const used = new Set<string>();
    const ids = ['1', '1', '1'].map((n, i) => uniqueVariantId(n, i, used));
    expect(ids).toEqual(['1', '1#1', '1#2']);
    expect(new Set(ids).size).toBe(3);
  });

  // Caught by W1.5 adversarial review: the branch avoiding `${base}#${index}` collisions used to NOT
  // re-check `used`, so a Representation@id that already has a '#' in that exact shape still produced
  // a DUPLICATE id.
  // ISO 23009-1 §5.3.5.2 only forbids whitespace in @id -> '#' is valid, not a made-up input.
  // This is an invariant of the whole W1.5 package, not an implementation detail: duplicate id = duplicate
  // React key = exactly the "click one row, the whole cluster lights up" bug this package exists to kill.
  it('name already in "base#index" shape must ALSO not collide with a generated id', () => {
    const used = new Set<string>();
    const ids = ['a#2', 'a', 'a'].map((n, i) => uniqueVariantId(n, i, used));
    expect(new Set(ids).size).toBe(3);
  });

  it('nested collisions across multiple layers must still yield unique ids', () => {
    const used = new Set<string>();
    const names = ['x#1', 'x#1#2', 'x', 'x', 'x'];
    const ids = names.map((n, i) => uniqueVariantId(n, i, used));
    expect(new Set(ids).size).toBe(names.length);
  });
});

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
hi/index.m3u8`;

const MEDIA_AES = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001
#EXTINF:9.9,
seg0.ts
#EXTINF:9.9,
seg1.ts
#EXT-X-ENDLIST`;

describe('parseHlsManifest - master', () => {
  const r = parseHlsManifest(MASTER, 'https://cdn.example.com/dir/master.m3u8');

  it('isMaster true, 2 variants', () => {
    expect(r.isMaster).toBe(true);
    expect(r.variants).toHaveLength(2);
  });

  it('sorted descending by height (720 before 360)', () => {
    expect(r.variants[0]!.height).toBe(720);
    expect(r.variants[1]!.height).toBe(360);
  });

  it('resolves uri to absolute based on baseUrl', () => {
    expect(r.variants[0]!.uri).toBe(
      'https://cdn.example.com/dir/hi/index.m3u8',
    );
  });

  it('label in "<height>p" shape and has bandwidth/codecs', () => {
    expect(r.variants[0]!.name).toBe('720p');
    expect(r.variants[0]!.bandwidth).toBe(2560000);
    expect(r.variants[0]!.codecs).toContain('avc1');
  });
});

describe('parseHlsManifest - media playlist', () => {
  const r = parseHlsManifest(
    MEDIA_AES,
    'https://cdn.example.com/dir/index.m3u8',
  );

  it('isMaster false, 1 "variant" pointing to itself', () => {
    expect(r.isMaster).toBe(false);
    expect(r.variants).toHaveLength(1);
    expect(r.variants[0]!.uri).toBe('https://cdn.example.com/dir/index.m3u8');
  });

  it('counts segments correctly', () => {
    expect(r.segmentCount).toBe(2);
  });

  it('detects AES-128 but does NOT treat it as protected (not DRM)', () => {
    expect(r.keyMethod).toBe('AES-128');
    expect(r.isProtected).toBe(false);
  });
});

describe('helpers', () => {
  it('resolveUri joins relative -> absolute', () => {
    expect(resolveUri('a/b.m3u8', 'https://x.com/dir/master.m3u8')).toBe(
      'https://x.com/dir/a/b.m3u8',
    );
  });

  it('variantLabel falls back to kbps then "Gốc"', () => {
    expect(variantLabel(720)).toBe('720p');
    expect(variantLabel(undefined, 800000)).toBe('800 kbps');
    expect(variantLabel(undefined, undefined)).toBe('Gốc');
  });
});

describe('parseHlsSegments', () => {
  const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=AES-128,URI="https://k.example.com/key.bin"
#EXTINF:9.0,
seg10.ts
#EXTINF:9.0,
seg11.ts
#EXT-X-ENDLIST`;
  const r = parseHlsSegments(MEDIA, 'https://cdn.example.com/dir/index.m3u8');

  it('2 segments, absolute uri, seq follows media-sequence', () => {
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]!.uri).toBe('https://cdn.example.com/dir/seg10.ts');
    expect(r.segments[0]!.seq).toBe(10);
    expect(r.segments[1]!.seq).toBe(11);
  });

  it('AES-128: encryption aes-128, NOT protected, absolute key uri, IV not declared', () => {
    expect(r.encryption).toBe('aes-128');
    expect(r.isProtected).toBe(false);
    expect(r.segments[0]!.keyUri).toBe('https://k.example.com/key.bin');
    expect(r.segments[0]!.iv).toBeUndefined();
  });

  it('total duration', () => {
    expect(r.totalDuration).toBeCloseTo(18);
  });

  it('SAMPLE-AES -> isProtected (STOP, not supported)', () => {
    const p = parseHlsSegments(
      `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"
#EXTINF:6,
s.ts
#EXT-X-ENDLIST`,
      'https://a.com/i.m3u8',
    );
    expect(p.encryption).toBe('sample-aes');
    expect(p.isProtected).toBe(true);
  });

  it('unencrypted -> encryption none, seq starts at 0', () => {
    const p = parseHlsSegments(
      `#EXTM3U
#EXTINF:5,
a.ts
#EXTINF:5,
b.ts
#EXT-X-ENDLIST`,
      'https://a.com/i.m3u8',
    );
    expect(p.encryption).toBe('none');
    expect(p.isProtected).toBe(false);
    expect(p.segments[0]!.seq).toBe(0);
  });
});

// ===========================================================================
// W0.4 — HARD-CASE FIXTURE. The old fixture above only encodes the EASY case (muxed master,
// segment without byterange, no discontinuity) — the only shape where the Batch 1
// bugs are harmless. That's why the test was green while the product was silent.
//
// The three layers of tests below, meant to be read together:
//
//  1. "library contract" — GREEN right away. Proves the data IS ALREADY PRESENT in
//     m3u8-parser and we're throwing it away. If this layer goes red => the parser changed
//     shape, NOT our bug => re-read before touching our own code.
//
//  2. it.fails(...) — a REAL bug, RED today. Vitest treats "red" as PASS so the whole
//     suite stays green (gate §1.2). Once Batch 1 is fixed, the test turns green
//     => it.fails FAILS IN REVERSE => forces it to be changed back to it(). A self-triggering
//     ratchet, not a dead TODO.
//     ⚠️ it.fails passes when the test throws ANY error => it CANNOT distinguish
//     "red because the feature is missing" from "red because it's wrong". So each it.fails carries
//     EXACTLY ONE assertion, always paired with a guard test (layer 3).
//
//  3. guard test — GREEN right away (vacuously correct since there's no audio to choose yet),
//     GREEN after a CORRECT fix, and RED if fixed WRONG. This is what catches a naive fix.
// ===========================================================================

/** Raw manifest from m3u8-parser (for testing the library contract). */
function rawManifest(text: string) {
  const p = new Parser();
  p.push(text);
  p.end();
  return p.manifest;
}

/** Shape of mediaGroups.AUDIO as ACTUALLY MEASURED on m3u8-parser@7.2.0 (not guessed). */
interface AudioRendition {
  default: boolean;
  autoselect: boolean;
  language?: string;
  /** ENTIRELY ABSENT (not undefined) when #EXT-X-MEDIA has no URI. */
  uri?: string;
}
type AudioGroups = Record<string, Record<string, AudioRendition>>;

function audioGroups(text: string): AudioGroups {
  const mg = rawManifest(text).mediaGroups as
    { AUDIO?: AudioGroups } | undefined;
  return mg?.AUDIO ?? {};
}

/**
 * The audio stream URL the variant ACTUALLY USES (empty string if nothing chosen yet).
 *
 * Can read both shapes currently being considered for W1.1, because the roadmap still
 * CONTRADICTS itself (see §2b): NGHIEN-CUU-VDH.md W1.1 step 2 says to add
 * `audioUri?: string`, while PROMPT-THUC-THI §3.2 + W4.4 says to carry the WHOLE LIST of
 * renditions. This helper stays neutral to both so the guard tests don't force a design.
 *
 * 🔧 W1.1: if a THIRD shape is chosen, this function must be updated — otherwise it
 * returns '' forever and every guard test using it goes vacuously and uselessly green.
 */
function selectedAudioUri(variant: unknown): string {
  const v = variant as {
    audioUri?: string;
    audioRenditions?: { uri?: string; selected?: boolean }[];
  };
  return v.audioUri ?? v.audioRenditions?.find((x) => x.selected)?.uri ?? '';
}

// --- Fixture: Twitter/X. Most common shape causing muted output ---------
// X's own traps, all three verified against a real manifest:
//  - NAME comes BEFORE TYPE  -> a regex anchored on "#EXT-X-MEDIA:TYPE=" slides right past it.
//  - NO DEFAULT              -> the "pick the DEFAULT rendition" heuristic returns EMPTY.
//  - Each tier has its own audio group -> MUST look up via the AUDIO= of the
//    chosen variant; taking the first #EXT-X-MEDIA would pair 128k audio with the 480x270 video.
const X_MASTER = `#EXTM3U
#EXT-X-MEDIA:NAME="Audio",AUTOSELECT=YES,TYPE=AUDIO,GROUP-ID="audio-128000",URI="/aud/128/pl.m3u8"
#EXT-X-MEDIA:NAME="Audio",AUTOSELECT=YES,TYPE=AUDIO,GROUP-ID="audio-64000",URI="/aud/64/pl.m3u8"
#EXT-X-MEDIA:NAME="Audio",AUTOSELECT=YES,TYPE=AUDIO,GROUP-ID="audio-32000",URI="/aud/32/pl.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2176000,RESOLUTION=1280x720,CODECS="avc1.4d001f,mp4a.40.2",AUDIO="audio-128000"
/vid/720/pl.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=832000,RESOLUTION=640x360,CODECS="avc1.4d001e,mp4a.40.2",AUDIO="audio-64000"
/vid/360/pl.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=288000,RESOLUTION=480x270,CODECS="avc1.4d0015,mp4a.40.2",AUDIO="audio-32000"
/vid/270/pl.m3u8`;
const X_BASE = 'https://video.twimg.com/ext_tw_video/1/pu/pl/master.m3u8';

describe('W0.4 m3u8-parser contract: audio data is ALREADY PRESENT, we are throwing it away', () => {
  const groups = audioGroups(X_MASTER);

  it('mediaGroups.AUDIO has all 3 groups, key inside a group is NAME', () => {
    expect(Object.keys(groups)).toEqual([
      'audio-128000',
      'audio-64000',
      'audio-32000',
    ]);
    expect(groups['audio-128000']!.Audio!.uri).toBe('/aud/128/pl.m3u8');
  });

  it('NAME before TYPE still parses correctly (a regex anchored on "TYPE=" is what slides past it)', () => {
    expect(groups['audio-32000']!.Audio!.uri).toBe('/aud/32/pl.m3u8');
  });

  it('X declares no DEFAULT -> default=false on EVERY rendition', () => {
    // => the "prefer default===true" heuristic returns EMPTY on X. Must fall back.
    const defaults = Object.values(groups).map(
      (g) => Object.values(g)[0]!.default,
    );
    expect(defaults).toEqual([false, false, false]);
  });

  it('parser does NOT resolve uri — verbatim from the manifest, we must resolveUri ourselves', () => {
    expect(rawManifest(X_MASTER).playlists![0]!.uri).toBe('/vid/720/pl.m3u8');
  });

  it('variant carrying AUDIO= points to the audio group of its OWN tier', () => {
    const pls = rawManifest(X_MASTER).playlists!;
    expect(pls.map((p) => p.attributes!.AUDIO)).toEqual([
      'audio-128000',
      'audio-64000',
      'audio-32000',
    ]);
  });
});

describe('W0.4/W1.1 master with separate audio (Twitter/X) -> downloaded file is MUTE', () => {
  const r = parseHlsManifest(X_MASTER, X_BASE);

  it('3 variants, sorted descending 720/360/270', () => {
    expect(r.variants.map((v) => v.height)).toEqual([720, 360, 270]);
  });

  // ✅ W1.1 (2026-07-17): changed it.fails -> it. The ratchet triggered itself ("Expect test to fail") as soon as
  // parseHlsManifest started reading mediaGroups.AUDIO — exactly as W0.4 was designed to, no one needed to remember.
  it('720p must carry the 128k audio playlist (before W1.1: lost audio -> MUTE)', () => {
    expect(JSON.stringify(r.variants[0])).toContain(
      'https://video.twimg.com/aud/128/pl.m3u8',
    );
  });

  // Pins down the requirement to look up the CORRECT group for its own tier.
  it("270p must carry its own tier's 32k audio", () => {
    expect(JSON.stringify(r.variants[2])).toContain(
      'https://video.twimg.com/aud/32/pl.m3u8',
    );
  });

  // GUARD: vacuously green today (no audio yet to pick wrong), GREEN when fixed
  // CORRECTLY, RED when fixed NAIVELY ("take the first #EXT-X-MEDIA" -> stuffs
  // 128k audio onto the 480x270 video).
  //
  // Assert on the CORRECT rendition that was CHOSEN, do NOT grep the whole variant object.
  // Reason (measured by implanting 4 W1.1 designs and running them for real): PROMPT-THUC-THI
  // §3.2 recommends the variant carry the WHOLE LIST of renditions. That design pairs
  // things CORRECTLY but still CARRIES the string '/aud/128/' in the list -> a guard that greps
  // JSON.stringify(variant) would go RED WRONGLY on exactly the fix the roadmap recommends.
  // "CARRYING" differs from "USING" — only "USING" is what decides whether the file ends up mute.
  it('if 270p has chosen audio it must be 32k, not 128k', () => {
    const used = selectedAudioUri(r.variants[2]);
    if (used === '') return; // today: no audio yet -> vacuously green, correct by design
    expect(used).toContain('/aud/32/');
    expect(used).not.toContain('/aud/128/');
  });

  // ⚠️ REMOVED: the guard "must not fabricate an audio URL outside the manifest's list".
  // It's IMPOSSIBLE to satisfy on the X fixture, not just poorly written — proven
  // by running it: a fix that NEVER reads rendition.uri and instead synthesizes
  // `/aud/${kbps}/pl.m3u8` from the GROUP-ID produces a string that EXACTLY MATCHES the real URL,
  // so NO assertion looking only at the output can tell "read from the manifest" apart from
  // "reconstructed identically". The old guard also went RED WRONGLY when the variant carried a valid `id`
  // that happened to contain a URL. A test that doesn't actually catch what its name claims = false confidence —
  // exactly the disease W0.4 exists to cure. The OBSERVABLE "fabrication" case lives in the
  // AUDIO_NO_URI fixture right below: there, the fabricated URL CANNOT come from the manifest.
});

// --- W1.1: audioRenditions shape (design finalized in §2b) -----------
// Decision: carry renditions from EVERY group + a `selected` flag on EXACTLY ONE that the variant uses.
// Reason for carrying the whole list: W4.4 (language picker) needs to see every choice WITHOUT having
// to change the messages.ts protocol again. Reason for exactly ONE `selected`: "CARRYING" differs from
// "USING" — only what's USED decides whether the file ends up mute.
describe('W1.1 audioRenditions: carries the whole list, picks exactly one', () => {
  const r = parseHlsManifest(X_MASTER, X_BASE);

  it('every variant carries renditions from EVERY group (so W4.4 can add a picker)', () => {
    expect(r.variants[0]!.audioRenditions).toHaveLength(3);
    expect(r.variants[0]!.audioRenditions!.map((x) => x.groupId)).toEqual([
      'audio-128000',
      'audio-64000',
      'audio-32000',
    ]);
  });

  it('EXACTLY ONE rendition is selected, and it belongs to the group the variant points to', () => {
    for (const v of r.variants) {
      const sel = v.audioRenditions!.filter((x) => x.selected);
      expect(sel).toHaveLength(1);
    }
    expect(
      r.variants[0]!.audioRenditions!.find((x) => x.selected)!.groupId,
    ).toBe('audio-128000');
    expect(
      r.variants[2]!.audioRenditions!.find((x) => x.selected)!.groupId,
    ).toBe('audio-32000');
  });

  // X never declares DEFAULT -> relying on DEFAULT alone would select NOTHING -> mute as before.
  it('still picks one even with no DEFAULT (falls back to first of the group)', () => {
    expect(
      r.variants.every((v) => v.audioRenditions!.every((x) => !x.default)),
    ).toBe(true);
    expect(selectedAudioUri(r.variants[0])).toBe(
      'https://video.twimg.com/aud/128/pl.m3u8',
    );
  });
});

describe('W1.1 picking a rendition within a group: prefer DEFAULT, else take the first', () => {
  // Multi-language group, DEFAULT is on the SECOND one -> it must be chosen, not the first.
  const MULTI = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",NAME="English",LANGUAGE="en",URI="en/pl.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",NAME="Spanish",LANGUAGE="es",DEFAULT=YES,URI="es/pl.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="g"
v/pl.m3u8`;

  it('DEFAULT=YES wins even when not listed first', () => {
    const r = parseHlsManifest(MULTI, 'https://ex.com/d/master.m3u8');
    expect(selectedAudioUri(r.variants[0])).toBe('https://ex.com/d/es/pl.m3u8');
  });

  it('still CARRIES both languages so W4.4 can build a picker', () => {
    const r = parseHlsManifest(MULTI, 'https://ex.com/d/master.m3u8');
    expect(r.variants[0]!.audioRenditions!.map((x) => x.language)).toEqual([
      'en',
      'es',
    ]);
  });
});

describe('W1.1 master does NOT split audio out -> keeps the single-input path', () => {
  it('master with no #EXT-X-MEDIA -> carries no audioRenditions', () => {
    const MUXED = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=90000,RESOLUTION=128x96,CODECS="avc1.42c00c,mp4a.40.2"
media.m3u8`;
    const r = parseHlsManifest(MUXED, 'https://ex.com/d/master.m3u8');
    expect(r.variants[0]!.audioRenditions).toBeUndefined();
    expect(selectedAudioUri(r.variants[0])).toBe('');
  });

  // Hybrid case: master DOES have mediaGroups but this variant does NOT point to AUDIO= -> its own audio is embedded.
  // Still CARRIES the list (W4.4 needs it) but selects NOTHING -> avoids wrongly pairing another variant's audio.
  it('variant without an AUDIO= declaration -> carries the list but selects NOTHING', () => {
    const MIXED = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",NAME="Main",DEFAULT=YES,URI="aud/pl.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.42c01e",AUDIO="g"
sep/pl.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180,CODECS="avc1.42c00c,mp4a.40.2"
muxed/pl.m3u8`;
    const r = parseHlsManifest(MIXED, 'https://ex.com/d/master.m3u8');
    const muxed = r.variants.find((v) => v.uri.includes('muxed'))!;
    const sep = r.variants.find((v) => v.uri.includes('sep'))!;
    expect(selectedAudioUri(sep)).toBe('https://ex.com/d/aud/pl.m3u8');
    expect(selectedAudioUri(muxed)).toBe('');
  });
});

// --- W1.1: two bugs caught by adversarial review (2026-07-17) ------------
// Both were introduced by the W1.1 fix itself, and both were verified by ACTUALLY RUNNING ffmpeg before
// fixing. Keeping the tests here so they don't regress.
describe('W1.1 AUDIO-ONLY variant -> must NOT select any audio (regression guard)', () => {
  // HLS Authoring Spec §2.3 REQUIRES the master to have an audio-only rendition, and it is often declared
  // as an #EXT-X-STREAM-INF too (Apple/Shaka/Bento4/MediaConvert all emit this shape). In that case
  // the variant's uri EXACTLY MATCHES the audio rendition's uri.
  const AUDIO_ONLY_VARIANT = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="English",DEFAULT=YES,URI="a1/prog.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=960x540,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud1"
v5/prog.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=68000,CODECS="mp4a.40.2",AUDIO="aud1"
a1/prog.m3u8`;

  const r = parseHlsManifest(
    AUDIO_ONLY_VARIANT,
    'https://ex.com/dir/master.m3u8',
  );
  const audioOnly = r.variants.find((v) => v.uri.endsWith('a1/prog.m3u8'))!;
  const withVideo = r.variants.find((v) => v.uri.endsWith('v5/prog.m3u8'))!;

  // Selecting audio for it = sending an audioUrl EXACTLY MATCHING variantUrl -> offscreen fetches the same
  // playlist twice then forces `-map 0:v:0` onto an input WITH NO video -> ffmpeg exit code 234 (measured for
  // real), job HARD-FAILS. Before W1.1 this exact variant downloaded fine (produced a valid audio-only file)
  // => this would be a REGRESSION.
  it('audio-only variant selects NO rendition (avoids exit code 234 + double fetch)', () => {
    expect(selectedAudioUri(audioOnly)).toBe('');
  });

  it('variant with video still selects audio normally', () => {
    expect(selectedAudioUri(withVideo)).toBe('https://ex.com/dir/a1/prog.m3u8');
  });
});

describe('W1.1 AUTOSELECT: RFC 8216 §4.3.4.1.1 — no DEFAULT, so consider AUTOSELECT', () => {
  // Commentary (AUTOSELECT=NO, HAS a URI) comes BEFORE Main (AUTOSELECT=YES, NO URI = audio already
  // present in the variant). The "take the first" fallback would hit Commentary -> `-map 1:a:0` replaces
  // the main audio with commentary audio: video correct, AUDIO COMPLETELY WRONG, job still shows 'done', no warning.
  const COMMENTARY = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",NAME="Commentary",AUTOSELECT=NO,URI="commentary/pl.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",NAME="Main",AUTOSELECT=YES
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="g"
muxed/pl.m3u8`;

  it('AUTOSELECT=YES wins over the AUTOSELECT=NO one listed first', () => {
    const r = parseHlsManifest(COMMENTARY, 'https://ex.com/dir/master.m3u8');
    const sel = r.variants[0]!.audioRenditions!.find((x) => x.selected)!;
    expect(sel.name).toBe('Main');
    // Main has no URI -> audio is already embedded in the variant -> keep the single-input path, no muxing in.
    expect(selectedAudioUri(r.variants[0])).toBe('');
  });
});

// --- Fixture: RFC 8216 §4.3.4.2.1 — #EXT-X-MEDIA WITHOUT a URI ------------
// "clients MUST assume that the audio data ... is present in every video
// Rendition" => audio is ALREADY embedded in the variant => keep the SINGLE input path.
// This case is not present in any real downloadable manifest -> had to be hand-crafted.
const AUDIO_NO_URI = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="grp",NAME="Main",DEFAULT=YES,LANGUAGE="en"
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="grp"
muxed/index.m3u8`;

describe('W0.4/W1.1 #EXT-X-MEDIA without a URI -> audio already embedded in the variant', () => {
  it('contract: the "uri" key is ENTIRELY ABSENT, not undefined', () => {
    const main = audioGroups(AUDIO_NO_URI).grp!.Main!;
    expect('uri' in main).toBe(false);
    expect(main.default).toBe(true);
  });

  // GUARD: green today, must STAY GREEN after W1.1. This is the ONLY "fabrication" case that is
  // OBSERVABLE: the rendition has no URI, so any audio URL that appears
  // CANNOT have come from the manifest.
  //
  // REAL COVERAGE (measured by implanting 5 fixes and running them, don't over-trust this):
  // only catches a fix that does `resolveUri(rend.uri ?? '')` -> synthesizes master.m3u8.
  // MISSES: (a) taking the video's own uri as a second audio input (a new Set swallows the duplicate),
  // (b) `String(undefined)` -> .../undefined (no .m3u8 suffix so the regex is blind to it),
  // (c) fabricating 'grp/audio.m4a' (any suffix other than .m3u8 is invisible to it).
  // These three holes can only be plugged once the real shape is known -> that's W1.1's job.
  it('generates no extra URL beyond the variant itself (keeps the single-input path)', () => {
    const r = parseHlsManifest(AUDIO_NO_URI, 'https://ex.com/dir/master.m3u8');
    const urls = JSON.stringify(r).match(/https?:[^"]+\.m3u8/g) ?? [];
    expect(new Set(urls)).toEqual(
      new Set(['https://ex.com/dir/muxed/index.m3u8']),
    );
  });
});

// --- Fixture: Vimeo — audio and video SHARE THE SAME PATH, differ only by query -----------
// Any parser that dedupes by path or strips the query would MERGE THE TWO TRACKS INTO ONE.
// URI uses ../../../ -> a real resolve is mandatory.
const VIMEO_MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-grp",NAME="Audio",DEFAULT=YES,URI="../../../parcel/v2/pl.m3u8?st=audio&tk=abc"
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="audio-grp"
../../../parcel/v2/pl.m3u8?st=video&tk=abc`;
const VIMEO_BASE = 'https://vod.vimeocdn.com/a/b/c/sep/master.m3u8';

describe('W0.4/W1.1 Vimeo: audio/video share a path, differ only in query', () => {
  it('contract: the two uris differ only in query st=audio / st=video', () => {
    const g = audioGroups(VIMEO_MASTER)['audio-grp']!.Audio!;
    expect(g.uri).toBe('../../../parcel/v2/pl.m3u8?st=audio&tk=abc');
    expect(rawManifest(VIMEO_MASTER).playlists![0]!.uri).toBe(
      '../../../parcel/v2/pl.m3u8?st=video&tk=abc',
    );
  });

  // ../../../ is computed from the DIRECTORY of the base (/a/b/c/sep/) -> going up 3 levels = /a/,
  // NOT back to the domain root. Expecting otherwise here is an easy trap to fall into.
  it('video resolves correctly through ../../../ and KEEPS the query intact', () => {
    const r = parseHlsManifest(VIMEO_MASTER, VIMEO_BASE);
    expect(r.variants[0]!.uri).toBe(
      'https://vod.vimeocdn.com/a/parcel/v2/pl.m3u8?st=video&tk=abc',
    );
  });

  // ✅ W1.1 (2026-07-17): changed it.fails -> it (ratchet self-triggered).
  it('variant must carry the audio playlist (st=audio), resolved to absolute', () => {
    const r = parseHlsManifest(VIMEO_MASTER, VIMEO_BASE);
    expect(JSON.stringify(r.variants[0])).toContain(
      'https://vod.vimeocdn.com/a/parcel/v2/pl.m3u8?st=audio&tk=abc',
    );
  });
});

// --- Fixture: Apple fMP4 — SAME variant uri across 3 audio groups -----------
// Pins down why W1.5 needs a mandatory `id`: keying/deduping by uri would lose ac-3/ec-3.
const APPLE_MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="a1/prog.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ac3",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="a2/prog.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ec3",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="a3/prog.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aac"
v/prog.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2600000,RESOLUTION=1280x720,CODECS="avc1.4d401f,ac-3",AUDIO="ac3"
v/prog.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2700000,RESOLUTION=1280x720,CODECS="avc1.4d401f,ec-3",AUDIO="ec3"
v/prog.m3u8`;

describe('W0.4/W1.5 Apple: 3 variants SHARING one video uri', () => {
  const r = parseHlsManifest(APPLE_MASTER, 'https://ex.com/dir/master.m3u8');

  it('keeps all 3 variants even though the uri is the same (must not dedupe by uri)', () => {
    expect(r.variants).toHaveLength(3);
    expect(new Set(r.variants.map((v) => v.uri)).size).toBe(1);
  });

  // W1.5 DONE: `id` is mandatory, keying/selection by id -> clicking one row only lights up one row.
  it('every variant must have its own `id` to distinguish it', () => {
    const ids = r.variants.map((v) => v.id);
    expect(new Set(ids).size).toBe(3);
  });
});

// --- Fixture: EXT-X-BYTERANGE -------------------------------------------
// Every #EXTINF points to the SAME URL, differing only by byte range. Discarding byterange =>
// looks like 3 segments with a duplicate URL => downloads the whole file 3 times, no Range header.
const BYTERANGE = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:10
#EXT-X-MAP:URI="all.ts",BYTERANGE="1000@0"
#EXTINF:9.0,
#EXT-X-BYTERANGE:75232@1000
all.ts
#EXTINF:9.0,
#EXT-X-BYTERANGE:82112
all.ts
#EXTINF:9.0,
#EXT-X-BYTERANGE:69864@200000
all.ts
#EXT-X-ENDLIST`;

describe('W0.4/W1.3 EXT-X-BYTERANGE', () => {
  const raw = rawManifest(BYTERANGE);
  const r = parseHlsSegments(BYTERANGE, 'https://cdn.example.com/dir/x.m3u8');

  it('contract: offset has ALREADY been accumulated into an ABSOLUTE value — do not add again', () => {
    // segment 2 declares "82112" with NO @offset -> the parser computes 1000+75232 itself.
    expect(raw.segments![0]!.byterange).toEqual({
      length: 75232,
      offset: 1000,
    });
    expect(raw.segments![1]!.byterange).toEqual({
      length: 82112,
      offset: 76232,
    });
    expect(raw.segments![2]!.byterange).toEqual({
      length: 69864,
      offset: 200000,
    });
  });

  it('contract: segment.map is ONE SHARED object — do not mutate it in place', () => {
    expect(raw.segments![0]!.map).toBe(raw.segments![1]!.map);
  });

  it('current state: 3 segments with an identical uri -> would download the same file 3 times', () => {
    expect(new Set(r.segments.map((s) => s.uri)).size).toBe(1);
  });

  // ✅ W1.3 (2026-07-17): it.fails -> it (ratchet self-triggered).
  it('segment must carry byterange', () => {
    expect(r.segments[0]).toHaveProperty('byterange');
  });

  // Pins down the double-accumulation trap (76232, NOT 152464).
  it("byterange.offset keeps the parser's absolute value as-is", () => {
    expect(r.segments[1]).toHaveProperty('byterange.offset', 76232);
    expect(r.segments[1]).toHaveProperty('byterange.length', 82112);
  });

  it('the init segment (#EXT-X-MAP) must carry its own byterange', () => {
    expect(r.segments[0]).toHaveProperty('initByterange.length', 1000);
    expect(r.segments[0]).toHaveProperty('initByterange.offset', 0);
  });
});

// --- Fixture: #EXT-X-MAP BYTERANGE MISSING @offset -------------------------
// map.byterange DIFFERS from segment.byterange: NOT accumulated, and when @offset is missing the
// `offset` key is ENTIRELY ABSENT (not defaulted to 0). This case is not in any real downloadable
// manifest -> hand-crafted per RFC 8216 §4.3.2.5.
const MAP_BYTERANGE_NO_OFFSET = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MAP:URI="init.mp4",BYTERANGE="800"
#EXTINF:9.0,
#EXT-X-BYTERANGE:5000@800
all.m4s
#EXT-X-ENDLIST`;

describe('W0.4/W1.3 #EXT-X-MAP BYTERANGE missing @offset', () => {
  it('contract: the `offset` key is ENTIRELY ABSENT on map.byterange (not defaulted to 0)', () => {
    const raw = rawManifest(MAP_BYTERANGE_NO_OFFSET);
    const mapBr = raw.segments![0]!.map!.byterange!;
    expect(mapBr.length).toBe(800);
    expect('offset' in mapBr).toBe(false);
  });

  // ✅ W1.3 (2026-07-17): it.fails -> it. Also pins down: a missing @offset on MAP means starting
  // from byte 0, NOT "continuing from the previous segment" as EXT-X-BYTERANGE's rule works.
  it('missing @offset on MAP -> must be understood as offset 0', () => {
    const r = parseHlsSegments(
      MAP_BYTERANGE_NO_OFFSET,
      'https://cdn.example.com/dir/x.m3u8',
    );
    expect(r.segments[0]).toHaveProperty('initByterange.offset', 0);
  });
});

// --- Fixture: EXT-X-DISCONTINUITY ---------------------------------------
// A stream with inserted ads resets the timestamp. Byte-concat + -c copy => DTS is not
// monotonic => the file plays fine at first then desyncs audio/freezes video, while the
// 'Non-monotonous DTS' log only goes to console.debug => the user gets "Download complete ✓".
const DISCONTINUITY = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
a0.ts
#EXTINF:10.0,
a1.ts
#EXT-X-DISCONTINUITY
#EXTINF:6.0,
ad0.ts
#EXT-X-DISCONTINUITY
#EXTINF:10.0,
b0.ts
#EXT-X-ENDLIST`;

describe('W0.4/W1.4 EXT-X-DISCONTINUITY', () => {
  const raw = rawManifest(DISCONTINUITY);
  const r = parseHlsSegments(
    DISCONTINUITY,
    'https://cdn.example.com/dir/x.m3u8',
  );

  it('contract: discontinuityStarts is an ARRAY INDEX, not a media sequence', () => {
    expect(raw.discontinuityStarts).toEqual([2, 3]);
  });

  it('contract: the `discontinuity` flag is ONLY present when = true', () => {
    expect('discontinuity' in raw.segments![0]!).toBe(false);
    expect(raw.segments![2]!.discontinuity).toBe(true);
  });

  it('contract: `timeline` increases with each discontinuity (a cleaner way to group)', () => {
    expect(raw.segments!.map((s) => s.timeline)).toEqual([0, 0, 1, 2]);
  });

  it('current state: parsing succeeds silently, no signal at all about the discontinuity', () => {
    expect(r.segments).toHaveLength(4);
    expect(r.totalDuration).toBeCloseTo(36);
  });

  it('the result must count discontinuities so a warning can still be shown', () => {
    expect(r).toHaveProperty('discontinuityCount', 2);
  });
});

// --- W1.4: three edge cases that REFUTE the obvious counting approach ------------------------
// 🔬 MEASURED FOR REAL (m3u8-parser@7.2.0, probe 2026-07-19) before writing a single line of code: using
// `discontinuityStarts.length` directly is WRONG IN BOTH DIRECTIONS. The three cases below pin down exactly
// where it's wrong — remove them and a naive fix stays green while the user gets a false warning (or a
// doubled count).
describe('W1.4 counting discontinuities: only count REAL JOINS inside the concatenated file', () => {
  it('clean playlist -> 0 (NO false warning)', () => {
    const r = parseHlsSegments(
      `#EXTM3U\n#EXTINF:9,\na.ts\n#EXTINF:9,\nb.ts\n#EXT-X-ENDLIST`,
      'https://a.com/i.m3u8',
    );
    expect(r.discontinuityCount).toBe(0);
  });

  // MEASURED: a tag placed BEFORE the first segment -> discontinuityStarts = [0]. That's a reset marker
  // relative to a segment range we do NOT download; inside the concatenated file there is no join at all.
  // Counting it means scaring the user for nothing.
  it('tag BEFORE the first segment -> 0 joins (starts=[0] but nothing before it to join to)', () => {
    const text = `#EXTM3U
#EXT-X-DISCONTINUITY
#EXTINF:9,
a.ts
#EXTINF:9,
b.ts
#EXT-X-ENDLIST`;
    expect(rawManifest(text).discontinuityStarts).toEqual([0]); // library contract
    expect(
      parseHlsSegments(text, 'https://a.com/i.m3u8').discontinuityCount,
    ).toBe(0);
  });

  // MEASURED: two consecutive tags -> discontinuityStarts = [1,1] (a REPEATED index) while there is only ONE join.
  it('two CONSECUTIVE tags -> 1 join, not 2 (starts repeats the index)', () => {
    const text = `#EXTM3U
#EXTINF:9,
a.ts
#EXT-X-DISCONTINUITY
#EXT-X-DISCONTINUITY
#EXTINF:9,
b.ts
#EXT-X-ENDLIST`;
    expect(rawManifest(text).discontinuityStarts).toEqual([1, 1]); // library contract
    expect(
      parseHlsSegments(text, 'https://a.com/i.m3u8').discontinuityCount,
    ).toBe(1);
  });

  // MEASURED: DISCONTINUITY-SEQUENCE says "there were already 3 breaks before this window", NOT a break
  // inside it.
  // 🔴 Pins down EACH HALF of the union in countDiscontinuities SEPARATELY. Through the real parse path, the
  // two sources (the `discontinuityStarts` array and the flag on each segment) ALWAYS agree, so deleting
  // either half still leaves the suite green -> one day someone "cleans up redundant code" and the safety
  // net is gone without anyone noticing. Calling the pure function directly with EXACTLY ONE source is the
  // only way to prove both halves are actually pulling weight.
  it('only the starts array (no segment flag) -> still counts correctly', () => {
    expect(countDiscontinuities([{}, {}, {}, {}], [2, 3])).toBe(2);
  });

  it('only the segment flag (no starts array) -> still counts correctly', () => {
    expect(
      countDiscontinuities([{}, {}, { discontinuity: true }, {}], undefined),
    ).toBe(1);
  });

  // An index outside the segment array range is not a join at all — drop it, don't count it blindly.
  it('index outside the segment range -> ignored', () => {
    expect(countDiscontinuities([{}, {}], [1, 5, -1])).toBe(1);
  });

  it('DISCONTINUITY-SEQUENCE with no tags at all -> 0', () => {
    const text = `#EXTM3U
#EXT-X-DISCONTINUITY-SEQUENCE:3
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:9,
a.ts
#EXTINF:9,
b.ts
#EXT-X-ENDLIST`;
    const raw = rawManifest(text);
    expect(raw.discontinuityStarts).toEqual([]);
    expect(raw.discontinuitySequence).toBe(3); // present, but must NOT be used for counting
    expect(
      parseHlsSegments(text, 'https://a.com/i.m3u8').discontinuityCount,
    ).toBe(0);
  });
});

// --- W4.2: URLs that are children of a master -> hidden from the popup --------------------------
// MEASURED FOR REAL before writing this (Edge + extension + a demuxed-audio fixture, 2026-07-17): one
// video produced a popup showing EXACTLY 3 ROWS all labeled "HLS" — master.m3u8, video.m3u8, audio.m3u8 —
// because webRequest sees all 3 and `classifyMedia` only looks at the `.m3u8` suffix. After W1.1, the
// audio row is NO LONGER how audio gets fetched (offscreen muxes it in automatically) => it's now just
// noise: clicking it produces a "video" that's audio-only.
describe('W4.2 childUrlsOfMaster: both variants + renditions of a master are CHILDREN', () => {
  // Matches the shape of the demuxed-audio e2e fixture (and of Twitter/X, Vimeo, CMAF).
  const MASTER_DEMUXED = `#EXTM3U
#EXT-X-MEDIA:NAME="Audio",AUTOSELECT=YES,TYPE=AUDIO,GROUP-ID="aud-64000",URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=128x96,CODECS="avc1.42c00c,mp4a.40.2",AUDIO="aud-64000"
video.m3u8`;

  it('returns BOTH the video playlist and the audio playlist (absolute uri)', () => {
    const r = parseHlsManifest(
      MASTER_DEMUXED,
      'https://ex.com/hls/master.m3u8',
    );
    expect(childUrlsOfMaster(r).sort()).toEqual([
      'https://ex.com/hls/audio.m3u8',
      'https://ex.com/hls/video.m3u8',
    ]);
  });

  // 🔴 A LETHAL TRAP: parsing a MEDIA playlist returns `variants: [{ uri: manifestUrl }]` — i.e.
  // itself. Without an `isMaster` guard, every child playlist would declare ITSELF as its OWN child
  // -> gets hidden -> the user opens the popup and sees NOTHING AT ALL on a site that serves a media
  // playlist directly (no master).
  it('MEDIA playlist -> has NO children (must not hide itself)', () => {
    const r = parseHlsManifest(
      `#EXTM3U\n#EXTINF:9.9,\nseg0.ts\n#EXT-X-ENDLIST`,
      'https://ex.com/hls/media.m3u8',
    );
    expect(r.isMaster).toBe(false);
    expect(childUrlsOfMaster(r)).toEqual([]);
  });

  it('multiple audio groups (Twitter/X style) -> gathers all of them, no duplicates', () => {
    const X = `#EXTM3U
#EXT-X-MEDIA:NAME="a128",TYPE=AUDIO,GROUP-ID="audio-128000",URI="aud/128/pl.m3u8"
#EXT-X-MEDIA:NAME="a64",TYPE=AUDIO,GROUP-ID="audio-64000",URI="aud/64/pl.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="audio-128000"
vid/720/pl.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=480x270,AUDIO="audio-64000"
vid/270/pl.m3u8`;
    const r = parseHlsManifest(X, 'https://video.twimg.com/x/master.m3u8');
    // audioRenditions carries EVERY group on EVERY variant -> easy to get duplicate URLs if dedupe is forgotten.
    expect(childUrlsOfMaster(r).sort()).toEqual([
      'https://video.twimg.com/x/aud/128/pl.m3u8',
      'https://video.twimg.com/x/aud/64/pl.m3u8',
      'https://video.twimg.com/x/vid/270/pl.m3u8',
      'https://video.twimg.com/x/vid/720/pl.m3u8',
    ]);
  });

  // A rendition with NO URI = audio is already embedded in the variant (RFC 8216 §4.3.4.2.1) -> no URL
  // to hide at all. Fabricating a URL here would wrongly hide the master itself.
  it('rendition with no URI -> generates no fabricated child URL', () => {
    const NO_URI = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",NAME="Main",AUTOSELECT=YES
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,AUDIO="g"
muxed/pl.m3u8`;
    const r = parseHlsManifest(NO_URI, 'https://ex.com/d/master.m3u8');
    expect(childUrlsOfMaster(r)).toEqual(['https://ex.com/d/muxed/pl.m3u8']);
  });
});

// --- W2.3: every host in the playlist -> spoof so a segment/key/init on a different host doesn't 403 ------
// §2.4: segments are often on a CDN with a different host than the playlist, and the AES key is almost
// ALWAYS on a different host — and that's exactly the thing whose Referer gets checked most. The old
// applySpoof only covered the playlist's host ⇒ job reaches 'fetching' then every segment 403s.
// spoofTargetsFromSegments returns ONE representative url per host so background can enable spoofing for all of them.
describe('W2.3 spoofTargetsFromSegments', () => {
  const MULTI_HOST = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k.bin"
#EXT-X-MAP:URI="https://init.example.com/init.mp4"
#EXTINF:6,
https://seg.example.com/0.ts
#EXTINF:6,
https://seg.example.com/1.ts
#EXT-X-ENDLIST`;

  it('gathers each host exactly once: segment + key + init', () => {
    const r = parseHlsSegments(MULTI_HOST, 'https://pl.example.com/media.m3u8');
    const hosts = spoofTargetsFromSegments(r.segments)
      .map((u) => new URL(u).hostname)
      .sort();
    expect(hosts).toEqual([
      'init.example.com',
      'keys.example.com',
      'seg.example.com',
    ]);
  });

  it('segments on the same host -> only one representative url (does not grow with segment count)', () => {
    const SAME = `#EXTM3U
#EXTINF:6,
https://cdn.example.com/0.ts
#EXTINF:6,
https://cdn.example.com/1.ts
#EXTINF:6,
https://cdn.example.com/2.ts
#EXT-X-ENDLIST`;
    const r = parseHlsSegments(SAME, 'https://cdn.example.com/media.m3u8');
    expect(spoofTargetsFromSegments(r.segments)).toHaveLength(1);
  });

  it('empty playlist -> empty array', () => {
    expect(spoofTargetsFromSegments([])).toEqual([]);
  });
});

// --- §7: DRM declared in the playlist must be BLOCKED, and plain AES-128 must NOT be blocked wrongly -------------
//
// 🔴 MEASURED 2026-07-19 before the fix: the first three DRM cases below all returned isProtected=FALSE,
// meaning the extension downloaded protected content directly. The cause lies in m3u8-parser (it swallows
// `segment.key` when KEYFORMAT is not identity), not in our own logic — so don't infer DRM from segment.key.
describe('parseHlsSegments — §7 boundary with a DRM playlist', () => {
  const pl = (keyLine: string) =>
    `#EXTM3U\n#EXT-X-VERSION:5\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n${keyLine}\n#EXTINF:6.0,\nseg0.ts\n#EXT-X-ENDLIST\n`;
  const U = 'https://x/media.m3u8';

  it('FairPlay -> isProtected + names the vendor', () => {
    const r = parseHlsSegments(
      pl(
        '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k",KEYFORMAT="com.apple.streamingkeydelivery"',
      ),
      U,
    );
    expect(r.isProtected).toBe(true);
    expect(r.drmName).toBe('FairPlay');
  });

  it('PlayReady -> isProtected', () => {
    const r = parseHlsSegments(
      pl(
        '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:x",KEYFORMAT="com.microsoft.playready"',
      ),
      U,
    );
    expect(r.isProtected).toBe(true);
  });

  it('Widevine (urn:uuid) -> isProtected', () => {
    const r = parseHlsSegments(
      pl(
        '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:x",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"',
      ),
      U,
    );
    expect(r.isProtected).toBe(true);
    expect(r.drmName).toBe('Widevine');
  });

  // THE REVERSE DIRECTION — blocking wrongly is even worse than missing a case.
  it('plain AES-128 -> NOT protected, still downloadable', () => {
    const r = parseHlsSegments(pl('#EXT-X-KEY:METHOD=AES-128,URI="k.bin"'), U);
    expect(r.isProtected).toBe(false);
    expect(r.encryption).toBe('aes-128');
    expect(r.drmName).toBeUndefined();
  });

  it('AES-128 with KEYFORMAT="identity" -> NOT protected', () => {
    const r = parseHlsSegments(
      pl('#EXT-X-KEY:METHOD=AES-128,URI="k.bin",KEYFORMAT="identity"'),
      U,
    );
    expect(r.isProtected).toBe(false);
  });

  it('master has a DRM #EXT-X-SESSION-KEY -> isProtected (a master has no segment to infer it from)', () => {
    const master =
      '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://k",KEYFORMAT="com.apple.streamingkeydelivery"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\nmedia.m3u8\n';
    const r = parseHlsManifest(master, 'https://x/master.m3u8');
    expect(r.isMaster).toBe(true);
    expect(r.isProtected).toBe(true);
    expect(r.drmName).toBe('FairPlay');
  });

  it('clean master -> NOT protected', () => {
    const master =
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\nmedia.m3u8\n';
    const r = parseHlsManifest(master, 'https://x/master.m3u8');
    expect(r.isProtected ?? false).toBe(false);
  });
});

// --- PACKAGE A: KEY SCOPE OF #EXT-X-MAP (RFC 8216 §4.3.2.5) --------------
//
// 🔴 REAL BUG (adversarial review, 2026-07-20): the init segment's key must be inferred from TAG POSITION,
// not from the segment's key. `#EXT-X-KEY` covers Media Initialization Sections declared by `#EXT-X-MAP`
// BETWEEN it and the NEXT `#EXT-X-KEY`. So:
//     KEY then MAP -> init is ENCRYPTED
//     MAP then KEY -> init is IN THE CLEAR (valid, common: the player reads codec info before requesting a key)
// The old code used `segment.key` for the init too, so it decrypted an init that was actually in the clear
// -> padding error -> WRONGLY KILLS a healthy stream while blaming the server. The e2e safety net is
// `fmp4-clear-init`; this is the cheap safety net.
//
// MEASURED on m3u8-parser@7.2.0: `segment.map.key` IS PRESENT in the first ordering, ABSENT in the second.
const KEY_BEFORE_MAP = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:11
#EXT-X-KEY:METHOD=AES-128,URI="k.bin",IV=0x7f3e1c0b9a8d6f4e2c1a0b9d8e7f6a5b
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2.0,
s0.m4s
#EXT-X-ENDLIST`;

const MAP_BEFORE_KEY = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:11
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="k.bin",IV=0x7f3e1c0b9a8d6f4e2c1a0b9d8e7f6a5b
#EXTINF:2.0,
s0.m4s
#EXT-X-ENDLIST`;

describe('PACKAGE A — #EXT-X-MAP key scope follows TAG POSITION', () => {
  it('KEY before MAP -> init CARRIES its own key (encrypted), with an explicit IV', () => {
    const r = parseHlsSegments(
      KEY_BEFORE_MAP,
      'https://cdn.example.com/d/x.m3u8',
    );
    const s = r.segments[0]!;
    expect(s.initUri).toBe('https://cdn.example.com/d/init.mp4');
    expect(s.initKeyMethod).toBe('AES-128');
    expect(s.initKeyUri).toBe('https://cdn.example.com/d/k.bin');
    expect(s.initIv).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(s.initIv!).toString('hex')).toBe(
      '7f3e1c0b9a8d6f4e2c1a0b9d8e7f6a5b',
    );
  });

  it('MAP before KEY -> init has NO key (left in the clear), even though the SEGMENT is still encrypted', () => {
    const r = parseHlsSegments(
      MAP_BEFORE_KEY,
      'https://cdn.example.com/d/x.m3u8',
    );
    const s = r.segments[0]!;
    expect(s.initUri).toBe('https://cdn.example.com/d/init.mp4');
    // This is the ANTI-WRONGFUL-KILL assertion: a value here = the pipeline would decrypt an init that's actually in the clear.
    expect(s.initKeyMethod).toBeUndefined();
    expect(s.initKeyUri).toBeUndefined();
    // ... while the segment is STILL encrypted — the two are independent, don't infer one from the other.
    expect(s.keyMethod).toBe('AES-128');
    expect(s.keyUri).toBe('https://cdn.example.com/d/k.bin');
  });

  it('the init key is on a different host -> spoofTargetsFromSegments must cover that host too', () => {
    const segs = parseHlsSegments(
      KEY_BEFORE_MAP.replace(
        'URI="k.bin"',
        'URI="https://keys.example.net/k.bin"',
      ),
      'https://cdn.example.com/d/x.m3u8',
    ).segments;
    const hosts = spoofTargetsFromSegments(segs).map(
      (u) => new URL(u).hostname,
    );
    expect(hosts).toContain('keys.example.net');
  });
});
