import { describe, expect, it } from 'vitest';
import { decryptAes128Cbc, hlsSegmentIv, segmentIv } from './crypto';
import { parseHlsSegments } from './hls';

describe('hlsSegmentIv', () => {
  it('mặc định = media sequence big-endian ở 4 byte cuối', () => {
    const iv = hlsSegmentIv(1);
    expect(iv.length).toBe(16);
    expect(Array.from(iv.slice(0, 12))).toEqual(new Array(12).fill(0));
    expect(iv[15]).toBe(1);
  });

  it('seq lớn -> big-endian đúng', () => {
    const iv = hlsSegmentIv(0x01020304);
    expect(Array.from(iv.slice(12))).toEqual([1, 2, 3, 4]);
  });

  it('ưu tiên IV khai báo tường minh', () => {
    const explicit = new Uint8Array(16).fill(7);
    expect(hlsSegmentIv(5, explicit)).toEqual(explicit);
  });
});

describe('decryptAes128Cbc (round-trip WebCrypto)', () => {
  it('giải mã đúng dữ liệu đã mã hoá AES-128-CBC', async () => {
    const key = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const plain = new TextEncoder().encode('Xin chào HLS AES-128! '.repeat(20));

    const ck = await crypto.subtle.importKey(
      'raw',
      key,
      { name: 'AES-CBC' },
      false,
      ['encrypt'],
    );
    const enc = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, ck, plain);
    const dec = await decryptAes128Cbc(enc, key, iv);

    expect(new Uint8Array(dec)).toEqual(plain);
  });
});

// --- Vector IV lấy từ chính fixture e2e ---------------------------------------------------------
//
// 🔴 ĐÂY LÀ LƯỚI DUY NHẤT CHO LUẬT IV. Đừng xoá vì "e2e đã phủ AES rồi" — e2e KHÔNG phủ được:
// đo trên build thật (2026-07-19), đột biến dùng chỉ số mảng thay `seg.seq`, và đột biến bỏ qua
// `#EXT-X-KEY:IV=`, đều để cả 6 ca e2e AES VẪN XANH. CBC chỉ cho IV chi phối 16 byte đầu mỗi
// segment: file .mp4 ra GIỐNG HỆT TỪNG BYTE. Số đo: lệch 10/143.444 byte, cùng 100 khung.
//
// Playlist dưới đây COPY ĐÚNG hình dạng `e2e/fixture-server.mjs` sinh ra (MEDIA-SEQUENCE=7 cho
// biến thể `seq`, IV a1b2... cho biến thể `iv`). Đổi bên kia thì phải đổi cả bên này.
describe('segmentIv — luật lấy IV (e2e mù với lớp lỗi này)', () => {
  const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
  const playlist = (mediaSeq: number, ivAttr: string) =>
    `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${mediaSeq}\n` +
    `#EXT-X-KEY:METHOD=AES-128,URI="key0.bin"${ivAttr}\n` +
    Array.from({ length: 3 }, (_, i) => `#EXTINF:1.0,\nseg${i}.ts`).join('\n') +
    '\n#EXT-X-ENDLIST\n';

  it('IV mặc định theo MEDIA SEQUENCE TUYỆT ĐỐI, không theo vị trí trong mảng', () => {
    const r = parseHlsSegments(playlist(7, ''), 'http://x/hls-aes/seq/media.m3u8');
    // Nếu ai đó dùng chỉ số mảng (0,1,2) thì ba giá trị này thành ...00/01/02 -> ĐỎ tại đây.
    expect(r.segments.map((s) => hex(segmentIv(s)))).toEqual([
      '00000000000000000000000000000007',
      '00000000000000000000000000000008',
      '00000000000000000000000000000009',
    ]);
  });

  it('IV tường minh THẮNG media sequence, và giống nhau ở mọi segment', () => {
    const r = parseHlsSegments(
      playlist(3, ',IV=0xa1b2c3d4e5f60718293a4b5c6d7e8f90'),
      'http://x/hls-aes/iv/media.m3u8',
    );
    // Bản nào bỏ qua seg.iv sẽ ra ...03/04/05 thay vì a1b2... -> ĐỎ tại đây.
    expect(r.segments.map((s) => hex(segmentIv(s)))).toEqual(
      Array(3).fill('a1b2c3d4e5f60718293a4b5c6d7e8f90'),
    );
  });

  it('MEDIA-SEQUENCE=0 (ca dễ) vẫn đúng — đây là ca KHÔNG phân biệt được, ghim để khỏi tưởng nhầm', () => {
    const r = parseHlsSegments(playlist(0, ''), 'http://x/hls-aes/rot/media.m3u8');
    expect(hex(segmentIv(r.segments[0]!))).toBe('00000000000000000000000000000000');
  });
});
