// W7.1 — ENFORCE THE HARD BOUNDARY §7: detect DRM/EME then STOP and report it clearly.
//
// WHY THIS MODULE EXISTS: `CLAUDE.md` declares this a hard boundary "MUST NOT be crossed", but
// grepping `requestMediaKeySystemAccess|MediaKeys|'encrypted'|keySystem` in `entrypoints/ utils/`
// gave EXACTLY 0 HITS. Meaning the boundary was DECLARED but never ENFORCED: hitting a
// Netflix/Disney+ extension would still plow ahead and download, then fail in a confusing way.
// This module turns the declaration into reality.
//
// 🔴 THIS IS REFUSAL CODE, NOT DECRYPTION CODE. It only DETECTS protected content in order to say
// "unsupported". It must absolutely NEVER be extended into a key-extraction or device-spoofing path
// — that would be circumventing a technical protection measure, which is exactly what §7 forbids.
//
// Pure logic (no DOM/browser API access) so it's unit-testable and usable in BOTH the service
// worker — remember: the SW has NO `DOMParser`, so the MPD must be inspected via regex, not XML parsing.

/**
 * EME key system prefix -> human-readable name.
 *
 * Matched by PREFIX because real sites use variants with a suffix: `com.apple.fps.1_0`,
 * `com.microsoft.playready.recommendation`, `com.widevine.alpha.experiment`.
 */
const KEY_SYSTEM_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['com.widevine.alpha', 'Widevine'],
  ['com.microsoft.playready', 'PlayReady'],
  ['com.apple.fps', 'FairPlay'],
  // Clear Key: technically decryptable, BUT goes through EME. We do not touch EME, period —
  // building a special path for it would open exactly the door §7 forbids.
  ['org.w3.clearkey', 'Clear Key'],
];

/** Human-readable DRM system name; `null` if unrecognized (still must be BLOCKED — see `isDrmKeySystem`). */
export function drmNameFromKeySystem(keySystem: string): string | null {
  const s = keySystem.trim().toLowerCase();
  for (const [prefix, name] of KEY_SYSTEM_PREFIXES) {
    if (s === prefix || s.startsWith(`${prefix}.`)) return name;
  }
  return null;
}

/**
 * Is this string an EME request?
 *
 * 🔴 SAFE BY DEFAULT: an UNKNOWN system still returns `true`. A page calling
 * `requestMediaKeySystemAccess` means it's asking for DRM — we don't need to know which vendor to
 * be allowed to refuse. A whitelist here would be a hole: just one new key system appearing would
 * punch through the boundary.
 */
export function isDrmKeySystem(keySystem: string): boolean {
  return keySystem.trim().length > 0;
}

/** Refusal message — must state clearly WHY, this is what the user reads instead of a failed download. */
export function DRM_UNSUPPORTED_ERROR(systemName?: string): string {
  const which = systemName ? ` (${systemName})` : '';
  return `Nội dung này được bảo vệ bằng DRM${which} nên không hỗ trợ tải. Đây là giới hạn có chủ đích của extension, không phải lỗi.`;
}

// --- DASH: DRM declared right in the manifest via <ContentProtection> -----------------------------

/** Standard DASH DRM system UUID (`schemeIdUri="urn:uuid:<UUID>"`). */
const DASH_SYSTEM_UUIDS: Readonly<Record<string, string>> = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'PlayReady',
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'FairPlay',
  'e2719d58-a985-b3c9-781a-b030af78d30e': 'Clear Key',
};

/**
 * `<ContentProtection ...>` tag (may carry a namespace prefix like `cenc:`), captures the attribute
 * chunk.
 *
 * Why match the WHOLE TAG instead of just searching for the string "ContentProtection": that string
 * can appear in a URL or a comment, and wrongly blocking a normal video is worse than missing one —
 * the user loses a feature without understanding why. Must see an actual XML ELEMENT for it to count.
 */
const CONTENT_PROTECTION_RE = /<[A-Za-z0-9_.-]*:?ContentProtection\b([^>]*)>/g;
const SCHEME_ID_RE = /schemeIdUri\s*=\s*["']([^"']+)["']/i;

