// W7.1 — THI HÀNH RANH GIỚI CỨNG §7: phát hiện DRM/EME rồi DỪNG và báo rõ.
//
// VÌ SAO GÓI NÀY TỒN TẠI: `CLAUDE.md` khai đây là ranh giới cứng "KHÔNG được vượt", nhưng grep
// `requestMediaKeySystemAccess|MediaKeys|'encrypted'|keySystem` trong `entrypoints/ utils/` ra ĐÚNG
// 0 HIT. Nghĩa là ranh giới được TUYÊN BỐ mà chưa hề được THI HÀNH: gặp Netflix/Disney+ extension
// vẫn hì hục tải rồi mới hỏng một cách khó hiểu. Gói này biến lời tuyên bố thành sự thật.
//
// 🔴 ĐÂY LÀ MÃ TỪ CHỐI, KHÔNG PHẢI MÃ GIẢI MÃ. Nó chỉ NHẬN DIỆN nội dung được bảo vệ để nói
// "không hỗ trợ". Tuyệt đối KHÔNG được mở rộng thành đường moi khoá/giả mạo thiết bị — đó là vượt
// biện pháp bảo vệ kỹ thuật, và đó chính là thứ §7 cấm.
//
// Logic thuần (không đụng DOM/browser API) để unit test được và để dùng được ở CẢ service worker —
// nhớ: SW KHÔNG có `DOMParser`, nên MPD phải soi bằng regex chứ không parse XML.

/**
 * Tiền tố key system EME -> tên cho người đọc.
 *
 * Khớp theo TIỀN TỐ vì site thật dùng biến thể có hậu tố: `com.apple.fps.1_0`,
 * `com.microsoft.playready.recommendation`, `com.widevine.alpha.experiment`.
 */
const KEY_SYSTEM_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['com.widevine.alpha', 'Widevine'],
  ['com.microsoft.playready', 'PlayReady'],
  ['com.apple.fps', 'FairPlay'],
  // Clear Key: về kỹ thuật giải mã được, NHƯNG đi qua EME. Ta không đụng EME, chấm hết — dựng
  // đường riêng cho nó là mở đúng cánh cửa §7 cấm.
  ['org.w3.clearkey', 'Clear Key'],
];

/** Tên hệ thống DRM cho người đọc; `null` nếu không nhận ra (vẫn phải CHẶN — xem `isDrmKeySystem`). */
export function drmNameFromKeySystem(keySystem: string): string | null {
  const s = keySystem.trim().toLowerCase();
  for (const [prefix, name] of KEY_SYSTEM_PREFIXES) {
    if (s === prefix || s.startsWith(`${prefix}.`)) return name;
  }
  return null;
}

/**
 * Chuỗi này có phải một yêu cầu EME không?
 *
 * 🔴 MẶC ĐỊNH AN TOÀN: hệ thống LẠ vẫn trả `true`. Trang gọi `requestMediaKeySystemAccess` tức là
 * nó đang xin DRM — ta không cần biết hãng nào mới được phép từ chối. Danh sách trắng ở đây sẽ là
 * một lỗ hổng: chỉ cần một key system mới ra đời là ranh giới thủng.
 */
export function isDrmKeySystem(keySystem: string): boolean {
  return keySystem.trim().length > 0;
}

/** Thông báo từ chối — phải nói RÕ vì sao, đây là thứ user đọc thay cho một lần tải hỏng. */
export function DRM_UNSUPPORTED_ERROR(systemName?: string): string {
  const which = systemName ? ` (${systemName})` : '';
  return `Nội dung này được bảo vệ bằng DRM${which} nên không hỗ trợ tải. Đây là giới hạn có chủ đích của extension, không phải lỗi.`;
}

// --- DASH: DRM khai báo ngay trong manifest qua <ContentProtection> -------------------------------

/** UUID hệ thống DRM chuẩn trong DASH (`schemeIdUri="urn:uuid:<UUID>"`). */
const DASH_SYSTEM_UUIDS: Readonly<Record<string, string>> = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'PlayReady',
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'FairPlay',
  'e2719d58-a985-b3c9-781a-b030af78d30e': 'Clear Key',
};

/**
 * Thẻ `<ContentProtection ...>` (có thể mang tiền tố namespace như `cenc:`), lấy cụm thuộc tính.
 *
 * Vì sao KHỚP CẢ THẺ chứ không chỉ tìm chữ "ContentProtection": chuỗi đó xuất hiện được trong URL
 * hay comment, và chặn OAN một video thường còn tệ hơn bỏ sót — user mất tính năng mà không hiểu
 * vì sao. Phải thấy đúng một PHẦN TỬ XML mới tính.
 */
const CONTENT_PROTECTION_RE = /<[A-Za-z0-9_.-]*:?ContentProtection\b([^>]*)>/g;
const SCHEME_ID_RE = /schemeIdUri\s*=\s*["']([^"']+)["']/i;

/**
 * Các hệ thống DRM khai báo trong một MPD. Rỗng = manifest sạch.
 *
 * 🔴 MẶC ĐỊNH AN TOÀN như `isDrmKeySystem`: có `<ContentProtection>` mà UUID lạ thì vẫn trả về một
 * mục ("DRM không rõ") — sự hiện diện của phần tử đó ĐÃ là lời khai "nội dung này được mã hoá".
 */
