import { describe, expect, it } from 'vitest';
import {
  buildMediaItem,
  classifyMedia,
  getExtension,
  isLikelySegment,
  mediaId,
  shortenUrl,
  upsertMedia,
} from './detect';
import type { MediaItem } from './types';

describe('classifyMedia', () => {
  it('HLS theo đuôi .m3u8', () => {
    expect(classifyMedia({ url: 'https://a.com/master.m3u8?token=1' })).toBe(
      'hls',
    );
  });

  it('HLS theo Content-Type (URL không có đuôi)', () => {
    expect(
      classifyMedia({
        url: 'https://a.com/stream',
        contentType: 'application/vnd.apple.mpegurl',
      }),
    ).toBe('hls');
  });

  it('DASH theo .mpd và theo content-type', () => {
    expect(classifyMedia({ url: 'https://a.com/v.mpd' })).toBe('dash');
    expect(
      classifyMedia({
        url: 'https://a.com/v',
        contentType: 'application/dash+xml',
      }),
    ).toBe('dash');
  });

  it('Progressive theo đuôi mở rộng', () => {
    for (const ext of ['mp4', 'webm', 'm4v', 'mov', 'mkv', 'ogg']) {
      expect(classifyMedia({ url: `https://a.com/clip.${ext}` })).toBe(
        'progressive',
      );
    }
  });

  it('Progressive theo Content-Type video/*', () => {
    expect(
      classifyMedia({ url: 'https://a.com/file', contentType: 'video/mp4' }),
    ).toBe('progressive');
  });

  it('Bỏ qua segment .ts / .m4s', () => {
    expect(classifyMedia({ url: 'https://a.com/seg-000.ts' })).toBeNull();
    expect(classifyMedia({ url: 'https://a.com/seg1.m4s' })).toBeNull();
  });

  it('Bỏ qua init segment fMP4 (init.mp4)', () => {
    expect(classifyMedia({ url: 'https://a.com/init.mp4' })).toBeNull();
    expect(classifyMedia({ url: 'https://a.com/video_init-1.mp4' })).toBeNull();
  });

  it('Bỏ qua segment theo Content-Type video/mp2t', () => {
    expect(
      classifyMedia({ url: 'https://a.com/seg', contentType: 'video/mp2t' }),
    ).toBeNull();
  });

  it('Trả null với tài nguyên không phải media', () => {
    expect(classifyMedia({ url: 'https://a.com/app.js' })).toBeNull();
    expect(classifyMedia({ url: 'https://a.com/pic.png' })).toBeNull();
  });
});

describe('isLikelySegment', () => {
  it('nhận diện .ts là segment', () => {
    expect(isLikelySegment('https://a.com/x.ts')).toBe(true);
  });
  it('mp4 thường KHÔNG phải segment', () => {
    expect(isLikelySegment('https://a.com/movie.mp4')).toBe(false);
  });
});

describe('getExtension', () => {
  it('bỏ query/hash', () => {
    expect(getExtension('https://a.com/v.MP4?x=1#y')).toBe('.mp4');
  });
  it('không có đuôi -> ""', () => {
    expect(getExtension('https://a.com/stream')).toBe('');
  });
});

describe('shortenUrl', () => {
  it('giữ nguyên khi ngắn', () => {
    expect(shortenUrl('https://a.com/v.mp4', 60)).toBe('https://a.com/v.mp4');
  });
  it('rút gọn khi dài, có dấu …', () => {
    const long = 'https://a.com/' + 'x'.repeat(100) + '/v.mp4';
    const s = shortenUrl(long, 30);
    expect(s.length).toBe(30);
    expect(s).toContain('…');
  });
});

describe('mediaId', () => {
  it('ổn định cho cùng url', () => {
    expect(mediaId('https://a.com/v.m3u8')).toBe(
      mediaId('https://a.com/v.m3u8'),
    );
  });
  it('khác nhau cho url khác', () => {
    expect(mediaId('https://a.com/1.m3u8')).not.toBe(
      mediaId('https://a.com/2.m3u8'),
    );
  });
});

describe('buildMediaItem', () => {
  it('dựng item với id, type, detectSource mặc định network', () => {
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

  it('trả null nếu không phải media', () => {
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

  it('thêm mới -> changed true, list khác', () => {
    const base: MediaItem[] = [];
    const { list, changed } = upsertMedia(base, mk('https://a.com/1.m3u8'));
    expect(changed).toBe(true);
    expect(list).toHaveLength(1);
    expect(list).not.toBe(base);
  });

  it('trùng url, không có field mới -> changed false, giữ list cũ', () => {
    const base = [mk('https://a.com/1.m3u8', { size: 10 })];
    const { list, changed } = upsertMedia(
      base,
      mk('https://a.com/1.m3u8', { size: 20 }),
    );
    expect(changed).toBe(false); // size đã biết -> không ghi đè
    expect(list).toBe(base);
    expect(list[0]!.size).toBe(10);
  });

  it('trùng url, bổ sung field còn thiếu -> changed true, merge', () => {
    const base = [mk('https://a.com/1.m3u8')]; // chưa có size/contentType
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
