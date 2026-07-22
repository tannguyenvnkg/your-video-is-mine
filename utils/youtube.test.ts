import { describe, expect, it } from 'vitest';
import {
  avcHeights,
  buildPlayerRequestBody,
  classifyPlayability,
  extractVideoId,
  pickFormats,
  YT_CLIENT_ANDROID,
  YT_CLIENT_IOS,
  type YtStreamingData,
} from './youtube';

describe('extractVideoId', () => {
  it('reads the v param from a watch URL', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=jNQXAC9IVRw')).toBe(
      'jNQXAC9IVRw',
    );
  });
  it('reads a youtu.be short link', () => {
    expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });
  it('reads a /shorts/ URL', () => {
    expect(
      extractVideoId('https://www.youtube.com/shorts/9bZkp7q19f0?feature=x'),
    ).toBe('9bZkp7q19f0');
  });
  it('reads an /embed/ URL', () => {
    expect(extractVideoId('https://www.youtube.com/embed/kJQP7kiw5Fk')).toBe(
      'kJQP7kiw5Fk',
    );
  });
  it('reads m.youtube.com with extra params', () => {
    expect(
      extractVideoId('https://m.youtube.com/watch?v=M7lc1UVf-VE&t=30s'),
    ).toBe('M7lc1UVf-VE');
  });
  it('accepts a bare 11-char id', () => {
    expect(extractVideoId('jNQXAC9IVRw')).toBe('jNQXAC9IVRw');
  });
  it('returns null for a non-youtube URL', () => {
    expect(extractVideoId('https://vimeo.com/watch?v=jNQXAC9IVRw')).toBeNull();
  });
  it('returns null for a watch URL without v', () => {
    expect(extractVideoId('https://www.youtube.com/watch?list=abc')).toBeNull();
  });
  it('returns null for an id of the wrong length', () => {
    expect(extractVideoId('https://youtu.be/tooshort')).toBeNull();
  });
});

describe('classifyPlayability', () => {
  it('maps OK', () => {
    expect(classifyPlayability({ status: 'OK' })).toBe('ok');
  });
  it('maps LOGIN_REQUIRED (bot/age wall)', () => {
    expect(
      classifyPlayability({
        status: 'LOGIN_REQUIRED',
        reason: 'Sign in to confirm you’re not a bot',
      }),
    ).toBe('login_required');
  });
  it('maps UNPLAYABLE and ERROR to unplayable', () => {
    expect(classifyPlayability({ status: 'UNPLAYABLE' })).toBe('unplayable');
    expect(classifyPlayability({ status: 'ERROR' })).toBe('unplayable');
  });
  it('maps missing/unknown to unknown', () => {
    expect(classifyPlayability(null)).toBe('unknown');
    expect(classifyPlayability({ status: 'SOMETHING_NEW' })).toBe('unknown');
  });
});

// Realistic ANDROID-client streamingData (measured shape): separate A/V, `url` present, no cipher.
const SD: YtStreamingData = {
  adaptiveFormats: [
    {
      itag: 137,
      url: 'https://r.googlevideo.com/vp?itag=137',
      mimeType: 'video/mp4; codecs="avc1.640028"',
      bitrate: 4_000_000,
      width: 1920,
      height: 1080,
      contentLength: '50000000',
    },
    {
      itag: 136,
      url: 'https://r.googlevideo.com/vp?itag=136',
      mimeType: 'video/mp4; codecs="avc1.4d401f"',
      bitrate: 2_000_000,
      width: 1280,
      height: 720,
      contentLength: '25000000',
    },
    {
      itag: 248,
      url: 'https://r.googlevideo.com/vp?itag=248',
      mimeType: 'video/webm; codecs="vp9"',
      bitrate: 3_000_000,
      width: 1920,
      height: 1080,
      contentLength: '40000000',
    },
    {
      // cipher-only video (no direct url) -> must be SKIPPED in v1 (no descrambler)
      itag: 400,
      mimeType: 'video/mp4; codecs="avc1.640033"',
      signatureCipher: 's=abc&url=https%3A%2F%2Fx',
      bitrate: 8_000_000,
      width: 2560,
      height: 1440,
    },
    {
      itag: 140,
      url: 'https://r.googlevideo.com/vp?itag=140',
      mimeType: 'audio/mp4; codecs="mp4a.40.2"',
      bitrate: 130_000,
      contentLength: '3000000',
    },
    {
      itag: 251,
      url: 'https://r.googlevideo.com/vp?itag=251',
      mimeType: 'audio/webm; codecs="opus"',
      bitrate: 140_000,
      contentLength: '3200000',
    },
  ],
};

