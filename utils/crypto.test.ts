import { describe, expect, it } from 'vitest';
import { decryptAes128Cbc, hlsSegmentIv, segmentIv } from './crypto';
import { parseHlsSegments } from './hls';

describe('hlsSegmentIv', () => {
  it('defaults to media sequence, big-endian in the last 4 bytes', () => {
    const iv = hlsSegmentIv(1);
    expect(iv.length).toBe(16);
    expect(Array.from(iv.slice(0, 12))).toEqual(new Array(12).fill(0));
    expect(iv[15]).toBe(1);
  });

  it('large seq -> big-endian is correct', () => {
    const iv = hlsSegmentIv(0x01020304);
    expect(Array.from(iv.slice(12))).toEqual([1, 2, 3, 4]);
  });

  it('an explicitly declared IV takes priority', () => {
    const explicit = new Uint8Array(16).fill(7);
    expect(hlsSegmentIv(5, explicit)).toEqual(explicit);
  });
});

describe('decryptAes128Cbc (round-trip WebCrypto)', () => {
  it('correctly decrypts AES-128-CBC encrypted data', async () => {
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

// --- IV vectors taken from the actual e2e fixture ---------------------------------------------------------
//
// 🔴 THIS IS THE ONLY NET CATCHING THE IV RULE. Don't delete it because "e2e already covers AES" —
// e2e does NOT cover this: measured on a real build (2026-07-19), a mutation using the array index
// instead of `seg.seq`, and a mutation ignoring `#EXT-X-KEY:IV=`, both leave all 6 e2e AES cases
// STILL GREEN. CBC only lets the IV affect the first 16 bytes of each segment: the resulting .mp4
// comes out BYTE-IDENTICAL. Measured: a 10/143,444-byte diff, across the same 100 frames.
//
// The playlist below EXACTLY COPIES the shape `e2e/fixture-server.mjs` generates (MEDIA-SEQUENCE=7
// for the `seq` variant, IV a1b2... for the `iv` variant). Changing one side requires changing this one too.
describe('segmentIv — IV selection rule (e2e is blind to this class of bug)', () => {
  const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
  const playlist = (mediaSeq: number, ivAttr: string) =>
    `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${mediaSeq}\n` +
    `#EXT-X-KEY:METHOD=AES-128,URI="key0.bin"${ivAttr}\n` +
    Array.from({ length: 3 }, (_, i) => `#EXTINF:1.0,\nseg${i}.ts`).join('\n') +
    '\n#EXT-X-ENDLIST\n';

  it('IV defaults to the ABSOLUTE MEDIA SEQUENCE, not the array position', () => {
    const r = parseHlsSegments(
      playlist(7, ''),
      'http://x/hls-aes/seq/media.m3u8',
    );
    // If someone used the array index (0,1,2) instead, these three values would become ...00/01/02 -> RED here.
    expect(r.segments.map((s) => hex(segmentIv(s)))).toEqual([
      '00000000000000000000000000000007',
      '00000000000000000000000000000008',
      '00000000000000000000000000000009',
    ]);
  });

  it('an explicit IV WINS over media sequence, and is identical across every segment', () => {
    const r = parseHlsSegments(
      playlist(3, ',IV=0xa1b2c3d4e5f60718293a4b5c6d7e8f90'),
      'http://x/hls-aes/iv/media.m3u8',
    );
    // A version that ignores seg.iv would produce ...03/04/05 instead of a1b2... -> RED here.
    expect(r.segments.map((s) => hex(segmentIv(s)))).toEqual(
      Array(3).fill('a1b2c3d4e5f60718293a4b5c6d7e8f90'),
    );
  });

  it('MEDIA-SEQUENCE=0 (the easy case) is still correct — this is the case that CANNOT distinguish the two rules, pinned so it is not mistaken for proof', () => {
    const r = parseHlsSegments(
      playlist(0, ''),
      'http://x/hls-aes/rot/media.m3u8',
    );
    expect(hex(segmentIv(r.segments[0]!))).toBe(
      '00000000000000000000000000000000',
    );
  });
});
