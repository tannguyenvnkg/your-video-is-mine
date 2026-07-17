// Xây dựng session rule cho chrome.declarativeNetRequest để SPOOF Referer/Origin,
// vượt hotlink-protection/403 ở mức KHÔNG-DRM. MV3 webRequest chỉ QUAN SÁT (không sửa được
// header) -> phải dùng DNR (declarativeNetRequestWithHostAccess) để sửa request header.
// Logic thuần (không phụ thuộc chrome API) -> unit test được.

export interface DnrModifyHeader {
  header: string;
  operation: 'set' | 'remove';
  value?: string;
}

export interface DnrRule {
  id: number;
  priority: number;
  action: {
    type: 'modifyHeaders';
    requestHeaders: DnrModifyHeader[];
  };
  condition: {
    requestDomains: string[];
    resourceTypes: string[];
    /** -1 = request KHÔNG gắn với tab nào (do SW/offscreen của extension phát). */
    tabIds: number[];
  };
}

/**
 * Dải id dành riêng cho rule spoof. Mọi rule của cơ chế này đều >= MIN, nhờ vậy đối soát
 * (staleSpoofRuleIds) biết chắc id nào là của mình mà không đụng rule của cơ chế khác.
 * SPAN đủ lớn để bộ đếm hầu như không bao giờ quay vòng trong một phiên trình duyệt.
 */
export const SPOOF_RULE_ID_MIN = 2000;
export const SPOOF_RULE_ID_SPAN = 1_000_000;

/** hostname của URL, hoặc null nếu URL không hợp lệ. */
export function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** origin (scheme://host[:port]) của URL, hoặc null. */
export function originFromUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Áp cho các loại request mà CHÍNH EXTENSION phát ra khi tải media.
// `fetch()` (từ SW/offscreen) map sang 'xmlhttprequest'; 'other' phủ các đường còn lại (vd
// chrome.downloads.download). ĐÃ BỎ 'media'/'sub_frame'/'object' — đó là loại request của PLAYER
// TRANG, spoof chúng là ghi đè Referer/Origin lên chính traffic của trang (§2.10 — W2.4).
const SPOOFED_RESOURCE_TYPES = ['xmlhttprequest', 'other'];

/**
 * Rule set Referer + Origin cho request tới `host`.
 *
 * W2.4: `id` do CALLER cấp (một id riêng cho mỗi cặp download×host) chứ không suy từ host nữa.
 * Trước đây id = hash(host) -> hai download cùng CDN dùng chung một rule, cái nào xong trước giật
 * rule khỏi tay cái đang chạy -> cái kia 403 giữa chừng (§2.10). Id riêng thì không đụng nhau.
 * `tabIds:[-1]` giới hạn rule vào ĐÚNG request do extension phát -> không đụng duyệt web của user.
 */
export function buildRefererSpoofRule(
  id: number,
  host: string,
  referer: string,
  origin: string,
): DnrRule {
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'referer', operation: 'set', value: referer },
        { header: 'origin', operation: 'set', value: origin },
      ],
    },
    condition: {
      requestDomains: [host],
      resourceTypes: SPOOFED_RESOURCE_TYPES,
      tabIds: [-1],
    },
  };
}

/**
 * Đối soát rule rò rỉ (W2.4 sweep): trong `sessionRuleIds` hiện có, những id nào thuộc dải spoof
 * (>= MIN) mà KHÔNG còn nằm trong tập `aliveRuleIds` (id của job/download còn sống) thì là RÁC -> xoá.
 *
 * Vì sao BẮT BUỘC có sweep: id theo bộ đếm mất tính "re-add cùng host thay thế rule cũ" mà hash-host
 * từng cho, nên một rule rò rỉ (job chết trước khi dọn) sẽ sống mãi tới khi restart trình duyệt.
 * Chốt chặn id >= MIN: TUYỆT ĐỐI không đụng rule id nhỏ hơn (của cơ chế khác), dù không thấy trong
 * tập sống.
 */
export function staleSpoofRuleIds(
  sessionRuleIds: readonly number[],
  aliveRuleIds: Iterable<number>,
): number[] {
  const alive = new Set(aliveRuleIds);
  return sessionRuleIds.filter(
    (id) => id >= SPOOF_RULE_ID_MIN && !alive.has(id),
  );
}