describe('pickFormats', () => {
  it('picks avc1 1080p + AAC by default', () => {
    const p = pickFormats(SD, { maxHeight: 1080 });
    expect(p?.video.itag).toBe(137);
    expect(p?.audio.itag).toBe(140);
  });
  it('respects maxHeight (720 cap picks itag 136, not 137)', () => {
    const p = pickFormats(SD, { maxHeight: 720 });
    expect(p?.video.itag).toBe(136);
  });
  it('skips cipher-only formats even when they are higher quality', () => {
    // itag 400 (1440p) has no url -> never chosen despite being the biggest.
    const p = pickFormats(SD, { maxHeight: 2160 });
    expect(p?.video.itag).toBe(137);
  });
  it('falls back to a non-avc1 video only when no avc1 has a url', () => {
    const onlyVp9: YtStreamingData = {
      adaptiveFormats: [
        SD.adaptiveFormats![2]!, // vp9 1080p with url
        SD.adaptiveFormats![4]!, // aac audio
      ],
    };
    const p = pickFormats(onlyVp9, { maxHeight: 1080 });
    expect(p?.video.itag).toBe(248);
    expect(p?.audio.itag).toBe(140);
  });
  it('prefers avc1 even when a higher-bitrate vp9 exists at the same height', () => {
    // Mutation guard: drop the avc1 preference and vp9 (higher bitrate) would win -> this fails.
    const sd: YtStreamingData = {
      adaptiveFormats: [
        {
          itag: 137,
          url: 'https://r.googlevideo.com/vp?itag=137',
          mimeType: 'video/mp4; codecs="avc1.640028"',
          bitrate: 4_000_000,
          height: 1080,
        },
        {
          itag: 248,
          url: 'https://r.googlevideo.com/vp?itag=248',
          mimeType: 'video/webm; codecs="vp9"',
          bitrate: 9_000_000,
          height: 1080,
        },
        {
          itag: 140,
          url: 'https://r.googlevideo.com/vp?itag=140',
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          bitrate: 130_000,
        },
      ],
    };
    expect(pickFormats(sd, { maxHeight: 1080 })?.video.itag).toBe(137);
  });
  it('prefers AAC audio over opus', () => {
    const p = pickFormats(SD, { maxHeight: 1080 });
    expect(p?.audio.itag).toBe(140); // not 251, even though opus has higher bitrate
  });
  it('returns null when there is no audio', () => {
    const noAudio: YtStreamingData = {
      adaptiveFormats: SD.adaptiveFormats!.filter((f) =>
        f.mimeType.startsWith('video/'),
      ),
    };
    expect(pickFormats(noAudio, {})).toBeNull();
  });
  it('returns null when there is no usable video', () => {
    const noVideo: YtStreamingData = {
      adaptiveFormats: SD.adaptiveFormats!.filter((f) =>
        f.mimeType.startsWith('audio/'),
      ),
    };
    expect(pickFormats(noVideo, {})).toBeNull();
  });
  it('returns null for empty/missing streaming data', () => {
    expect(pickFormats(null, {})).toBeNull();
    expect(pickFormats({}, {})).toBeNull();
  });
});

describe('buildPlayerRequestBody', () => {
  it('wraps the ANDROID client context with the measured flags', () => {
    const body = buildPlayerRequestBody('jNQXAC9IVRw', YT_CLIENT_ANDROID);
    expect(body.videoId).toBe('jNQXAC9IVRw');
    expect(body.contentCheckOk).toBe(true);
    expect(body.racyCheckOk).toBe(true);
    // Exactly the client that measured OK (spec 2026-07-22): ANDROID 20.10.38, androidSdkVersion 34.
    expect(body.context.client.clientName).toBe('ANDROID');
    expect(body.context.client.clientVersion).toBe('20.10.38');
    expect(body.context.client.androidSdkVersion).toBe(34);
  });
  it('wraps the IOS fallback client context', () => {
    const body = buildPlayerRequestBody('jNQXAC9IVRw', YT_CLIENT_IOS);
    expect(body.context.client.clientName).toBe('IOS');
    expect(body.context.client.clientVersion).toBe('20.10.4');
    expect(body.context.client.deviceModel).toBe('iPhone16,2');
  });
  it('serializes to the exact JSON shape the probe posted', () => {
    // Guard: the request body must be a plain, stable object (no undefined keys leaking codec noise).
    const body = buildPlayerRequestBody('abcdefghijk', YT_CLIENT_ANDROID);
    const round = JSON.parse(JSON.stringify(body)) as typeof body;
    expect(round.context.client.hl).toBe('en');
    expect(round.context.client.gl).toBe('US');
  });
});

