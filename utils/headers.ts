// W2.1 — bắt & phát lại header THẬT mà player của trang đã gửi, thay vì BỊA Referer/Origin.
//
// VÌ SAO: §2.11. Trước gói này ta set CỨNG đúng 2 header do mình nghĩ ra, và set `Origin` VÔ ĐIỀU
// KIỆN lên GET — điều player thật gần như không bao giờ làm. Một số CDN coi Origin lạ trên GET là
// vi phạm CORS và 403 nó, nghĩa là chính cái rule "chống 403" có thể GÂY RA 403. Đồng thời ta mù
// hoàn toàn với CDN gác bằng thứ khác: token trong header riêng (`X-Playback-Session-Id`,
// `Authorization: Bearer`).
//
// 🔬 ĐO THẬT TRONG EDGE (2026-07-19) — bảng này quyết định toàn bộ thiết kế, đừng đoán lại:
//
//   header                | fetch(url,{headers}) từ SW | DNR modifyHeaders
//   ----------------------|----------------------------|------------------
//   Cookie                | ❌ RƠI, KHÔNG NÉM          | ✅ tới nơi
//   Referer               | ❌ RƠI, KHÔNG NÉM          | ✅ tới nơi
//   User-Agent            | ❌ RƠI, KHÔNG NÉM          | ✅ tới nơi
//   Origin                | ✅ tới nơi                 | ✅ tới nơi
//   Authorization         | ✅ tới nơi                 | ✅ tới nơi
//   X-Playback-Session-Id | ✅ tới nơi                 | ✅ tới nơi
//
// => PHÁT LẠI TOÀN BỘ QUA DNR. Hai lý do:
//   1. `fetch` nuốt Referer/Cookie/User-Agent trong IM LẶNG (không ném) — đúng loại lỗi
//      XANH-VÀ-IM-LẶNG đã ba lần giết dự án này.
//   2. DNR đặt được MỌI header đã đo, nên không cần luồn header qua 5 tầng vào offscreen. Tránh
//      luôn bẫy `utils/retry.ts`: thêm một key `headers` thứ hai cạnh nhánh `Range` sẽ ĐÈ MẤT
//      `Range` -> byterange (fMP4/CMAF, W1.3) hỏng câm.

/** Bản chụp header của một request player thật đã gửi. Tên header LUÔN chữ thường. */
export type CapturedHeaders = Record<string, string>;

/** Header do trình duyệt/tầng vận chuyển tự quản — phát lại là vô nghĩa hoặc phá request của ta. */
const NEVER_REPLAY = new Set([
  // tầng vận chuyển: trình duyệt tự dựng lại cho request của ta.
  'host',
  'connection',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
  'te',
  'trailer',
  'via',
  'expect',
  'date',
  'accept-encoding',
  // 🔴 Vá sau review: `accept` / `accept-language` là header VÔ HẠI mà player nào cũng gửi. Giữ
  // chúng lại thì một bản chụp KHÔNG có referer (trang đặt `Referrer-Policy: no-referrer` — rất
  // phổ biến đúng trên site chống hotlink) vẫn cho `isEmpty=false`, khiến caller tưởng đã bắt được
  // header thật và BỎ đường lùi Referer bịa -> mất luôn tính năng vượt 403 đang chạy được.
  'accept',
  'accept-language',
  // 🔴 Vá sau review: cache validator. Phát lại `If-None-Match`/`If-Modified-Since` của trang lên
  // cú fetch MỚI của ta -> máy chủ trả **304 không body** -> parse ra playlist rỗng. Live HLS
  // refresh liên tục nên ca này không hiếm.
  'if-none-match',
  'if-modified-since',
  'if-match',
  'if-unmodified-since',
  'cache-control',
  'pragma',
  // Range là header của TA: offscreen tự đặt cho byterange (W1.3). Phát lại Range của trang sẽ
  // cắt nhầm segment.
  'range',
  'if-range',
  // 🔴 Cookie: KHÔNG phát lại. Mọi cú fetch media của ta đều đã `credentials:'include'` nên jar
  // của trình duyệt TỰ gửi cookie thật, mới nhất (đã đo). Phát lại bản chụp chỉ tổ (a) đè cookie
  // cũ lên cookie mới, (b) rò cookie site sang host CDN khác khi rule phủ nhiều host.
  'cookie',
  'cookie2',
  // danh tính trình duyệt: ta CHÍNH LÀ trình duyệt đó, phát lại không đổi gì mà chỉ nặng rule.
  'user-agent',
  'dnt',
]);

/** Tiền tố header cũng thuộc nhóm KHÔNG phát lại. */
const NEVER_REPLAY_PREFIX = ['proxy-', 'sec-', 'access-control-'];

/**
 * Header ĐƯỢC phép bắn sang host KHÁC host đã chụp.
 *
 * Vì sao phải thu hẹp: rule DNR khớp theo HOST và ôm MỌI request tab-less tới host đó. Bắn
 * `Authorization` của site A sang CDN B là RÒ THÔNG TIN XÁC THỰC — tệ hơn hẳn cái 403 nó định chữa.
 * Referer/Origin thì ngược lại: chúng là danh tính TRANG, và bắn sang CDN chính là mục đích (§2.4 —
 * key/segment hay nằm host khác và đó lại là chỗ kiểm Referer gắt nhất).
 */
