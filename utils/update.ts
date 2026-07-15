// Kiểm tra bản mới trên GitHub Releases.
// Extension phát hành qua GitHub Releases (.zip, load unpacked) chứ KHÔNG qua Web Store
// -> không tự cập nhật được. Ở đây chỉ BÁO cho người dùng + mở trang Release để tải tay.
//
// Ràng buộc: GitHub giới hạn 60 request/giờ/IP cho API không xác thực
// -> luôn đi qua cache TTL trong storage.local, không gọi mỗi lần mở popup.

import {
  getUpdateCheck,
  setUpdateCheck,
  UPDATE_CHECK_TTL_MS,
  type UpdateCheck,
} from './storage';

const LATEST_RELEASE_API =
  'https://api.github.com/repos/tannguyenvnkg/your-video-is-mine/releases/latest';

const FETCH_TIMEOUT_MS = 8000;

/**
 * Cache còn hạn không? Tách thuần để unit test.
 * Đồng hồ máy chạy lùi (checkedAt > now) -> coi như hết hạn, kiểm tra lại.
 */
export function isCacheFresh(
  checkedAt: number,
  now: number,
  ttlMs: number = UPDATE_CHECK_TTL_MS,
): boolean {
  const age = now - checkedAt;
  return age >= 0 && age < ttlMs;
}

/**
 * Lọc JSON từ GitHub — dữ liệu mạng, không tin. Chỉ nhận tag + link release hợp lệ.
 * Tách thuần để unit test.
 */
export function parseLatestRelease(
  data: unknown,
): Omit<UpdateCheck, 'checkedAt'> | null {
  if (!data || typeof data !== 'object') return null;
  const o = data as { tag_name?: unknown; html_url?: unknown };
  if (typeof o.tag_name !== 'string' || typeof o.html_url !== 'string') {
    return null;
  }
  if (o.tag_name === '') return null;
  // Link sẽ được mở bằng tabs.create -> chặn javascript:/data: bằng cách khớp tiền tố github.com.
  if (!o.html_url.startsWith('https://github.com/')) return null;
  return { latestTag: o.tag_name, releaseUrl: o.html_url };
}

/**
 * Lấy release mới nhất: dùng cache nếu còn hạn, hết hạn thì gọi API rồi cache lại.
 * Mọi lỗi (mạng, timeout, rate-limit 403, JSON sai) -> trả cache cũ nếu có, không thì null.
 * KHÔNG ném lỗi và KHÔNG hiện lỗi ra UI: đây là tính năng phụ, không được làm phiền.
 */
export async function fetchLatestRelease(
  now: number = Date.now(),
): Promise<UpdateCheck | null> {
  const cached = await getUpdateCheck();
  if (cached && isCacheFresh(cached.checkedAt, now)) return cached;

  try {
    const res = await fetch(LATEST_RELEASE_API, {
      // KHÔNG gửi cookie github.com sang API (khác với fetch media dùng credentials: 'include').
      credentials: 'omit',
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return cached;
    const parsed = parseLatestRelease(await res.json());
    if (!parsed) return cached;
    const fresh: UpdateCheck = { ...parsed, checkedAt: now };
    await setUpdateCheck(fresh);
    return fresh;
  } catch {
    return cached;
  }
}
