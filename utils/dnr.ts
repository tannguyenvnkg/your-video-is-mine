// Builds a session rule for chrome.declarativeNetRequest to SPOOF Referer/Origin,
// bypassing hotlink-protection/403 at the NON-DRM level. MV3 webRequest only OBSERVES (cannot
// modify headers) -> must use DNR (declarativeNetRequestWithHostAccess) to modify request headers.
// Pure logic (no chrome API dependency) -> unit testable.

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
    /** -1 = request NOT tied to any tab (issued by the extension's SW/offscreen). */
    tabIds: number[];
    /**
     * Anchors the rule to EXACTLY one origin (e.g. `|https://example.com/`).
     *
     * 🔴 REQUIRED for a rule carrying a sensitive header: DNR's `requestDomains:['example.com']`
     * matches **every subdomain too** (`api.`, `accounts.`, `cdn.`) -> an `Authorization` token for
     * media on the apex would leak to every subdomain the extension fetches to. `|` anchors to the
     * start of the URL, so `https://api.example.com/` does NOT match `|https://example.com/`.
     */
    urlFilter?: string;
  };
}

/**
 * Id range reserved for spoof rules. Every rule from this mechanism is >= MIN, so reconciliation
 * (staleSpoofRuleIds) can tell for certain which ids belong to it without touching other
 * mechanisms' rules. SPAN is large enough that the counter almost never wraps within one browser
 * session.
 */
export const SPOOF_RULE_ID_MIN = 2000;
export const SPOOF_RULE_ID_SPAN = 1_000_000;

