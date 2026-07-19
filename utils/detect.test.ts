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

// --- W4.2: đánh dấu playlist con -> popup ẩn đi -------------------------
// Bối cảnh ĐO THẬT (Edge + extension + fixture tách tiếng): một video = 3 dòng "HLS" trong popup
// (master + video.m3u8 + audio.m3u8). §3.4 bắt W4.2 đi kèm W1.1, và nay nó là NỢ: từ sau W1.1
// offscreen tự ghép tiếng, nên dòng tiếng chỉ còn là rác gây nhầm (bấm vào ra file chỉ-tiếng).
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

  it('gắn cờ con + parentUrl cho item khớp, chừa master lại', () => {
    const base = [mkItem(MASTER), mkItem(VIDEO), mkItem(AUDIO)];
    const { list, changed } = markChildren(base, [VIDEO, AUDIO], MASTER);
    expect(changed).toBe(true);
    expect(list.find((m) => m.url === MASTER)!.child).toBeUndefined();
    expect(list.find((m) => m.url === VIDEO)!.child).toBe(true);
    expect(list.find((m) => m.url === AUDIO)!.parentUrl).toBe(MASTER);
  });

  it('không có gì để đánh dấu -> changed false, giữ NGUYÊN list cũ', () => {
    // Quan trọng cho storage: changed=false -> không ghi storage.session -> không bắn
    // storage.onChanged -> popup không render lại vô ích (và không tạo vòng lặp ghi).
    const base = [mkItem(MASTER)];
    const { list, changed } = markChildren(base, [VIDEO], MASTER);
    expect(changed).toBe(false);
    expect(list).toBe(base);
  });

  it('đánh dấu lại lần hai -> changed false (idempotent)', () => {
    const base = [mkItem(MASTER), mkItem(VIDEO)];
    const once = markChildren(base, [VIDEO], MASTER);
    const twice = markChildren(once.list, [VIDEO], MASTER);
    expect(twice.changed).toBe(false);
    expect(twice.list).toBe(once.list);
  });

  it('không đột biến list/item gốc', () => {
    const base = [mkItem(VIDEO)];
    markChildren(base, [VIDEO], MASTER);
    expect(base[0]!.child).toBeUndefined();
  });
});

// 🔴 BẪY THẬT: onBeforeRequest thêm item, master parse xong đánh dấu con, RỒI onHeadersReceived
// mới upsert bản mới (có contentType, KHÔNG có cờ child) đè lên. Mất cờ ở đây = dòng rác hiện lại
// sau ~1 giây, đúng lúc user đang nhìn.
describe('W4.2 upsertMedia giữ cờ con khi merge', () => {
  it('merge field mới KHÔNG được xoá cờ child/parentUrl', () => {
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
describe('W2.1 upsertMedia mang được header THẬT đã bắt', () => {
  // 🔴 BẪY IM LẶNG: `onBeforeRequest` tạo item TRƯỚC, `onSendHeaders` mới bắt được header SAU.
  // Nghĩa là header LUÔN LUÔN tới ở nhánh MERGE, không bao giờ ở nhánh thêm-mới. Merge của
  // upsertMedia lại theo DANH SÁCH TRẮNG: field ngoài danh sách bị `{...existing}` nuốt và
  // `dirty` không bật -> changed=false -> addTabMedia KHÔNG GHI GÌ CẢ. Không một lỗi nào hiện ra;
  // tính năng W2.1 sẽ chết 100% mà 4 cổng vẫn xanh. Đúng loại lỗi đã giết dự án này 3 lần.
  const mk = (url: string, extra: Partial<MediaItem> = {}): MediaItem => ({
    id: 'x',
    type: 'hls',
    url,
    tabId: 1,
    detectedAt: 1,
    ...extra,
  });

  it('🔴 item ĐÃ TỒN TẠI + header tới sau -> PHẢI ghi được (changed=true)', () => {
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

  it('không ghi đè bản chụp đã có (bản đầu là bản player thật dùng)', () => {
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

  it('lần phát hiện sau KHÔNG mang header -> giữ nguyên bản đã bắt được', () => {
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
