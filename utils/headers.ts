// W2.1 — capture & replay the REAL headers the page's player sent, instead of FABRICATING Referer/Origin.
//
// WHY: §2.11. Before this package we hard-set exactly 2 headers we made up, and set `Origin`
// UNCONDITIONALLY on GET — something a real player almost never does. Some CDNs treat an unfamiliar
// Origin on GET as a CORS violation and 403 it, meaning the very rule meant to "fight 403" can CAUSE
// a 403. At the same time we were completely blind to CDNs gated by something else: a token in a
// dedicated header (`X-Playback-Session-Id`, `Authorization: Bearer`).
//
// 🔬 REAL MEASUREMENT IN EDGE (2026-07-19) — this table drives the entire design, do not re-guess it:
//
//   header                | fetch(url,{headers}) from SW | DNR modifyHeaders
//   ----------------------|-------------------------------|------------------
//   Cookie                | ❌ DROPPED, NO THROW           | ✅ delivered
//   Referer               | ❌ DROPPED, NO THROW           | ✅ delivered
//   User-Agent            | ❌ DROPPED, NO THROW           | ✅ delivered
//   Origin                | ✅ delivered                   | ✅ delivered
//   Authorization         | ✅ delivered                   | ✅ delivered
//   X-Playback-Session-Id | ✅ delivered                   | ✅ delivered
//
// => REPLAY EVERYTHING VIA DNR. Two reasons:
//   1. `fetch` silently swallows Referer/Cookie/User-Agent (no throw) — exactly the kind of
//      GREEN-AND-SILENT bug that has killed this project three times already.
//   2. DNR can set EVERY header we measured, so there's no need to thread headers through 5 layers
//      into offscreen. This also avoids a trap in `utils/retry.ts`: adding a second `headers` key
//      next to the `Range` branch would SILENTLY OVERWRITE `Range` -> byterange (fMP4/CMAF, W1.3)
//      breaks silently.

/** Header snapshot of one request a real player sent. Header names are ALWAYS lowercase. */
export type CapturedHeaders = Record<string, string>;

/** Headers the browser/transport layer manages itself — replaying them is meaningless or breaks our request. */
const NEVER_REPLAY = new Set([
  // transport layer: the browser rebuilds these for our own request.
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
  // 🔴 Post-review patch: `accept` / `accept-language` are HARMLESS headers every player sends.
  // Keeping them means a snapshot WITHOUT a referer (page sets `Referrer-Policy: no-referrer` —
  // quite common exactly on anti-hotlink sites) would still yield `isEmpty=false`, making the
  // caller think it captured real headers and DROP the fabricated-Referer fallback -> losing the
  // 403-bypass feature that was actually working.
  'accept',
  'accept-language',
  // 🔴 Post-review patch: cache validators. Replaying the page's `If-None-Match`/`If-Modified-Since`
  // on our NEW fetch -> the server returns **304 with no body** -> parses into an empty playlist.
  // Live HLS refreshes constantly so this case isn't rare.
  'if-none-match',
  'if-modified-since',
  'if-match',
  'if-unmodified-since',
  'cache-control',
  'pragma',
  // Range is OUR header: offscreen sets it itself for byterange (W1.3). Replaying the page's
  // Range would cut the wrong segment.
  'range',
  'if-range',
  // 🔴 Cookie: do NOT replay. Every one of our media fetches already uses `credentials:'include'`
  // so the browser's cookie jar sends the real, freshest cookies itself (measured). Replaying the
  // snapshot only (a) overwrites a fresh cookie with a stale one, (b) leaks the site's cookie to a
  // different CDN host when a rule covers multiple hosts.
  'cookie',
  'cookie2',
  // browser identity: we ARE that browser, replaying it changes nothing and just bloats the rule.
  'user-agent',
  'dnt',
]);

/** Header prefixes that also fall into the NEVER-replay group. */
const NEVER_REPLAY_PREFIX = ['proxy-', 'sec-', 'access-control-'];

/**
 * Headers ALLOWED to be sent to a host OTHER than the one they were captured on.
 *
 * Why this needs restricting: a DNR rule matches by HOST and covers EVERY tab-less request to that
 * host. Sending site A's `Authorization` to CDN B is a CREDENTIAL LEAK — worse than the 403 it was
 * meant to fix. Referer/Origin are the opposite: they're the PAGE's identity, and sending them to
 * the CDN is the whole point (§2.4 — the key/segment often lives on a different host, and that's
 * exactly where Referer checks are strictest).
 */
const CROSS_HOST_SAFE = new Set(['referer', 'origin']);

function isReplayable(name: string): boolean {
  if (NEVER_REPLAY.has(name)) return false;
  return !NEVER_REPLAY_PREFIX.some((p) => name.startsWith(p));
}

