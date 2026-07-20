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

/**
 * IV của MỘT segment đã parse — đây là chỗ DUY NHẤT được quyết định "lấy IV ở đâu".
 *
 * 🔴 VÌ SAO TÁCH RA THÀNH HÀM RIÊNG (đừng gộp ngược vào chỗ gọi): lỗi IV KHÔNG QUAN SÁT ĐƯỢC qua
 * file kết quả. Đo trên fixture thật (2026-07-19): dùng nhầm chỉ số mảng thay cho `seg.seq` làm
 * lệch ĐÚNG 10/143.444 byte, số khung không đổi, md5 luồng hình không đổi, và file .mp4 ra GIỐNG
 * HỆT TỪNG BYTE — vì CBC chỉ cho IV chi phối khối 16 byte đầu mỗi segment. Nghĩa là e2e/ffprobe
 * mù hoàn toàn với lớp lỗi này. Tách thành hàm thuần là cách DUY NHẤT còn lại để có lưới: unit
 * test ghim thẳng vector IV (xem `utils/crypto.test.ts`).
 *
 * Hai luật, đúng thứ tự: `#EXT-X-KEY:IV=` nếu có; nếu không thì media sequence TUYỆT ĐỐI của
 * segment (KHÔNG phải vị trí của nó trong mảng — playlist có `#EXT-X-MEDIA-SEQUENCE` khác 0 thì
 * hai số đó lệch nhau).
 */
export function segmentIv(seg: {
  seq: number;
  iv?: Uint8Array;
}): Uint8Array<ArrayBuffer> {
  return hlsSegmentIv(seg.seq, seg.iv);
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