const CROSS_HOST_SAFE = new Set(['referer', 'origin']);

function isReplayable(name: string): boolean {
  if (NEVER_REPLAY.has(name)) return false;
  return !NEVER_REPLAY_PREFIX.some((p) => name.startsWith(p));
}

/** Chuẩn hoá danh sách header của webRequest thành map chữ thường. */
export function capturedFromHeaderList(
  list: readonly { name: string; value?: string }[],
): CapturedHeaders {
  const out: CapturedHeaders = {};
  for (const h of list) {
    // value vắng = webRequest trả binaryValue (header nhị phân) -> không phát lại được.
    if (typeof h.value !== 'string') continue;
    out[h.name.toLowerCase()] = h.value;
  }
  return out;
}

/** Thông tin tối thiểu của một request để quyết định có bắt header hay không. */
export interface CaptureCandidate {
  tabId: number;
  initiator?: string;
  type: string;
}

/**
 * Chỉ bắt header của PLAYER TRANG.
 *
 * 🔬 ĐO THẬT: fetch của CHÍNH extension CŨNG lọt vào `onSendHeaders`, mang
 * `initiator='chrome-extension://<id>'` và thường `tabId=-1`. Không lọc thì ta bắt lại chính
 * header BỊA của mình rồi "phát lại" ở lần sau — vòng tự đầu độc, mà mọi cổng vẫn XANH.
 */
export function shouldCaptureRequest(
  d: CaptureCandidate,
  extensionId: string,
): boolean {
  if (d.tabId < 0) return false;
  if (d.type === 'main_frame') return false; // điều hướng trang, không phải request player.
  if (d.initiator?.startsWith(`chrome-extension://${extensionId}`))
    return false;
  return true;
}

export interface HeaderReplayPlan {
  /** Header sẽ đặt qua DNR cho host này. */
  headers: CapturedHeaders;
  /**
   * Có ít nhất một header NHẠY CẢM (không thuộc `CROSS_HOST_SAFE`, vd `Authorization`, token `x-*`).
   *
   * 🔴 Vì sao caller PHẢI quan tâm: `requestDomains:['example.com']` của DNR khớp **cả subdomain**
   * (`api.`, `accounts.`, `cdn.`). Nên rule mang `Authorization` của media trên apex sẽ bắn token
   * đó sang MỌI subdomain extension fetch tới — vô hiệu hoá đúng lá chắn cross-host ở trên. Rule
   * nào `hasSensitive` thì caller phải NEO theo origin (`urlFilter`), đừng phủ theo host.
   */
  hasSensitive: boolean;
  /** Tên header đã bị bỏ (để giải thích/kiểm chứng, không dùng cho logic mạng). */
  dropped: string[];
  /**
   * KHÔNG có gì phát lại được -> caller PHẢI lùi về đường spoof cũ (Referer bịa từ pageUrl).
   *
   * 🔴 Đây là chốt chống hồi quy quan trọng nhất của W2.1: nếu isEmpty sai thành false, caller
   * tưởng đã có header thật nên bỏ đường lùi -> mất tính năng vượt 403 ĐANG CHẠY ĐƯỢC.
   */
  isEmpty: boolean;
}

/**
 * Chọn tập header sẽ phát lại cho một host.
 *
 * QUY TẮC VÀNG (§2.11): trang **không gửi** header nào thì ta **không sinh** header đó. Hàm này
 * chỉ lọc bớt bản chụp, TUYỆT ĐỐI không thêm gì vào.
 *
 * @param sameHost true nếu đang dựng rule cho ĐÚNG host đã chụp được header.
 */
export function planHeaderReplay(
  captured: CapturedHeaders,
  { sameHost }: { sameHost: boolean },
): HeaderReplayPlan {
  const headers: CapturedHeaders = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(captured)) {
    if (!isReplayable(name)) {
      dropped.push(name);
      continue;
    }
    if (!sameHost && !CROSS_HOST_SAFE.has(name)) {
      dropped.push(name);
      continue;
    }
    headers[name] = value;
  }
  return {
    headers,
    dropped,
    hasSensitive: Object.keys(headers).some((n) => !CROSS_HOST_SAFE.has(n)),
    isEmpty: Object.keys(headers).length === 0,
  };
}

/**
 * Lọc bản chụp NGAY LÚC BẮT: chỉ giữ header có khả năng được phát lại.
 *
 * 🔴 Vá sau review (riêng tư): listener chạy trên `<all_urls>`, nên lưu nguyên bản chụp đồng nghĩa
 * `Cookie` THÔ của mọi site có video (LMS nội bộ, khoá học trả phí, viewer riêng tư…) nằm trong
 * `chrome.storage.session` dù user chưa hề bấm tải gì. Ta đã quyết KHÔNG phát lại Cookie — vậy thì
 * đừng lưu nó ngay từ đầu. Lọc ở đây cũng làm bản ghi nhỏ đi đáng kể.
 */
export function filterCapturable(captured: CapturedHeaders): CapturedHeaders {
  const out: CapturedHeaders = {};
  for (const [name, value] of Object.entries(captured)) {
    if (isReplayable(name)) out[name] = value;
  }
  return out;
}