/**
 * DRM systems declared in an MPD. Empty = clean manifest.
 *
 * 🔴 SAFE BY DEFAULT like `isDrmKeySystem`: an `<ContentProtection>` with an unknown UUID still
 * returns an entry ("DRM không rõ") — the element's mere presence IS a declaration that "this
 * content is encrypted".
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
    // `urn:mpeg:dash:mp4protection:2011` = a GENERIC declaration that the stream is encrypted
    // (cenc/cbcs) without naming a vendor. Still protected content -> still blocked.
    found.add('DRM không rõ');
  }
  // If a specific vendor is known, drop the generic entry to keep the message tidy.
  if (found.size > 1) found.delete('DRM không rõ');
  return [...found];
}

// --- HLS: DRM declared right in the playlist via #EXT-X-KEY / #EXT-X-SESSION-KEY -------------------
//
// 🔴 REAL VULNERABILITY MEASURED (2026-07-19) — read before "simplifying" this section:
// The §7 boundary used to infer DRM from `segment.key.method` as returned by m3u8-parser. Measured
// against REAL m3u8-parser@7.2.0: for FairPlay/PlayReady/Widevine, the library pushes the key into
// `manifest.contentProtection` and **does NOT set `segment.key`** -> `firstKeyMethod()` returns
// undefined -> `encryption='none'` -> `isProtected=FALSE`. Meaning the three MOST common DRM systems
// slip past the boundary, and the extension downloads the entire protected content and hands out a
// garbled file WITH A GREEN CHECKMARK. Only a BARE `METHOD=SAMPLE-AES` (no KEYFORMAT) was caught —
// and in practice almost nobody declares it that way.
//
// => Inspect the playlist text DIRECTLY, don't trust structure that's already passed through the library.

/** HLS KEYFORMAT -> vendor name. Matched by prefix because version-suffix variants exist. */
const HLS_KEYFORMAT_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['com.apple.streamingkeydelivery', 'FairPlay'],
  ['com.microsoft.playready', 'PlayReady'],
  ['org.w3.clearkey', 'Clear Key'],
];

/**
 * Only match LINES starting with the exact tag (indentation allowed). Searching for "KEYFORMAT"
 * anywhere would let a segment URL containing that string also count as DRM -> WRONGLY BLOCKED, and
 * a wrong block is worse than a miss.
 */
const HLS_KEY_LINE_RE = /^[ \t]*#EXT-X-(?:SESSION-)?KEY:(.*)$/gm;
const HLS_METHOD_RE = /(?:^|,)\s*METHOD\s*=\s*([A-Za-z0-9-]+)/i;
const HLS_KEYFORMAT_RE = /(?:^|,)\s*KEYFORMAT\s*=\s*"([^"]*)"/i;

/**
 * Does this HLS playlist declare DRM? Returns the VENDOR NAME to tell the user, or `null` if clean.
 *
 * Three rules, in order:
 *   1. `METHOD=NONE` -> skip that line (a genuinely clear section within an otherwise encrypted
 *      stream — this really happens).
 *   2. `KEYFORMAT` other than `identity` -> DRM. RFC 8216 §4.3.2.4 says `identity` is the DEFAULT
 *      and means plain AES-128; any other value means the key sits behind a license system.
 *   3. `METHOD` in the `SAMPLE-AES*` family -> DRM even when KEYFORMAT is identity.
 *
 * 🔴 SAFE BY DEFAULT: an unknown KEYFORMAT still gets BLOCKED (returns 'DRM không rõ'). A whitelist
 * here would punch through the moment a new system appears.
 * 🔴 EASY TO GET WRONG: `METHOD=AES-128` (with or without `KEYFORMAT="identity"`) MUST return
 * `null` — that is exactly what §7 permits downloading, because the key is served publicly by the
 * server to anyone who asks.
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
    // DRM present but vendor unknown: remember it and KEEP GOING, a later line might name it explicitly.
    generic = 'DRM không rõ';
  }
  return generic;
}