/** hostname of a URL, or null if the URL is invalid. */
export function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** origin (scheme://host[:port]) of a URL, or null. */
export function originFromUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Applies to the request types issued by the EXTENSION ITSELF when downloading media.
// `fetch()` (from SW/offscreen) maps to 'xmlhttprequest'; 'other' covers the rest (e.g.
// chrome.downloads.download). 'media'/'sub_frame'/'object' were REMOVED — those are request types
// from the PAGE'S PLAYER, and spoofing them would overwrite Referer/Origin on the page's own
// traffic (§2.10 — W2.4).
const SPOOFED_RESOURCE_TYPES = ['xmlhttprequest', 'other'];

/**
 * A rule that sets Referer + Origin for requests to `host`.
 *
 * W2.4: `id` is now assigned by the CALLER (one id per download×host pair) instead of being
 * derived from the host. Previously id = hash(host) -> two downloads on the same CDN shared one
 * rule, and whichever finished first yanked the rule out from under the one still running ->
 * the other 403'd mid-download (§2.10). Per-download ids don't collide.
 * `tabIds:[-1]` restricts the rule to requests issued BY the extension only -> does not touch the
 * user's own browsing.
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
 * W2.1 — a rule that sets EXACTLY the given set of headers, nothing added, nothing dropped.
 *
 * Unlike `buildRefererSpoofRule` (the OLD FAKED version: always carries the same 2 headers we
 * guessed at), the caller fully controls the list here, which lets the **§2.11 golden rule** be
 * enforced: if the page didn't send a given header, no entry is generated for it. Setting
 * `Origin` unconditionally on GET could ITSELF CAUSE a 403 on CDNs that treat a stray Origin as a
 * CORS violation.
 *
 * 🔬 MEASURED (Edge, fetch from SW, tabId -1): DNR can set EVERY header tried — cookie, referer,
 * origin, authorization, user-agent, accept-language and an unknown header (`x-playback-session-id`).
 * This means the replay does NOT need to thread headers through 5 layers into offscreen, and it
 * avoids the trap in `utils/retry.ts` that overwrites the byterange `Range`.
 */
export function buildHeaderSpoofRule(
  id: number,
  host: string,
  headers: Readonly<Record<string, string>>,
  /** Anchors by origin — used when the rule carries a sensitive header (see `condition.urlFilter`). */
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

/** Header names that are safe to replay cross-host and never count as "sensitive". */
const CROSS_HOST_SAFE_HEADERS = new Set(['referer', 'origin']);

/**
 * W2.1 debt (a) — does an already-live DNR rule for `host` set a sensitive header to a value that
 * CONFLICTS with the ones we are about to set?
 *
 * Measured on Edge (two hand-built rules on one origin): when two `modifyHeaders` rules match the
 * same request, the HIGHER rule id wins and applies to EVERY request to that origin — including a
 * different job's. So two same-host downloads carrying DIFFERENT `Authorization` values make the
 * older job silently receive the newer job's token (measured: TOKEN_A + TOKEN_B -> server got
 * TOKEN_B). Guard: a newer job that finds a CONFLICTING sensitive rule drops its own sensitive
 * headers (falls back to Referer/Origin), so the older job keeps the token it needs.
 *
 * 🔴 CONFLICT, not mere existence: two downloads from the same site usually share ONE session
 * token, so an existence-only check would wrongly suppress the very common same-token case and 403
 * the second download. We only suppress when an existing rule sets a sensitive header to a value we
 * do NOT set to the same thing (different value, or a sensitive header we don't set at all — it
 * would leak onto our requests). "Sensitive" = a `set` header that is not `referer`/`origin`.
 *
 * Pure function for unit testing; the caller (`applySpoof`) passes `getSessionRules()` in.
 *
 * ⚠️ KNOWN LIMITATIONS (adversarial review 2026-07-21) — all rooted in ONE DNR fact: rules are
 * per-ORIGIN and the higher id wins a header for EVERY request to that origin. Two same-host
 * different-token downloads therefore CANNOT both succeed via header replay — one must lose. This
 * policy makes the NEWER job lose (drop its token, 403 loudly). Consequences we accept for now:
 *   1. STALE rule (review A/F): a crashed/stuck job leaves its sensitive rule live for ~60-90s
 *      until reaped. A fresh same-host retry with a DIFFERENT (refreshed) token sees that stale
 *      rule as a conflict and suppresses its own good token -> 403. The check can't tell a live
 *      job from dead residue. Rare (needs crash/expiry + same host + different token + retry inside
 *      the window); a full fix needs job-liveness awareness, out of this package's scope.
 *   2. HOST-only match (review B): we match `requestDomains` (host) and ignore the existing rule's
 *      `urlFilter` origin anchor, so two same-host rules on different scheme/port (origins that can
 *      never both match one request) still count as a conflict. Rare; over-suppresses.
 *   3. ONE-DIRECTIONAL (review D): we only flag a sensitive header the EXISTING rule sets to a
 *      different value. A sensitive header WE set that the existing rule LACKS is not flagged, so
 *      via higher-id-wins it still lands on the older job's requests. Not new (pre-suppression had
 *      the same leak); suppression is a partial mitigation, not a complete one.
 */
export function hasConflictingSensitiveRule(
  rules: readonly DnrRule[],
  host: string,
  ownHeaders: Readonly<Record<string, string>>,
): boolean {
  return rules.some(
    (r) =>
      r.action?.type === 'modifyHeaders' &&
      r.condition?.requestDomains?.includes(host) &&
      (r.action.requestHeaders ?? []).some((h) => {
        if (h.operation !== 'set') return false;
        const name = h.header.toLowerCase();
        if (CROSS_HOST_SAFE_HEADERS.has(name)) return false;
        return ownHeaders[name] !== h.value;
      }),
  );
}

/**
 * Reconciles leaked rules (W2.4 sweep): among the current `sessionRuleIds`, any id in the spoof
 * range (>= MIN) that is NOT in the `aliveRuleIds` set (ids of still-live jobs/downloads) is JUNK -> delete.
 *
 * Why a sweep is REQUIRED: counter-based ids lose the "re-adding the same host replaces the old
 * rule" property that hash-host used to give, so a leaked rule (job died before cleanup) would
 * live forever until the browser restarts. The id >= MIN cutoff: NEVER touch a lower rule id (from
 * another mechanism), even if it's not found in the live set.
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