/** Normalize a webRequest header list into a lowercase map. */
export function capturedFromHeaderList(
  list: readonly { name: string; value?: string }[],
): CapturedHeaders {
  const out: CapturedHeaders = {};
  for (const h of list) {
    // missing value = webRequest returned binaryValue (a binary header) -> not replayable.
    if (typeof h.value !== 'string') continue;
    out[h.name.toLowerCase()] = h.value;
  }
  return out;
}

/** Minimal info about a request used to decide whether to capture its headers. */
export interface CaptureCandidate {
  tabId: number;
  initiator?: string;
  type: string;
}

/**
 * Only capture headers from the PAGE'S PLAYER.
 *
 * 🔬 REAL MEASUREMENT: the extension's OWN fetches also land in `onSendHeaders`, carrying
 * `initiator='chrome-extension://<id>'` and usually `tabId=-1`. Without filtering, we'd capture our
 * own FABRICATED headers and "replay" them next time — a self-poisoning loop, while every gate
 * stays GREEN.
 */
export function shouldCaptureRequest(
  d: CaptureCandidate,
  extensionId: string,
): boolean {
  if (d.tabId < 0) return false;
  if (d.type === 'main_frame') return false; // page navigation, not a player request.
  if (d.initiator?.startsWith(`chrome-extension://${extensionId}`))
    return false;
  return true;
}

export interface HeaderReplayPlan {
  /** Headers that will be set via DNR for this host. */
  headers: CapturedHeaders;
  /**
   * At least one SENSITIVE header (not in `CROSS_HOST_SAFE`, e.g. `Authorization`, an `x-*` token).
   *
   * 🔴 Why the caller MUST care: DNR's `requestDomains:['example.com']` matches **all subdomains**
   * too (`api.`, `accounts.`, `cdn.`). So a rule carrying the media's apex `Authorization` would
   * send that token to EVERY subdomain the extension fetches — defeating the cross-host shield
   * above. Any rule with `hasSensitive` must be caller-ANCHORED to the origin (`urlFilter`),
   * never spread across the whole host.
   */
  hasSensitive: boolean;
  /** Header names that were dropped (for explanation/verification, not used in network logic). */
  dropped: string[];
  /**
   * NOTHING is replayable -> caller MUST fall back to the old spoof path (fabricated Referer from pageUrl).
   *
   * 🔴 This is W2.1's most important anti-regression guard: if isEmpty is wrongly false, the caller
   * thinks it has real headers and drops the fallback -> losing the 403-bypass feature that was
   * ACTUALLY WORKING.
   */
  isEmpty: boolean;
}

/**
 * Pick the set of headers to replay for a host.
 *
 * GOLDEN RULE (§2.11): if the page **didn't send** a header, we **don't generate** it. This
 * function only filters the snapshot down — it NEVER adds anything.
 *
 * @param sameHost true if building the rule for the EXACT host the headers were captured on.
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
 * W2.1 debt (a) — downgrade a plan to only the CROSS-HOST-SAFE headers (referer/origin), dropping
 * every sensitive header. Used when this host already has a live sensitive rule from another job:
 * stacking a second sensitive rule would make the earlier job pick up the wrong token (see
 * `hasConflictingSensitiveRule`). This downgrade is safer: the later job losing its token (segment
 * may 403 — a VISIBLE error) beats the earlier job silently picking up the wrong token and
 * downloading the wrong content.
 */
export function stripSensitive(plan: HeaderReplayPlan): HeaderReplayPlan {
  const headers: CapturedHeaders = {};
  for (const [name, value] of Object.entries(plan.headers)) {
    if (CROSS_HOST_SAFE.has(name)) headers[name] = value;
  }
  return {
    headers,
    dropped: plan.dropped,
    hasSensitive: false,
    isEmpty: Object.keys(headers).length === 0,
  };
}

/**
 * Filter the snapshot RIGHT AT CAPTURE TIME: keep only headers that could possibly be replayed.
 *
 * 🔴 Post-review patch (privacy): the listener runs on `<all_urls>`, so storing the raw snapshot
 * would mean the RAW `Cookie` of every site with video (internal LMS, paid courses, private
 * viewers…) sits in `chrome.storage.session` even though the user never clicked download. We've
 * already decided NOT to replay Cookie — so don't store it in the first place. Filtering here also
 * shrinks the stored record considerably.
 */
export function filterCapturable(captured: CapturedHeaders): CapturedHeaders {
  const out: CapturedHeaders = {};
  for (const [name, value] of Object.entries(captured)) {
    if (isReplayable(name)) out[name] = value;
  }
  return out;
}
