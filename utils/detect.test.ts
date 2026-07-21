import { describe, expect, it } from 'vitest';
import {
  buildMediaItem,
  classifyMedia,
  getExtension,
  isLikelySegment,
  markChildren,
  mediaId,
  shortenUrl,
  upsertMedia,
} from './detect';
import type { MediaItem } from './types';

describe('classifyMedia', () => {
  it('HLS by .m3u8 extension', () => {
    expect(classifyMedia({ url: 'https://a.com/master.m3u8?token=1' })).toBe(
      'hls',
    );
  });

  it('HLS by Content-Type (URL has no extension)', () => {
    expect(
      classifyMedia({
        url: 'https://a.com/stream',
        contentType: 'application/vnd.apple.mpegurl',
      }),
    ).toBe('hls');
  });

  it('DASH by .mpd and by content-type', () => {
    expect(classifyMedia({ url: 'https://a.com/v.mpd' })).toBe('dash');
    expect(
      classifyMedia({
        url: 'https://a.com/v',
        contentType: 'application/dash+xml',
      }),
    ).toBe('dash');
  });

  it('Progressive by extension', () => {
    for (const ext of ['mp4', 'webm', 'm4v', 'mov', 'mkv', 'ogg']) {
      expect(classifyMedia({ url: `https://a.com/clip.${ext}` })).toBe(
        'progressive',
      );
    }
  });

  it('Progressive by Content-Type video/*', () => {
    expect(
      classifyMedia({ url: 'https://a.com/file', contentType: 'video/mp4' }),
    ).toBe('progressive');
  });

  it('Skip .ts / .m4s segments', () => {
    expect(classifyMedia({ url: 'https://a.com/seg-000.ts' })).toBeNull();
    expect(classifyMedia({ url: 'https://a.com/seg1.m4s' })).toBeNull();
  });

  it('Skip fMP4 init segment (init.mp4)', () => {
    expect(classifyMedia({ url: 'https://a.com/init.mp4' })).toBeNull();
    expect(classifyMedia({ url: 'https://a.com/video_init-1.mp4' })).toBeNull();
  });

  it('Skip segment by Content-Type video/mp2t', () => {
    expect(
      classifyMedia({ url: 'https://a.com/seg', contentType: 'video/mp2t' }),
    ).toBeNull();
  });

  it('Return null for a non-media resource', () => {
    expect(classifyMedia({ url: 'https://a.com/app.js' })).toBeNull();
    expect(classifyMedia({ url: 'https://a.com/pic.png' })).toBeNull();
  });
});

describe('isLikelySegment', () => {
  it('recognizes .ts as a segment', () => {
    expect(isLikelySegment('https://a.com/x.ts')).toBe(true);
  });
  it('mp4 is normally NOT a segment', () => {
    expect(isLikelySegment('https://a.com/movie.mp4')).toBe(false);
  });
});

describe('getExtension', () => {
  it('strips query/hash', () => {
    expect(getExtension('https://a.com/v.MP4?x=1#y')).toBe('.mp4');
  });
  it('no extension -> ""', () => {
    expect(getExtension('https://a.com/stream')).toBe('');
  });
});

describe('shortenUrl', () => {
  it('keeps as-is when short', () => {
    expect(shortenUrl('https://a.com/v.mp4', 60)).toBe('https://a.com/v.mp4');
  });
  it('truncates when long, with a … mark', () => {
    const long = 'https://a.com/' + 'x'.repeat(100) + '/v.mp4';
    const s = shortenUrl(long, 30);
    expect(s.length).toBe(30);
    expect(s).toContain('…');
  });
});

describe('mediaId', () => {
  it('stable for the same url', () => {
    expect(mediaId('https://a.com/v.m3u8')).toBe(
      mediaId('https://a.com/v.m3u8'),
    );
  });
  it('different for different urls', () => {
    expect(mediaId('https://a.com/1.m3u8')).not.toBe(
      mediaId('https://a.com/2.m3u8'),
    );
  });
});

