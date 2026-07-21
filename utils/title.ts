// W4.3 — Logic THUẦN chọn & làm sạch tiêu đề video (không phụ thuộc chrome API) -> unit test được.
//
// Nguyên tắc chủ đạo: THÀ THIẾU TÊN CÒN HƠN SAI TÊN. Người dùng nhìn thấy `master.mp4` thì biết
// ngay là chưa lấy được tên; nhưng nhìn thấy một cái tên SAI (bị cắt mất số tập, hoặc mang tên của
// video khác) thì họ TIN nó đúng. Vì vậy mọi luật cắt gọt dưới đây đều thắt chặt có điều kiện,
// và hễ thiếu dữ kiện để chắc chắn thì BỎ QUA luật chứ không đoán.

/** Đuôi tên miền — không bao giờ là tên site, phải loại khỏi token so khớp. */
const TLD_STOP = new Set([
  'com',
  'net',
  'org',
  'co',
  'uk',
  'io',
  'tv',
  'vn',
  'info',
  'biz',
  'edu',
  'gov',
  'me',
  'us',
  'de',
  'fr',
  'jp',
  'cn',
  'ru',
  'br',
  'in',
  'au',
  'ca',
  'es',
  'it',
  'nl',
  'se',
  'no',
  'xyz',
  'app',
  'dev',
  'site',
  'online',
  'cc',
]);

/**
 * Nhãn phụ KHÔNG phải tên site. Đây là chỗ review đối kháng bắt được lỗi CẮT OAN:
 * `live.vtv.vn` từng sinh token 'live', nên tiêu đề thật "Chung kết - Live" bị cắt mất chữ "Live".
 * Sai kiểu này không bao giờ lộ ra vì tên file trông vẫn rất hợp lý.
 */
const SUBDOMAIN_STOP = new Set([
  'www',
  'live',
  'video',
  'videos',
  'watch',
  'tv',
  'play',
  'player',
  'embed',
  'stream',
  'm',
  'mobile',
  'web',
  'app',
  'cdn',
  'media',
  'static',
  'en',
  'vi',
]);

// Tiêu đề chung chung của player/khung — mang xuống tên file thì vô nghĩa.
const GENERIC = new Set(['video', 'player', 'index', 'untitled', 'watch']);

// Dấu phân cách mà các site hay dùng để dán tên site vào đuôi <title>.
// Cố ý đòi có KHOẢNG TRẮNG hai bên: 'Phần 1-2' không được coi là có đuôi.
const SEPARATORS = [' - ', ' – ', ' — ', ' | ', ' · ', ' :: '];

/** Đuôi site dài hơn ngần này thì không còn giống tên site -> không cắt. */
const MAX_SUFFIX_LEN = 30;
/** Cắt xong mà phần đầu ngắn hơn ngần này thì gần như chắc chắn đã cắt nhầm -> không cắt. */
const MIN_HEAD_LEN = 4;

