import { describe, expect, it } from 'vitest';
import {
  parseHlsManifest,
  parseHlsSegments,
  resolveUri,
  variantLabel,
} from './hls';

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

  it('isMaster true, 2 variant', () => {
    expect(r.isMaster).toBe(true);
    expect(r.variants).toHaveLength(2);
  });

  it('sắp xếp giảm dần theo height (720 trước 360)', () => {
    expect(r.variants[0]!.height).toBe(720);
    expect(r.variants[1]!.height).toBe(360);
  });

  it('resolve uri tuyệt đối theo baseUrl', () => {
    expect(r.variants[0]!.uri).toBe(
      'https://cdn.example.com/dir/hi/index.m3u8',
    );
  });

  it('label dạng "<height>p" và có bandwidth/codecs', () => {
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

  it('isMaster false, 1 "variant" trỏ chính nó', () => {
    expect(r.isMaster).toBe(false);
    expect(r.variants).toHaveLength(1);
    expect(r.variants[0]!.uri).toBe('https://cdn.example.com/dir/index.m3u8');
  });

  it('đếm đúng số segment', () => {
    expect(r.segmentCount).toBe(2);
  });

  it('nhận diện AES-128 nhưng KHÔNG coi là protected (không phải DRM)', () => {
    expect(r.keyMethod).toBe('AES-128');
    expect(r.isProtected).toBe(false);
  });
});

describe('helpers', () => {
  it('resolveUri ghép tương đối -> tuyệt đối', () => {
    expect(resolveUri('a/b.m3u8', 'https://x.com/dir/master.m3u8')).toBe(
      'https://x.com/dir/a/b.m3u8',
    );
  });

  it('variantLabel fallback kbps rồi "Gốc"', () => {
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

  it('2 segment, uri tuyệt đối, seq theo media-sequence', () => {
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]!.uri).toBe('https://cdn.example.com/dir/seg10.ts');
    expect(r.segments[0]!.seq).toBe(10);
    expect(r.segments[1]!.seq).toBe(11);
  });

  it('AES-128: encryption aes-128, KHÔNG protected, key uri tuyệt đối, IV không khai báo', () => {
    expect(r.encryption).toBe('aes-128');
    expect(r.isProtected).toBe(false);
    expect(r.segments[0]!.keyUri).toBe('https://k.example.com/key.bin');
    expect(r.segments[0]!.iv).toBeUndefined();
  });

  it('tổng thời lượng', () => {
    expect(r.totalDuration).toBeCloseTo(18);
  });

  it('SAMPLE-AES -> isProtected (DỪNG, không hỗ trợ)', () => {
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

  it('không mã hoá -> encryption none, seq bắt đầu 0', () => {
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