describe('avcHeights', () => {
  it('lists distinct avc1 heights (<= cap) with a usable url, highest first', () => {
    // SD has avc1 1080 (137) + avc1 720 (136), plus a vp9 1080 and a cipher-only 1440 (no url).
    expect(avcHeights(SD, 1080)).toEqual([1080, 720]);
  });
  it('respects the height cap', () => {
    expect(avcHeights(SD, 720)).toEqual([720]);
  });
  it('excludes the cipher-only (no url) formats even above the cap', () => {
    // itag 400 is 1440p but has no url -> must not appear.
    expect(avcHeights(SD, 2160)).toEqual([1080, 720]);
  });
  it('falls back to non-avc1 heights only when no avc1 has a url', () => {
    const onlyVp9: YtStreamingData = {
      adaptiveFormats: [SD.adaptiveFormats![2]!, SD.adaptiveFormats![4]!],
    };
    expect(avcHeights(onlyVp9, 1080)).toEqual([1080]);
  });
  it('returns [] for empty/missing streaming data', () => {
    expect(avcHeights(null)).toEqual([]);
    expect(avcHeights({})).toEqual([]);
  });
});

describe('classifyPlayability — LIVE_STREAM_OFFLINE', () => {
  it('maps LIVE_STREAM_OFFLINE to unplayable', () => {
    expect(classifyPlayability({ status: 'LIVE_STREAM_OFFLINE' })).toBe(
      'unplayable',
    );
  });
});

describe('pickFormats — bitrate tie-break at equal height', () => {
  it('picks the higher-bitrate avc1 when two avc1 share the same height', () => {
    // Mutation guard: flip/remove the bitrate comparator and itag 1 (lower bitrate) would win.
    const sd: YtStreamingData = {
      adaptiveFormats: [
        {
          itag: 1,
          url: 'u1',
          mimeType: 'video/mp4; codecs="avc1.4d401f"',
          bitrate: 1_000_000,
          height: 1080,
        },
        {
          itag: 2,
          url: 'u2',
          mimeType: 'video/mp4; codecs="avc1.640028"',
          bitrate: 5_000_000,
          height: 1080,
        },
        {
          itag: 140,
          url: 'a1',
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          bitrate: 130_000,
        },
      ],
    };
    expect(pickFormats(sd, { maxHeight: 1080 })?.video.itag).toBe(2);
  });
});

// 🔴 Regression: avcHeights (what the picker shows) and pickFormats (what we download) MUST agree.
// A video format with a usable url but NO `height` once diverged the two paths — avc1-in-pickFormats
// but excluded-in-avcHeights -> "advertise 1080, deliver an unknown-res avc1". Both now exclude it.
describe('avcHeights / pickFormats consistency (no-height formats)', () => {
  it('a height-less avc1 is excluded from BOTH (never advertised, never picked)', () => {
    const sd: YtStreamingData = {
      adaptiveFormats: [
        {
          itag: 999, // avc1 with url but NO height
          url: 'u999',
          mimeType: 'video/mp4; codecs="avc1.640028"',
          bitrate: 500_000,
        },
        {
          itag: 248, // vp9 1080 fallback
          url: 'u248',
          mimeType: 'video/webm; codecs="vp9"',
          bitrate: 3_000_000,
          height: 1080,
        },
        {
          itag: 140,
          url: 'a1',
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          bitrate: 130_000,
        },
      ],
    };
    // Picker advertises 1080 (the vp9)...
    expect(avcHeights(sd)).toEqual([1080]);
    // ...and the download delivers THAT SAME 1080 vp9 — not the height-less avc1.
    const picked = pickFormats(sd);
    expect(picked?.video.itag).toBe(248);
    expect(picked?.video.height).toBe(1080);
  });
  it('a height-less avc1 as the ONLY video -> both agree it is not offered', () => {
    const sd: YtStreamingData = {
      adaptiveFormats: [
        {
          itag: 999,
          url: 'u999',
          mimeType: 'video/mp4; codecs="avc1.640028"',
          bitrate: 500_000,
        },
        {
          itag: 140,
          url: 'a1',
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          bitrate: 130_000,
        },
      ],
    };
    expect(avcHeights(sd)).toEqual([]);
    expect(pickFormats(sd)).toBeNull();
  });
});