describe('buildMediaItem', () => {
  it('builds an item with id, type, default detectSource network', () => {
    const item = buildMediaItem({
      url: 'https://a.com/v.m3u8',
      tabId: 5,
      detectedAt: 1000,
    });
    expect(item).not.toBeNull();
    expect(item!.type).toBe('hls');
    expect(item!.tabId).toBe(5);
    expect(item!.detectSource).toBe('network');
  });

  it('returns null if not media', () => {
    expect(
      buildMediaItem({ url: 'https://a.com/app.js', tabId: 1, detectedAt: 0 }),
    ).toBeNull();
  });
});

describe('upsertMedia', () => {
  const mk = (url: string, extra: Partial<MediaItem> = {}): MediaItem => ({
    id: mediaId(url),
    type: 'hls',
    url,
    tabId: 1,
    detectedAt: 0,
    ...extra,
  });

  it('adds new -> changed true, list differs', () => {
    const base: MediaItem[] = [];
    const { list, changed } = upsertMedia(base, mk('https://a.com/1.m3u8'));
    expect(changed).toBe(true);
    expect(list).toHaveLength(1);
    expect(list).not.toBe(base);
  });

  it('duplicate url, no new field -> changed false, keeps old list', () => {
    const base = [mk('https://a.com/1.m3u8', { size: 10 })];
    const { list, changed } = upsertMedia(
      base,
      mk('https://a.com/1.m3u8', { size: 20 }),
    );
    expect(changed).toBe(false); // size already known -> not overwritten
    expect(list).toBe(base);
    expect(list[0]!.size).toBe(10);
  });

  it('duplicate url, fills in a missing field -> changed true, merges', () => {
    const base = [mk('https://a.com/1.m3u8')]; // no size/contentType yet
    const { list, changed } = upsertMedia(
      base,
      mk('https://a.com/1.m3u8', { size: 100, contentType: 'video/mp4' }),
    );
    expect(changed).toBe(true);
    expect(list).not.toBe(base);
    expect(list[0]!.size).toBe(100);
    expect(list[0]!.contentType).toBe('video/mp4');
  });
});

// --- W4.2: flag child playlists -> hidden from the popup -------------------------
// Context VERIFIED IN PRACTICE (Edge + extension + audio-separated fixture): one video = 3 "HLS"
// rows in the popup (master + video.m3u8 + audio.m3u8). §3.4 required W4.2 to ship together with
// W1.1, and it is now DEBT: since W1.1, offscreen muxes audio in on its own, so the audio row is
// now just confusing clutter (clicking it downloads an audio-only file).
describe('W4.2 markChildren', () => {
  const mkItem = (url: string, extra: Partial<MediaItem> = {}): MediaItem => ({
    id: mediaId(url),
    type: 'hls',
    url,
    tabId: 1,
    detectedAt: 1,
    ...extra,
  });

  const MASTER = 'https://ex.com/hls/master.m3u8';
  const VIDEO = 'https://ex.com/hls/video.m3u8';
  const AUDIO = 'https://ex.com/hls/audio.m3u8';

  it('flags child + parentUrl for matching items, leaves master alone', () => {
    const base = [mkItem(MASTER), mkItem(VIDEO), mkItem(AUDIO)];
    const { list, changed } = markChildren(base, [VIDEO, AUDIO], MASTER);
    expect(changed).toBe(true);
    expect(list.find((m) => m.url === MASTER)!.child).toBeUndefined();
    expect(list.find((m) => m.url === VIDEO)!.child).toBe(true);
    expect(list.find((m) => m.url === AUDIO)!.parentUrl).toBe(MASTER);
  });

  it('nothing to flag -> changed false, keeps the SAME old list', () => {
    // Matters for storage: changed=false -> no write to storage.session -> no
    // storage.onChanged fired -> popup doesn't needlessly re-render (and no write loop is created).
    const base = [mkItem(MASTER)];
    const { list, changed } = markChildren(base, [VIDEO], MASTER);
    expect(changed).toBe(false);
    expect(list).toBe(base);
  });

  it('flagging a second time -> changed false (idempotent)', () => {
    const base = [mkItem(MASTER), mkItem(VIDEO)];
    const once = markChildren(base, [VIDEO], MASTER);
    const twice = markChildren(once.list, [VIDEO], MASTER);
    expect(twice.changed).toBe(false);
    expect(twice.list).toBe(once.list);
  });

  it('does not mutate the original list/items', () => {
    const base = [mkItem(VIDEO)];
    markChildren(base, [VIDEO], MASTER);
    expect(base[0]!.child).toBeUndefined();
  });
});

