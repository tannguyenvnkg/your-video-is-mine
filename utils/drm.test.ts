import { describe, expect, it } from 'vitest';
import {
  DRM_UNSUPPORTED_ERROR,
  drmNameFromKeySystem,
  drmSystemFromHlsPlaylist,
  drmSystemsInMpd,
  isDrmKeySystem,
} from './drm';

// W7.1 — HARD BOUNDARY §7. `CLAUDE.md` DECLARES "on encountering DRM, STOP and report clearly", but
// before this package, grepping `requestMediaKeySystemAccess|MediaKeys|'encrypted'|keySystem` across
// entrypoints/ utils/ gave EXACTLY 0 HITS: the boundary was declared but never enforced. Every test
// below was RED before W7.1.

describe('drmNameFromKeySystem — resolve a DRM system name for a HUMAN reader', () => {
  it('recognizes the three major DRM systems', () => {
    expect(drmNameFromKeySystem('com.widevine.alpha')).toBe('Widevine');
    expect(drmNameFromKeySystem('com.microsoft.playready')).toBe('PlayReady');
    expect(drmNameFromKeySystem('com.apple.fps')).toBe('FairPlay');
  });

  it('recognizes variants with a version suffix too (real sites use this form)', () => {
    // Safari requests 'com.apple.fps.1_0'/'2_0'; Edge requests 'com.microsoft.playready.recommendation'.
    expect(drmNameFromKeySystem('com.apple.fps.1_0')).toBe('FairPlay');
    expect(drmNameFromKeySystem('com.apple.fps.2_0')).toBe('FairPlay');
    expect(drmNameFromKeySystem('com.microsoft.playready.recommendation')).toBe(
      'PlayReady',
    );
    expect(drmNameFromKeySystem('com.widevine.alpha.experiment')).toBe(
      'Widevine',
    );
  });

  it('is case-INSENSITIVE (string comes from the website, uncontrolled)', () => {
    expect(drmNameFromKeySystem('COM.WIDEVINE.ALPHA')).toBe('Widevine');
  });

  it('org.w3.clearkey is EME but NOT commercial DRM -> still blocked, its own name', () => {
    // Clear Key is technically decryptable, BUT it goes through EME. We don't touch EME, full stop —
    // carving out a special path for it would open exactly the door §7 forbids.
    expect(drmNameFromKeySystem('org.w3.clearkey')).toBe('Clear Key');
    expect(isDrmKeySystem('org.w3.clearkey')).toBe(true);
  });

  it('unknown string -> not recognized, and must NOT be treated as safe', () => {
    expect(drmNameFromKeySystem('com.example.unknown')).toBeNull();
    // Key point: an unknown system is still EME -> must still be BLOCKED. Default to safe, not default to allow.
    expect(isDrmKeySystem('com.example.unknown')).toBe(true);
  });

  it('an empty string is not a key system', () => {
    expect(isDrmKeySystem('')).toBe(false);
    expect(isDrmKeySystem('   ')).toBe(false);
  });
});

describe('DRM_UNSUPPORTED_ERROR — tell the truth, tell it clearly', () => {
  it('states the correct system name when known', () => {
    const msg = DRM_UNSUPPORTED_ERROR('Widevine');
    expect(msg).toMatch(/Widevine/);
    expect(msg).toMatch(/bảo vệ|DRM/i);
  });

  it('when the name is unknown, still produces a readable sentence, not an empty string', () => {
    const msg = DRM_UNSUPPORTED_ERROR();
    expect(msg.length).toBeGreaterThan(20);
    expect(msg).toMatch(/bảo vệ|DRM/i);
  });
});

describe('drmSystemsInMpd — DASH declares DRM right in the manifest', () => {
  it('catches Widevine via its standard UUID', () => {
    const mpd = `<?xml version="1.0"?><MPD><Period><AdaptationSet>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      </AdaptationSet></Period></MPD>`;
    expect(drmSystemsInMpd(mpd)).toEqual(['Widevine']);
  });

  it('an UPPERCASE UUID is still caught (real manifests often uppercase it)', () => {
    const mpd = `<ContentProtection schemeIdUri="urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED"/>`;
    expect(drmSystemsInMpd(mpd)).toEqual(['Widevine']);
  });

  it('catches PlayReady + FairPlay, merging multiple systems, NO duplicates', () => {
    const mpd = `<MPD>
      <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/>
      <ContentProtection schemeIdUri="urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2"/>
      <ContentProtection schemeIdUri="urn:uuid:9A04F079-9840-4286-AB92-E65BE0885F95"/>
    </MPD>`;
    expect(drmSystemsInMpd(mpd).sort()).toEqual(['FairPlay', 'PlayReady']);
  });

  it('a tag with a namespace prefix (cenc:) is still caught', () => {
    const mpd = `<cenc:ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>`;
    expect(drmSystemsInMpd(mpd)).toEqual(['Widevine']);
  });

  it('generic mp4protection (cenc) = ALREADY ENCRYPTED even if the vendor is unclear -> must still block', () => {
    const mpd = `<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>`;
    const got = drmSystemsInMpd(mpd);
    expect(got.length).toBeGreaterThan(0);
  });

  it('an unknown UUID is still counted as protected (default to safe)', () => {
    const mpd = `<ContentProtection schemeIdUri="urn:uuid:11111111-2222-3333-4444-555555555555"/>`;
    expect(drmSystemsInMpd(mpd).length).toBeGreaterThan(0);
  });

  it("a CLEAN manifest -> empty (this is the half that's easy to get wrong: don't wrongly block an ordinary video)", () => {
    const mpd = `<?xml version="1.0"?><MPD><Period><AdaptationSet mimeType="video/mp4">
      <Representation id="1" bandwidth="800000"><BaseURL>v.mp4</BaseURL></Representation>
      </AdaptationSet></Period></MPD>`;
    expect(drmSystemsInMpd(mpd)).toEqual([]);
  });

  it('the word "ContentProtection" appearing in a URL/comment must NOT count as DRM', () => {
    // Wrongly blocking an ordinary video is worse than missing a case: the user loses a feature without understanding why.
    const mpd = `<MPD><!-- no ContentProtection here -->
      <BaseURL>https://cdn.example/ContentProtection/clip.mp4</BaseURL></MPD>`;
    expect(drmSystemsInMpd(mpd)).toEqual([]);
  });
});