export function drmSystemsInMpd(mpdText: string): string[] {
  const found = new Set<string>();
  for (const m of mpdText.matchAll(CONTENT_PROTECTION_RE)) {
    const attrs = m[1] ?? '';
    const scheme = SCHEME_ID_RE.exec(attrs)?.[1]?.trim().toLowerCase();
    if (!scheme) {
      found.add('DRM không rõ');
      continue;
    }
    const uuid = scheme.startsWith('urn:uuid:')
      ? scheme.slice('urn:uuid:'.length)
      : null;
    if (uuid && DASH_SYSTEM_UUIDS[uuid]) {
      found.add(DASH_SYSTEM_UUIDS[uuid]);
      continue;
    }
    // `urn:mpeg:dash:mp4protection:2011` = khai báo CHUNG rằng luồng đã mã hoá (cenc/cbcs) mà chưa
    // nói hãng nào. Vẫn là nội dung được bảo vệ -> vẫn chặn.
    found.add('DRM không rõ');
  }
  // Biết đích danh hãng thì bỏ mục chung đi cho thông báo gọn.
  if (found.size > 1) found.delete('DRM không rõ');
  return [...found];
}

// --- HLS: DRM khai báo ngay trong playlist qua #EXT-X-KEY / #EXT-X-SESSION-KEY --------------------
//
// 🔴 LỖ HỔNG THẬT ĐÃ ĐO (2026-07-19) — đọc trước khi "gọn hoá" phần này:
// Ranh giới §7 trước đây suy DRM từ `segment.key.method` do m3u8-parser trả về. Đo trên
// m3u8-parser@7.2.0 THẬT thì với FairPlay/PlayReady/Widevine, thư viện đẩy khoá sang
// `manifest.contentProtection` và **KHÔNG gán `segment.key`** -> `firstKeyMethod()` trả undefined
// -> `encryption='none'` -> `isProtected=FALSE`. Tức ba hệ DRM phổ biến NHẤT đi lọt ranh giới,
// extension tải trọn nội dung được bảo vệ rồi giao ra file nhiễu KÈM DẤU TÍCH XANH.
// Chỉ `METHOD=SAMPLE-AES` TRẦN (không KEYFORMAT) mới bị bắt — mà ngoài đời hầu như không ai khai vậy.
//
// => Soi THẲNG văn bản playlist, đừng tin cấu trúc đã qua tay thư viện.

/** KEYFORMAT của HLS -> tên hãng. Khớp theo tiền tố vì có biến thể hậu tố phiên bản. */
const HLS_KEYFORMAT_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['com.apple.streamingkeydelivery', 'FairPlay'],
  ['com.microsoft.playready', 'PlayReady'],
  ['org.w3.clearkey', 'Clear Key'],
];

/**
 * Chỉ khớp DÒNG bắt đầu bằng đúng tag (cho phép thụt lề). Nếu tìm chữ "KEYFORMAT" ở bất cứ đâu thì
 * một URL segment có chứa chuỗi đó cũng bị tính là DRM -> CHẶN OAN, mà chặn oan còn tệ hơn bỏ sót.
 */
const HLS_KEY_LINE_RE = /^[ \t]*#EXT-X-(?:SESSION-)?KEY:(.*)$/gm;
const HLS_METHOD_RE = /(?:^|,)\s*METHOD\s*=\s*([A-Za-z0-9-]+)/i;
const HLS_KEYFORMAT_RE = /(?:^|,)\s*KEYFORMAT\s*=\s*"([^"]*)"/i;

/**
 * Playlist HLS này có khai DRM không? Trả TÊN HÃNG để nói cho user, hoặc `null` nếu sạch.
 *
 * Ba luật, theo đúng thứ tự:
 *   1. `METHOD=NONE` -> bỏ qua dòng đó (đoạn trong veo giữa một stream mã hoá — có thật).
 *   2. `KEYFORMAT` khác `identity` -> DRM. RFC 8216 §4.3.2.4 nói `identity` là MẶC ĐỊNH và là
 *      dạng AES-128 thường; mọi giá trị khác nghĩa là khoá nằm sau một hệ thống license.
 *   3. `METHOD` thuộc họ `SAMPLE-AES*` -> DRM kể cả khi KEYFORMAT là identity.
 *
 * 🔴 MẶC ĐỊNH AN TOÀN: KEYFORMAT lạ vẫn CHẶN (trả 'DRM không rõ'). Danh sách trắng ở đây sẽ thủng
 * ngay khi có hệ thống mới ra đời.
 * 🔴 NỬA DỄ SAI: `METHOD=AES-128` (kèm hoặc không kèm `KEYFORMAT="identity"`) PHẢI trả `null` —
 * đó chính là thứ §7 cho phép tải, vì khoá được máy chủ phát công khai cho bất kỳ ai xin.
 */
export function drmSystemFromHlsPlaylist(text: string): string | null {
  let generic: string | null = null;
  for (const m of text.matchAll(HLS_KEY_LINE_RE)) {
    const attrs = m[1] ?? '';
    const method = HLS_METHOD_RE.exec(attrs)?.[1]?.trim().toUpperCase();
    if (!method || method === 'NONE') continue;

    const keyFormat = HLS_KEYFORMAT_RE.exec(attrs)?.[1]?.trim().toLowerCase();
    const isDrmFormat =
      keyFormat !== undefined && keyFormat !== '' && keyFormat !== 'identity';
    const isSampleAes = method.startsWith('SAMPLE-AES');
    if (!isDrmFormat && !isSampleAes) continue;

    if (keyFormat) {
      const uuid = keyFormat.startsWith('urn:uuid:')
        ? keyFormat.slice('urn:uuid:'.length)
        : null;
      if (uuid && DASH_SYSTEM_UUIDS[uuid]) return DASH_SYSTEM_UUIDS[uuid];
      for (const [prefix, name] of HLS_KEYFORMAT_NAMES) {
        if (keyFormat === prefix || keyFormat.startsWith(`${prefix}.`))
          return name;
      }
    }
    // Có DRM nhưng chưa biết hãng: nhớ lại rồi ĐI TIẾP, biết đâu dòng sau nói đích danh.
    generic = 'DRM không rõ';
  }
  return generic;
}