// 🔴 REAL TRAP: onBeforeRequest adds the item, the master finishes parsing and flags children, THEN
// onHeadersReceived upserts a new version (with contentType, WITHOUT the child flag) on top of it.
// Losing the flag here = the clutter row reappears ~1 second later, right while the user is watching.
describe('W4.2 upsertMedia keeps the child flag on merge', () => {
  it('merging a new field must NOT clear the child/parentUrl flag', () => {
    const url = 'https://ex.com/hls/audio.m3u8';
    const base: MediaItem[] = [
      {
        id: mediaId(url),
        type: 'hls',
        url,
        tabId: 1,
        detectedAt: 1,
        child: true,
        parentUrl: 'https://ex.com/hls/master.m3u8',
      },
    ];
    const { list } = upsertMedia(base, {
      id: mediaId(url),
      type: 'hls',
      url,
      tabId: 1,
      detectedAt: 2,
      contentType: 'application/vnd.apple.mpegurl',
    });
    expect(list[0]!.child).toBe(true);
    expect(list[0]!.parentUrl).toBe('https://ex.com/hls/master.m3u8');
  });
});

// ── W2.1 ─────────────────────────────────────────────────────────────────────────────────────
describe('W2.1 upsertMedia carries the REAL captured header', () => {
  // 🔴 SILENT TRAP: `onBeforeRequest` creates the item FIRST, `onSendHeaders` only captures the
  // header AFTER. That means the header ALWAYS arrives on the MERGE branch, never on the add-new
  // branch. upsertMedia's merge follows a WHITELIST: a field outside that list gets swallowed by
  // `{...existing}` and `dirty` never gets set -> changed=false -> addTabMedia WRITES NOTHING AT
  // ALL. No error surfaces anywhere; W2.1 would be 100% dead while all 4 gates stay green. Exactly
  // the class of bug that has killed this project 3 times.
  const mk = (url: string, extra: Partial<MediaItem> = {}): MediaItem => ({
    id: 'x',
    type: 'hls',
    url,
    tabId: 1,
    detectedAt: 1,
    ...extra,
  });

  it('🔴 item ALREADY EXISTS + header arrives later -> MUST be written (changed=true)', () => {
    const base = [mk('https://a.com/1.m3u8')];
    const { list, changed } = upsertMedia(
      base,
      mk('https://a.com/1.m3u8', {
        sentHeaders: { referer: 'https://site.example/watch' },
      }),
    );
    expect(changed).toBe(true);
    expect(list[0]!.sentHeaders).toEqual({
      referer: 'https://site.example/watch',
    });
  });

  it('does not overwrite an existing snapshot (the first one is what the real player used)', () => {
    const base = [
      mk('https://a.com/1.m3u8', {
        sentHeaders: { referer: 'https://first/' },
      }),
    ];
    const { list } = upsertMedia(
      base,
      mk('https://a.com/1.m3u8', {
        sentHeaders: { referer: 'https://second/' },
      }),
    );
    expect(list[0]!.sentHeaders).toEqual({ referer: 'https://first/' });
  });

  it('a later detection WITHOUT headers -> keeps the already-captured version', () => {
    const base = [
      mk('https://a.com/1.m3u8', { sentHeaders: { referer: 'https://keep/' } }),
    ];
    const { list } = upsertMedia(
      base,
      mk('https://a.com/1.m3u8', { size: 99 }),
    );
    expect(list[0]!.sentHeaders).toEqual({ referer: 'https://keep/' });
    expect(list[0]!.size).toBe(99);
  });
});