/** Bỏ ký tự vô hình (zero-width, BOM, C1), NBSP -> khoảng trắng, gộp khoảng trắng. */
export function normalizeInvisible(raw: string): string {
  return raw
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
    .replace(/[\u0080-\u009F]/g, '')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rút gọn để SO KHỚP (không dùng để hiển thị): thường hoá, bỏ mọi thứ không phải chữ/số. */
function foldForMatch(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Token tên site từ hostname: 'https://www.abc-xyz.co.uk/a' -> ['abcxyz']. */
export function siteTokens(pageUrl?: string): string[] {
  if (!pageUrl) return [];
  let host: string;
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    return [];
  }
  const bare = host.replace(/^www\./i, '');
  const out: string[] = [];
  // Token 1: NGUYÊN hostname ('vtv.vn' -> 'vtvvn'). Nhiều site dán nguyên tên miền vào đuôi title.
  const whole = foldForMatch(bare);
  if (whole) out.push(whole);
  // Token 2..n: từng nhãn, TRỪ đuôi TLD và TRỪ nhãn phụ (xem SUBDOMAIN_STOP).
  for (const label of bare.split('.')) {
    const lower = label.toLowerCase();
    if (TLD_STOP.has(lower) || SUBDOMAIN_STOP.has(lower)) continue;
    const folded = foldForMatch(label);
    if (folded && !out.includes(folded)) out.push(folded);
  }
  return out;
}

/** Đuôi `tail` có phải là tên site không? Token ngắn thì đòi BẰNG NHAU, không cho chứa. */
function tailIsSiteName(tail: string, tokens: string[]): boolean {
  const folded = foldForMatch(tail);
  if (!folded) return false;
  // Chứa-chuỗi chỉ cho phép với token ĐỦ DÀI. Ngưỡng 3 cũ làm token 'abc' khớp bừa vào mọi đuôi
  // có chứa 'abc' — lại một kiểu cắt oan mà không ai thấy.
  return tokens.some(
    (t) => folded === t || (t.length >= 5 && folded.includes(t)),
  );
}

/**
 * Làm sạch tiêu đề BẨN (document.title / tab title / title đã lưu).
 *
 * ⚠️ Thiếu `pageUrl` -> BỎ QUA luật cắt đuôi site hoàn toàn. Không có hostname thì không có cách
 * nào biết đuôi kia là tên site hay là một phần thật của tiêu đề — mà đoán sai ở đây nghĩa là
 * xoá mất chữ trong tên video thật.
 */
export function cleanTitle(raw: string, pageUrl?: string): string {
  let s = normalizeInvisible(raw);

  // Bộ đếm thông báo của YouTube/Facebook/X: '(3) Tên video'. Chặn ở 2 chữ số để '(2019) Phim'
  // — một cái NĂM — không bị coi là bộ đếm.
  const counter = /^\(\d{1,2}\)\s+/.exec(s);
  if (counter && s.length - counter[0].length >= 3) {
    s = s.slice(counter[0].length);
  }

  const tokens = siteTokens(pageUrl);
  if (tokens.length > 0) {
    // Chỉ xét đoạn đuôi CUỐI CÙNG, và chỉ cắt ĐÚNG MỘT đoạn: 'A - B - C' mà cắt lặp sẽ ăn mòn
    // dần tới khi chẳng còn gì.
    let bestIdx = -1;
    let bestSep = '';
    for (const sep of SEPARATORS) {
      const idx = s.lastIndexOf(sep);
      if (idx > bestIdx) {
        bestIdx = idx;
        bestSep = sep;
      }
    }
    if (bestIdx > 0) {
      const head = s.slice(0, bestIdx).trim();
      const tail = s.slice(bestIdx + bestSep.length).trim();
      if (
        tail.length <= MAX_SUFFIX_LEN &&
        head.length >= MIN_HEAD_LEN &&
        tailIsSiteName(tail, tokens)
      ) {
        s = head;
      }
    }
  }

  return s.replace(/\s+/g, ' ').replace(/^[-–—|·:\s]+|[-–—|·:\s]+$/g, '');
}

/** Ứng viên rác: rỗng, <=1 ký tự, trùng tên site, hoặc là tên chung chung của player. */
export function isJunkTitle(clean: string, pageUrl?: string): boolean {
  if (clean.length <= 1) return true;
  const folded = foldForMatch(clean);
  if (!folded) return true;
  if (GENERIC.has(folded)) return true;
  return siteTokens(pageUrl).includes(folded);
}

export interface TitleCandidates {
  /** meta[property="og:title"] — tác giả trang tự đặt, KHÔNG làm sạch. */
  og?: string;
  /** meta[name|property="twitter:title"] — KHÔNG làm sạch. */
  twitter?: string;
  /** document.title — BẨN (bộ đếm, tên site), CÓ làm sạch. */
  doc?: string;
  /** chrome.tabs.Tab.title — BẨN, CÓ làm sạch. */
  tab?: string;
  /** MediaItem.title đã lưu — hạng CHÓT, CÓ làm sạch. */
  stored?: string;
}

/**
 * Chọn tiêu đề theo thứ hạng og > twitter > doc > tab > stored; ứng viên rác thì RƠI XUỐNG hạng
 * dưới chứ không chặn cả chuỗi.
 *
 * 🔴 og/twitter KHÔNG đi qua `cleanTitle`: đó là metadata do tác giả trang chủ động khai, họ có
 * quyền để tên thương hiệu trong đó. Cắt gọt ở đây là toàn rủi ro mà không được gì.
 */
export function pickTitle(
  c: TitleCandidates,
  pageUrl?: string,
): string | undefined {
  const ranked: Array<{ raw: string | undefined; clean: boolean }> = [
    { raw: c.og, clean: false },
    { raw: c.twitter, clean: false },
    { raw: c.doc, clean: true },
    { raw: c.tab, clean: true },
    { raw: c.stored, clean: true },
  ];
  for (const { raw, clean } of ranked) {
    if (raw === undefined) continue;
    const value = clean ? cleanTitle(raw, pageUrl) : normalizeInvisible(raw);
    if (!isJunkTitle(value, pageUrl)) return value;
  }
  return undefined;
}

/**
 * Phần hash có phải một ROUTE không?
 *
 * '#t=90' là tua video -> KHÔNG phải điều hướng, bỏ qua. Nhưng '#/xem/123' và '#!/v/2' là route
 * thật của SPA hash-router: bỏ qua chúng thì hai video khác nhau trông y hệt một trang, và cổng
 * chống đặt nhầm tên coi như không tồn tại trên các site đó.
 */
function routeHash(u: URL): string {
  return /^#!?\//.test(u.hash) ? u.hash : '';
}

/**
 * W4.3 nợ — tham số query RÁC đã biết: tracking + tua thời gian. Trang tự `replaceState` thêm mấy
 * cái này (share link, quảng cáo, tua giữa video) làm URL "đổi" mà TRANG thì vẫn thế.
 *
 * 🔴 CHỈ danh sách CỐ ĐỊNH này, TUYỆT ĐỐI không bỏ tham số lạ: `?v=abc` của YouTube LÀ danh tính
 * video — bỏ nó thì hai video khác nhau trông y hệt một trang, cổng chống-đặt-nhầm-tên quay ra
 * XÁC NHẬN cái sai. Thà giữ cổng chặt (thiếu tên) còn hơn nới cổng ra rồi đặt SAI tên.
 */
const JUNK_PARAMS = new Set([
  't', // tua thời gian (?t=90)
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'ref_url',
  'spm',
]);

/** search sau khi bỏ tham số rác, chuẩn hoá thứ tự -> so sánh ổn định. */
function stableSearch(u: URL): string {
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams) {
    const key = k.toLowerCase();
    if (JUNK_PARAMS.has(key) || key.startsWith('utm_')) continue;
    kept.push([k, v]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return kept.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * Cùng một trang không? So origin + pathname + search (đã bỏ tham số rác) + hash-route. Thiếu một
 * vế -> false.
 */
export function sameDocument(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.origin === ub.origin &&
      ua.pathname === ub.pathname &&
      stableSearch(ua) === stableSearch(ub) &&
      routeHash(ua) === routeHash(ub)
    );
  } catch {
    return false;
  }
}
