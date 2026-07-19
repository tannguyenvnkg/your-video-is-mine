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
    /**
     * Neo rule vào ĐÚNG một origin (vd `|https://example.com/`).
     *
     * 🔴 BẮT BUỘC cho rule mang header nhạy cảm: `requestDomains:['example.com']` của DNR khớp
     * **cả subdomain** (`api.`, `accounts.`, `cdn.`) -> token `Authorization` của media trên apex
     * sẽ rò sang mọi subdomain extension fetch tới. `|` neo vào đầu URL nên
     * `https://api.example.com/` KHÔNG khớp `|https://example.com/`.
     */
    urlFilter?: string;
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
  return buildHeaderSpoofRule(id, host, { referer, origin });
}

/**
 * W2.1 — rule đặt CHÍNH XÁC tập header được giao, không thêm không bớt.
 *
 * Khác `buildRefererSpoofRule` (bản BỊA: luôn kèm đúng 2 header ta nghĩ ra) ở chỗ caller quyết
 * định hoàn toàn danh sách, nên **quy tắc vàng §2.11** thi hành được: trang không gửi header nào
 * thì không có mục nào cho header đó. Việc set `Origin` vô điều kiện lên GET từng có thể TỰ GÂY
 * 403 trên CDN coi Origin lạ là vi phạm CORS.
 *
 * 🔬 ĐO THẬT (Edge, fetch từ SW, tabId -1): DNR đặt được MỌI header đã thử — cookie, referer,
 * origin, authorization, user-agent, accept-language và header lạ (`x-playback-session-id`).
 * Nhờ vậy phát lại KHÔNG cần luồn header qua 5 tầng vào offscreen, và tránh được bẫy đè mất
 * `Range` của byterange trong `utils/retry.ts`.
 */
export function buildHeaderSpoofRule(
  id: number,
  host: string,
  headers: Readonly<Record<string, string>>,
  /** Neo theo origin — dùng khi rule mang header nhạy cảm (xem `condition.urlFilter`). */
  anchorOrigin?: string,
): DnrRule {
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: Object.entries(headers).map(([header, value]) => ({
        header,
        operation: 'set' as const,
        value,
      })),
    },
    condition: {
      requestDomains: [host],
      resourceTypes: SPOOFED_RESOURCE_TYPES,
      tabIds: [-1],
      ...(anchorOrigin ? { urlFilter: `|${anchorOrigin}/` } : {}),
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
