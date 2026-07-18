// W2.7 — phát hiện "bộ xử lý video đã chết" (§2.14).
//
// VẤN ĐỀ: offscreen document có thể bị Chrome giết bất cứ lúc nào (Task Manager, OOM, tab crash).
// Nó chết IM LẶNG — không có sự kiện nào báo về background. Job đang chạy nằm lại storage ở phase
// 'fetching' VĨNH VIỄN, popup quay spinner không lời giải thích. Đó là kết cục tệ nhất của một app
// tải: user không biết nên chờ tiếp hay bấm lại.
//
// CÁCH CHỮA: offscreen đập nhịp tim đều đặn; background đóng dấu `lastSeenAt` mỗi lần nhận tin, và
// một tick định kỳ đánh dấu LỖI THẬT cho job nào im quá lâu.
//
// 🔴 ĐỒNG HỒ THEO IM LẶNG, KHÔNG THEO TỔNG THỜI GIAN — y hệt bài học W2.5/W2.6. Một job HLS hợp lệ
// chạy 30 phút là bình thường; cái BẤT THƯỜNG là 60 giây không một tiếng động nào.
//
// Logic thuần (không đụng browser API) để unit test được — background.ts là entrypoint, vitest
// không chạm tới.

import type { DownloadEntry, HlsJob, HlsPhase } from './storage';

/** Nhịp tim offscreen gửi mỗi ngần này (đủ dày để 60s ngưỡng không báo động giả). */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Im lâu hơn ngần này = bộ xử lý đã chết.
 *
 * Vì sao 60s mà không ngắn hơn: nhịp tim đi qua `runtime.sendMessage`, và service worker có thể
 * đang ngủ/khởi động lại — vài nhịp rớt là chuyện thường. 60s = 12 nhịp liên tiếp mất trắng, lúc đó
 * kết luận "chết" mới an toàn. Ngắn hơn = giết oan job khoẻ.
 */
export const HEARTBEAT_TIMEOUT_MS = 60_000;

/** Thông báo khi bộ xử lý chết — phải nói RÕ chuyện gì xảy ra và làm gì tiếp, không phải mã lỗi trần. */
export const DEAD_OFFSCREEN_ERROR =
  'Bộ xử lý video đã dừng đột ngột (thường do hết bộ nhớ hoặc trình duyệt thu hồi). Hãy thử tải lại — nếu video rất lớn, chọn chất lượng thấp hơn.';

/** Phase còn CHẠY = phải có nhịp tim. Phase kết thúc thì im là đúng, đừng theo dõi nữa. */
const ACTIVE_PHASES: readonly HlsPhase[] = [
  'queued',
  'loading',
  'fetching',
  'muxing',
  'saving',
];

export function isActiveHlsPhase(phase: HlsPhase): boolean {
  return ACTIVE_PHASES.includes(phase);
}

/**
 * Job nào đã im quá lâu -> id của chúng (caller đánh dấu lỗi).
 *
 * Hai lớp bảo vệ chống GIẾT OAN:
 * - `>` chứ không `>=`: đúng ngưỡng chưa tính là chết (giật nhẹ đồng hồ không thành án tử).
 * - thiếu `lastSeenAt` -> BỎ QUA. Job tạo trước bản nâng cấp này không có dấu thời gian; không có
 *   bằng chứng sống thì cũng không có bằng chứng chết, mà giết oan tệ hơn là bỏ sót.
 */
export function findDeadHlsJobs(
  jobs: Record<string, HlsJob>,
  now: number,
  timeoutMs: number,
): string[] {
  const dead: string[] = [];
  for (const [id, job] of Object.entries(jobs)) {
    if (!job || !isActiveHlsPhase(job.phase)) continue;
    if (typeof job.lastSeenAt !== 'number') continue;
    if (now - job.lastSeenAt > timeoutMs) dead.push(id);
  }
  return dead;
}

/**
 * W2.7 — lượt tải PROGRESSIVE nào đã im quá lâu -> khoá của chúng.
 *
 * Vì sao đường này cũng cần lưới: W2.5 định tuyến .mp4 qua offscreen (để mang được Referer spoof),
 * nên từ đó progressive PHỤ THUỘC offscreen y như HLS. Offscreen chết ⇒ `finally` của nó không chạy
 * ⇒ không có `download/progress` 'interrupted' nào được gửi ⇒ entry kẹt `in_progress` vĩnh viễn.
 *
 * 🔴 CHỈ soi phase FETCH (`chromeDownloadId === undefined`). Có id rồi tức là offscreen đã giao blob
 * xong và `chrome.downloads` đang cầm lái — lượt đó KHÔNG còn phụ thuộc offscreen nữa, và nó im
 * lặng là chuyện bình thường (downloads.onChanged mới là nguồn tin). Soi nhầm = giết oan lượt lưu.
 */
export function findDeadDownloads(
  entries: Record<string, DownloadEntry>,
  now: number,
  timeoutMs: number,
): string[] {
  const dead: string[] = [];
  for (const [key, e] of Object.entries(entries)) {
    if (!e || e.state !== 'in_progress') continue;
    if (e.chromeDownloadId !== undefined) continue;
    if (typeof e.lastSeenAt !== 'number') continue;
    if (now - e.lastSeenAt > timeoutMs) dead.push(key);
  }
  return dead;
}

/**
 * Gộp mọi lời gọi CÙNG LÚC vào một lượt chạy duy nhất.
 *
 * Vì sao cần (§2.14): hai `handleHlsDownload` gọi `ensureOffscreen()` sát nhau -> cả hai vào
 * `createDocument`, cái thứ hai ném "single offscreen document" rồi bị NUỐT, caller tưởng offscreen
 * đã sẵn sàng và bắn `hls/run` vào một document CHƯA đăng ký listener xong -> job kẹt 'queued' mãi.
 * Đúng lớp lỗi đã làm HLS chết câm suốt nhiều commit đầu dự án.
 *
 * 🔴 KHÔNG cache kết quả sau khi xong: offscreen có thể chết bất cứ lúc nào, nên lần gọi sau PHẢI
 * dò lại từ đầu. Chỉ gộp trong lúc còn đang bay.
 * 🔴 Ném thì cũng xoá chuyến bay: giữ lại promise hỏng = mọi lần thử sau đều hỏng theo vĩnh viễn.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const p = (async () => fn())().finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  };
}