// --- HLS: DRM declared right in the playlist via #EXT-X-KEY / #EXT-X-SESSION-KEY ------------------------
//
// 🔴 REAL VULNERABILITY, MEASURED 2026-07-19 (don't "simplify away" these tests):
// Before the fix, the three most common DRM systems all SLIPPED PAST the §7 boundary. Measured with
// real m3u8-parser@7.2.0 via parseHlsSegments() itself:
//     FairPlay  (KEYFORMAT="com.apple.streamingkeydelivery") -> encryption='none', isProtected=FALSE
//     PlayReady (KEYFORMAT="com.microsoft.playready")        -> encryption='none', isProtected=FALSE
//     Widevine  (KEYFORMAT="urn:uuid:edef8ba9-...")          -> encryption='none', isProtected=FALSE
// Cause: m3u8-parser routes keys with an unrecognized KEYFORMAT into `manifest.contentProtection` and
// does NOT set `segment.key`, so anything inferred from `segment.key` sees the playlist as "clean".
// Consequence: the extension would download the entire DRM content and hand over a garbled file WITH
// A GREEN CHECKMARK — both crossing the §7 boundary and silently corrupting the output.
//
// => DRM must not be inferred from `segment.key`. Must inspect the raw playlist text directly.
describe('drmSystemFromHlsPlaylist (§7 boundary for HLS)', () => {
  const pl = (keyLine: string) =>
    `#EXTM3U\n#EXT-X-VERSION:5\n#EXT-X-TARGETDURATION:6\n${keyLine}\n#EXTINF:6.0,\nseg0.ts\n#EXT-X-ENDLIST\n`;

  it('FairPlay (Apple) -> blocked, states the correct vendor name', () => {
    const t = pl(
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://kid",KEYFORMAT="com.apple.streamingkeydelivery"',
    );
    expect(drmSystemFromHlsPlaylist(t)).toBe('FairPlay');
  });

  it('PlayReady (Microsoft) -> blocked, states the correct vendor name', () => {
    const t = pl(
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,AAAA",KEYFORMAT="com.microsoft.playready"',
    );
    expect(drmSystemFromHlsPlaylist(t)).toBe('PlayReady');
  });

  it('Widevine (KEYFORMAT in urn:uuid form) -> blocked, states the correct vendor name', () => {
    const t = pl(
      '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"',
    );
    expect(drmSystemFromHlsPlaylist(t)).toBe('Widevine');
  });

  it('an UNKNOWN KEYFORMAT is still blocked (default to safe — a whitelist would be a vulnerability)', () => {
    const t = pl(
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="x://y",KEYFORMAT="com.hang.moi.ra.doi"',
    );
    expect(drmSystemFromHlsPlaylist(t)).not.toBeNull();
  });

  it('#EXT-X-SESSION-KEY in a MASTER must also be blocked (a master has no segments at all)', () => {
    // A master advertises DRM via SESSION-KEY. Inspecting only #EXT-X-KEY would let master-level DRM slip through cleanly.
    const t =
      '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://k",KEYFORMAT="com.apple.streamingkeydelivery"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=800000\nmedia.m3u8\n';
    expect(drmSystemFromHlsPlaylist(t)).toBe('FairPlay');
  });

  it('bare SAMPLE-AES (no KEYFORMAT) -> still blocked', () => {
    expect(
      drmSystemFromHlsPlaylist(pl('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k.bin"')),
    ).not.toBeNull();
  });

  // --- THE OTHER DIRECTION: wrongly blocking is worse than missing a case (project rule) ---

  it('ordinary AES-128 -> NOT blocked (this is what we ARE ALLOWED to download)', () => {
    expect(
      drmSystemFromHlsPlaylist(pl('#EXT-X-KEY:METHOD=AES-128,URI="k.bin"')),
    ).toBeNull();
  });

  it('AES-128 with KEYFORMAT="identity" -> NOT blocked (identity is RFC 8216\'s default)', () => {
    const t = pl('#EXT-X-KEY:METHOD=AES-128,URI="k.bin",KEYFORMAT="identity"');
    expect(drmSystemFromHlsPlaylist(t)).toBeNull();
  });

  it('METHOD=NONE -> NOT blocked even with a KEYFORMAT present (a clear segment amid an encrypted stream)', () => {
    const t = pl(
      '#EXT-X-KEY:METHOD=NONE,KEYFORMAT="com.apple.streamingkeydelivery"',
    );
    expect(drmSystemFromHlsPlaylist(t)).toBeNull();
  });

  it('a fully CLEAN playlist -> NOT blocked', () => {
    expect(
      drmSystemFromHlsPlaylist(pl('#EXT-X-INDEPENDENT-SEGMENTS')),
    ).toBeNull();
  });

  it('the word KEYFORMAT appearing inside a segment URL must NOT count as DRM', () => {
    const t =
      '#EXTM3U\n#EXTINF:6.0,\nhttps://cdn.example/KEYFORMAT=com.apple.streamingkeydelivery/s0.ts\n#EXT-X-ENDLIST\n';
    expect(drmSystemFromHlsPlaylist(t)).toBeNull();
  });
});
