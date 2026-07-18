// W2.5 — logic thuần cho đường tải progressive qua offscreen.
//
// VÌ SAO ĐI QUA OFFSCREEN (đã ĐO 2026-07-18): `chrome.downloads.download({url})` phát request KHÔNG
// nhận rule DNR modifyHeaders — server chống hotlink nhận `Referer: NONE` -> 403. `fetch()` của
// extension trong offscreen là `xmlhttprequest` tab-less -> KHỚP rule spoof (§2.10/W2.4) -> qua 403.
//
// ⚠️ TRUNG THỰC VỀ RAM: chunk theo Range **KHÔNG bó được đỉnh RAM** — Blob cuối vẫn ôm TRỌN file
// trong RAM offscreen (đỉnh ~2x lúc dựng Blob), y hệt đọc stream. Lợi ích thật của chunk chỉ là:
// (1) báo tiến trình theo đoạn, (2) BẮT được server không tôn trọng Range (guard 206), (3) tránh một
// cú `arrayBuffer()` khổng lồ duy nhất. Bó RAM thật (stream thẳng ra đĩa) phải chờ Đợt 3 (OPFS).
// Tới lúc đó, chặn cứng theo MAX_PROGRESSIVE_BYTES để file quá lớn BÁO LỖI RÕ thay vì làm offscreen
// OOM-crash câm (crash xé cả document -> job kẹt 'in_progress' mãi + rule spoof rò rỉ nguyên phiên).

/** Kích thước một đoạn Range mặc định (8 MiB) — đủ lớn để ít request, đủ nhỏ để tiến trình mượt. */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * File đủ lớn thì mới bõ công chunk theo Range (nhỏ thì một GET stream gọn hơn). Dưới ngưỡng này tải
 * một phát. KHÔNG liên quan tới RAM (xem chú thích đầu file) — chỉ là ngưỡng "đáng chia nhỏ".
 */
export const CHUNK_THRESHOLD_BYTES = 16 * 1024 * 1024;

/**
 * Trần cứng cho tải progressive qua offscreen: vượt là BÁO LỖI RÕ (không để offscreen OOM câm).
 * 2 GiB — khớp mức "video 2GB" mà Đợt 3 (OPFS) sẽ mở khoá; tới đó bỏ trần này.
 */
export const MAX_PROGRESSIVE_BYTES = 2 * 1024 * 1024 * 1024;

/** Thông báo lỗi khi file vượt trần — tách ra để dùng chung (pre-check + mid-stream). */
export function tooLargeMessage(totalBytes: number): string {
  const gb = (n: number) => (n / (1024 * 1024 * 1024)).toFixed(1);
  return `File quá lớn để tải trong bộ nhớ (~${gb(totalBytes)} GB, giới hạn ${gb(MAX_PROGRESSIVE_BYTES)} GB). Tính năng tải file rất lớn sẽ có ở bản sau.`;
}

export interface ByteChunk {
  /** byte đầu (bao gồm). */
  start: number;
  /** byte cuối (BAO GỒM) — hợp với header `Range: bytes=start-end`. */
  end: number;
}

/**
 * Chia `[0, total-1]` thành các đoạn `chunkSize` byte, ĐÓNG hai đầu (khớp cú pháp HTTP Range).
 * total <= 0 -> rỗng (file rỗng/không hợp lệ). chunkSize <= 0 -> một đoạn duy nhất (chống chia 0).
 */
export function planRangeChunks(total: number, chunkSize: number): ByteChunk[] {
  if (!Number.isFinite(total) || total <= 0) return [];
  const size = chunkSize > 0 ? Math.floor(chunkSize) : total;
  const chunks: ByteChunk[] = [];
  for (let start = 0; start < total; start += size) {
    chunks.push({ start, end: Math.min(start + size - 1, total - 1) });
  }
  return chunks;
}

/**
 * Đọc TỔNG byte từ header `Content-Range` (vd `bytes 0-0/12345` -> 12345). Trả null khi tổng không
 * biết (`bytes 0-0/*`) hoặc header thiếu/không hợp lệ.
 */
export function parseContentRangeTotal(
  header: string | null | undefined,
): number | null {
  if (!header) return null;
  const m = /\/(\d+)\s*$/.exec(header.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
