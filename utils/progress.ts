// Helper thuần cho tiến trình tải HLS: tính %, tốc độ, ETA và định dạng hiển thị.
// Tách khỏi UI để unit test dễ dàng (vitest).

export interface FetchStatsInput {
  segmentsDone: number;
  segmentsTotal: number;
  bytesDownloaded: number;
  /** epoch ms lúc bắt đầu tải segment. */
  startedAt: number;
  /** epoch ms hiện tại. */
  now: number;
}

export interface FetchStats {
  /** phần trăm 0..100 (làm tròn). */
  pct: number;
  speedBytesPerSec: number;
  /** giây còn lại; null nếu chưa đủ dữ liệu để ước lượng. */
  etaSec: number | null;
}

export function computeFetchStats(input: FetchStatsInput): FetchStats {
  const { segmentsDone, segmentsTotal, bytesDownloaded, startedAt, now } = input;
  const pct =
    segmentsTotal > 0
      ? Math.min(100, Math.round((segmentsDone / segmentsTotal) * 100))
      : 0;
  const elapsedSec = Math.max(0, (now - startedAt) / 1000);
  // Chưa chạy hoặc chưa tải xong segment nào -> không ước lượng được.
  if (elapsedSec <= 0 || segmentsDone <= 0) {
    return { pct, speedBytesPerSec: 0, etaSec: null };
  }
  const speedBytesPerSec = bytesDownloaded / elapsedSec;
  const segPerSec = segmentsDone / elapsedSec;
  const remaining = Math.max(0, segmentsTotal - segmentsDone);
  const etaSec = segPerSec > 0 ? Math.round(remaining / segPerSec) : null;
  return { pct, speedBytesPerSec, etaSec };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '0 B/s';
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(sec: number | null): string {
  if (sec === null) return 'đang ước lượng…';
  if (sec <= 0) return 'sắp xong';
  if (sec < 60) return `~${sec} giây`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `~${m} phút` : `~${m} phút ${s} giây`;
}
