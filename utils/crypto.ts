// AES-128 decryption for HLS segments using WebCrypto (no external lib needed).
// HLS spec: AES-128-CBC, data has PKCS7 padding (WebCrypto strips padding automatically on decrypt);
// IV = the IV declared in #EXT-X-KEY, or the media sequence number (128-bit big-endian).

/**
 * 16-byte IV for a segment: use the declared IV, or the big-endian media sequence (last 4 bytes).
 * Always returns an ArrayBuffer-backed buffer (matches the BufferSource type WebCrypto expects).
 */
export function hlsSegmentIv(
  seq: number,
  explicitIv?: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(16);
  if (explicitIv && explicitIv.length === 16) {
    iv.set(explicitIv);
    return iv;
  }
  // HLS: default IV = the segment's sequence number as a 128-bit big-endian value.
  new DataView(iv.buffer).setUint32(12, seq >>> 0, false);
  return iv;
}

/**
 * The IV for ONE parsed segment — this is the ONE AND ONLY place that decides "where does the IV come from".
 *
 * 🔴 WHY THIS IS SPLIT INTO ITS OWN FUNCTION (don't merge it back into the call site): an IV bug is
 * NOT OBSERVABLE through the output file. Measured on a real fixture (2026-07-19): mistakenly using
 * the array index instead of `seg.seq` shifts EXACTLY 10/143,444 bytes, the frame count doesn't
 * change, the video stream's md5 doesn't change, and the resulting .mp4 comes out BYTE-FOR-BYTE
 * IDENTICAL — because CBC only lets the IV affect the first 16-byte block of each segment. That
 * means e2e/ffprobe are completely blind to this class of bug. Splitting it into a pure function is
 * the ONLY remaining way to get a safety net: a unit test that pins the IV vector directly
 * (see `utils/crypto.test.ts`).
 *
 * Two rules, in order: `#EXT-X-KEY:IV=` if present; otherwise the segment's ABSOLUTE media
 * sequence (NOT its position in the array — if the playlist has a nonzero
 * `#EXT-X-MEDIA-SEQUENCE`, those two numbers diverge).
 */
export function segmentIv(seg: {
  seq: number;
  iv?: Uint8Array;
}): Uint8Array<ArrayBuffer> {
  return hlsSegmentIv(seg.seq, seg.iv);
}

/** Decrypts AES-128-CBC. WebCrypto strips PKCS7 padding automatically after decrypting. */
export async function decryptAes128Cbc(
  data: BufferSource,
  key: BufferSource,
  iv: BufferSource,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
}
