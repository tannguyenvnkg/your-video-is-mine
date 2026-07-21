// W4.3 — PURE logic to pick & clean up the video title (no chrome API dependency) -> unit-testable.
//
// Guiding principle: BETTER A MISSING NAME THAN A WRONG NAME. If the user sees `master.mp4` they
// know right away the name wasn't captured; but if they see a WRONG name (episode number cut off,
// or carrying another video's name) they will TRUST it as correct. So every trimming rule below is
// tightened with conditions, and whenever there isn't enough certainty, the rule is SKIPPED rather than guessed.

/** TLD suffixes — never the site name, must be excluded from match tokens. */
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
 * Subdomain labels that are NOT the site name. This is where adversarial review caught a WRONGFUL
 * TRIM bug: `live.vtv.vn` used to generate the token 'live', so the real title "Chung kết - Live"
 * had "Live" cut off. This kind of bug never surfaces because the resulting filename still looks plausible.
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

// Generic player/frame titles — meaningless if carried down into the filename.
const GENERIC = new Set(['video', 'player', 'index', 'untitled', 'watch']);

// Separators sites commonly use to glue the site name onto the end of <title>.
// Deliberately requires WHITESPACE on both sides: 'Phần 1-2' must not be treated as having a suffix.
const SEPARATORS = [' - ', ' – ', ' — ', ' | ', ' · ', ' :: '];

/** A site suffix longer than this no longer looks like a site name -> don't trim. */
const MAX_SUFFIX_LEN = 30;
/** If the head is shorter than this after trimming, it's almost certainly a wrong trim -> don't trim. */
const MIN_HEAD_LEN = 4;

/** Strip invisible characters (zero-width, BOM, C1), NBSP -> space, collapse whitespace. */
export function normalizeInvisible(raw: string): string {
  return raw
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
    .replace(/[\u0080-\u009F]/g, '')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fold for MATCHING (not for display): lowercase, strip everything that isn't a letter/digit. */
function foldForMatch(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Site-name tokens from the hostname: 'https://www.abc-xyz.co.uk/a' -> ['abcxyz']. */
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
  // Token 1: the WHOLE hostname ('vtv.vn' -> 'vtvvn'). Many sites glue the whole domain onto the title suffix.
  const whole = foldForMatch(bare);
  if (whole) out.push(whole);
  // Token 2..n: each label, EXCLUDING the TLD suffix and EXCLUDING subdomain labels (see SUBDOMAIN_STOP).
  for (const label of bare.split('.')) {
    const lower = label.toLowerCase();
    if (TLD_STOP.has(lower) || SUBDOMAIN_STOP.has(lower)) continue;
    const folded = foldForMatch(label);
    if (folded && !out.includes(folded)) out.push(folded);
  }
  return out;
}

/** Is the `tail` suffix a site name? Short tokens require an EXACT match, substring not allowed. */
function tailIsSiteName(tail: string, tokens: string[]): boolean {
  const folded = foldForMatch(tail);
  if (!folded) return false;
  // Substring matching is only allowed for SUFFICIENTLY LONG tokens. The old threshold of 3 made
  // the token 'abc' match indiscriminately against any suffix containing 'abc' — yet another
  // wrongful-trim bug nobody would notice.
  return tokens.some(
    (t) => folded === t || (t.length >= 5 && folded.includes(t)),
  );
}

/**
 * Clean up a DIRTY title (document.title / tab title / a stored title).
 *
 * ⚠️ Missing `pageUrl` -> SKIP the site-suffix-trimming rule entirely. Without a hostname there's
 * no way to know whether that suffix is a site name or a genuine part of the title — and guessing
 * wrong here means deleting real text from the actual video title.
 */
export function cleanTitle(raw: string, pageUrl?: string): string {
  let s = normalizeInvisible(raw);

  // Notification counter from YouTube/Facebook/X: '(3) Video title'. Capped at 2 digits so
  // '(2019) Movie' — a YEAR — isn't mistaken for a counter.
  const counter = /^\(\d{1,2}\)\s+/.exec(s);
  if (counter && s.length - counter[0].length >= 3) {
    s = s.slice(counter[0].length);
  }

  const tokens = siteTokens(pageUrl);
  if (tokens.length > 0) {
    // Only consider the LAST suffix segment, and trim EXACTLY ONE segment: 'A - B - C' trimmed
    // repeatedly would erode away until nothing is left.
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

/** A junk candidate: empty, <=1 char, matches the site name, or a generic player title. */
export function isJunkTitle(clean: string, pageUrl?: string): boolean {
  if (clean.length <= 1) return true;
  const folded = foldForMatch(clean);
  if (!folded) return true;
  if (GENERIC.has(folded)) return true;
  return siteTokens(pageUrl).includes(folded);
}

export interface TitleCandidates {
  /** meta[property="og:title"] — set by the page author, NOT cleaned. */
  og?: string;
  /** meta[name|property="twitter:title"] — NOT cleaned. */
  twitter?: string;
  /** document.title — DIRTY (counter, site name), IS cleaned. */
  doc?: string;
  /** chrome.tabs.Tab.title — DIRTY, IS cleaned. */
  tab?: string;
  /** Stored MediaItem.title — LOWEST rank, IS cleaned. */
  stored?: string;
}

/**
 * Picks a title by rank og > twitter > doc > tab > stored; a junk candidate FALLS DOWN to the next
 * rank rather than blocking the whole chain.
 *
 * 🔴 og/twitter do NOT go through `cleanTitle`: that's metadata the page author explicitly
 * declared, and they're entitled to put a brand name in it. Trimming here is all risk, no upside.
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
 * Is the hash fragment a ROUTE?
 *
 * '#t=90' is a video seek -> NOT navigation, ignore it. But '#/xem/123' and '#!/v/2' are real
 * SPA hash-router routes: ignoring them makes two different videos look like the exact same page,
 * effectively disabling the wrong-name guard on those sites.
 */
function routeHash(u: URL): string {
  return /^#!?\//.test(u.hash) ? u.hash : '';
}

/**
 * W4.3 debt — known JUNK query params: tracking + time-seek. Pages add these via `replaceState`
 * (share links, ads, seeking mid-video), making the URL "change" while the PAGE stays the same.
 *
 * 🔴 ONLY this FIXED list, ABSOLUTELY do not strip unknown params: YouTube's `?v=abc` IS the
 * video's identity — stripping it makes two different videos look like the exact same page, and
 * the wrong-name guard would end up CONFIRMING the wrong name. Better to keep the guard strict
 * (missing name) than loosen it and produce a WRONG name.
 */
const JUNK_PARAMS = new Set([
  't', // time seek (?t=90)
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

/** search after stripping junk params, order normalized -> stable comparison. */
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
 * Is it the same page? Compares origin + pathname + search (junk params stripped) + hash-route.
 * Missing either side -> false.
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
