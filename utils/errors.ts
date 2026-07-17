// Chuẩn hoá lỗi bất kỳ thành chuỗi hiển thị. Tách khỏi entrypoints/offscreen/main.ts để unit test
// được (main.ts là entrypoint: có side-effect top-level + kéo theo Worker của ffmpeg).
//
// LƯU Ý @ffmpeg/ffmpeg: worker bắt lỗi rồi gửi `e.toString()` (dist/esm/worker.js:153), classes.js:54
// truyền THẲNG chuỗi đó vào reject -> ta nhận STRING "Error: <msg>", KHÔNG phải instance Error.
// Để nguyên thì UI ghép thành "Lỗi: Error: ..." (lặp xấu). Nhưng vẫn CÓ đường reject bằng Error thật
// (ERROR_NOT_LOADED ở classes.js:67, DOMException khi abort ở classes.js:75) -> phải xử lý cả hai.

// Tiền tố do Error.prototype.toString() sinh ra: "<name>: <message>". CHỈ bóc tên kết thúc bằng
// "Error" (Error/TypeError/RangeError/...) hoặc DOMException -> không cắt nhầm message hợp lệ có
// dấu ':' như "HTTP 403: forbidden".
// Phần tiền-tố-tên là TUỲ CHỌN: "Error:" trần phải khớp được (đây chính là ca của ffmpeg-core).
const ERROR_NAME_PREFIX_RE =
  /^(?:[A-Z][A-Za-z0-9_$]*)?(?:Error|DOMException):\s+/;

export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') {
    const stripped = e.replace(ERROR_NAME_PREFIX_RE, '');
    // Chuỗi chỉ có mỗi tiền tố -> giữ nguyên còn hơn hiện "Lỗi: " trống trơn.
    return stripped.trim() === '' ? e : stripped;
  }
  // Lỗi cross-realm (từ worker/iframe khác) không qua được `instanceof` -> lấy .message nếu có.
  if (
    typeof e === 'object' &&
    e !== null &&
    'message' in e &&
    typeof (e as { message: unknown }).message === 'string'
  ) {
    return (e as { message: string }).message;
  }
  return String(e);
}
