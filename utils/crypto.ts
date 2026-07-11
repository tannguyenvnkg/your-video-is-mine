// Giải mã AES-128 cho segment HLS bằng WebCrypto (không cần lib ngoài).
// Chuẩn HLS: AES-128-CBC, dữ liệu có PKCS7 padding (WebCrypto tự bỏ padding khi decrypt);
// IV = IV khai báo trong #EXT-X-KEY, hoặc số thứ tự media sequence (128-bit big-endian).

/**
 * IV 16 byte cho segment: dùng IV khai báo, hoặc media sequence big-endian (4 byte cuối).
 * Luôn trả buffer ArrayBuffer-backed (hợp kiểu BufferSource cho WebCrypto).
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
  // HLS: IV mặc định = số thứ tự segment dạng 128-bit big-endian.
  new DataView(iv.buffer).setUint32(12, seq >>> 0, false);
  return iv;
}

/** Giải mã AES-128-CBC. WebCrypto tự bỏ PKCS7 padding sau khi giải mã. */
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
