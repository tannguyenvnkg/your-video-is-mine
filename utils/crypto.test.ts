import { describe, expect, it } from 'vitest';
import { decryptAes128Cbc, hlsSegmentIv } from './crypto';

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
