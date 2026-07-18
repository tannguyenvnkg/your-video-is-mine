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
