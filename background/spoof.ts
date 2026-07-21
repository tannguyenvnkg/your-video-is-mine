import {
  buildRefererSpoofRule,
  hasConflictingSensitiveRule,
  hostFromUrl,
  originFromUrl,
  staleSpoofRuleIds,
  type DnrRule,
  buildHeaderSpoofRule,
} from '@/utils/dnr';
import { planHeaderReplay, stripSensitive } from '@/utils/headers';
import { getHlsJobs, getDownloads } from '@/utils/storage';
import type { MediaItem } from '@/utils/types';
import { TERMINAL_PHASES } from '@/background/constants';

// Cap on the number of hosts spoofed per job (VDH caps the total at ~750 rules; a job here rarely
// exceeds a few hosts, but the cap keeps a malformed manifest from spawning hundreds of rules).
export const MAX_SPOOF_HOSTS = 64;

/** W2.1 — the player's real captured headers + the host they were captured for. */
export interface CapturedContext {
  headers: Record<string, string>;
  /** host of the URL whose request was observed; decides which headers may be fired at a different host. */
  host: string;
  /** origin of the captured URL — used to ANCHOR a rule carrying a sensitive header (prevents leaking to subdomains). */
  origin: string;
}

/**
 * W2.1 — get the header capture for THIS EXACT media (undefined if no request was ever observed for it).
 *
 * ⚠️ Must NOT be loosened into "grab any item on the tab" the way `pageUrlFor` does: `pageUrl` is a
 * page-level fact so borrowing between media items is reasonable, but headers are a request-level
 * fact — borrowing another video's `Authorization` is a new kind of fabrication, exactly what W2.1
 * exists to kill.
 */
export function capturedContextOf(
  media?: MediaItem,
): CapturedContext | undefined {
  if (!media?.sentHeaders) return undefined;
  const host = hostFromUrl(media.url);
  const origin = originFromUrl(media.url);
  if (!host || !origin) return undefined;
  return { headers: media.sentHeaders, host, origin };
}

/**
 * W2.1 — pick the spoof rule: REPLAY the real headers if captured, otherwise fall back to the old FABRICATION path.
 *
 * 🔴 THE FALLBACK IS REQUIRED, NOT EXTRA CAUTION. We only capture headers when a player request for
 * that exact URL was observed. Media detected via DOM/MSE, or a tab that already finished loading
 * before the extension started listening, will have empty `sentHeaders`. Dropping the fallback would
 * lose the 403-bypass feature that IS CURRENTLY WORKING (e2e `variants-403`, `segments-other-host`,
 * `progressive-403` are all green thanks to it).
 */
function buildSpoofRule(
  ruleId: number,
  host: string,
  targetUrl: string,
  pageUrl: string | undefined,
  captured: CapturedContext | undefined,
  /**
   * W2.1 debt (a) — this host already has a sensitive rule from ANOTHER live job. Stacking a second
   * sensitive rule makes the earlier job pick up the wrong token (MEASURED: DNR lets the higher id
   * win, applying it to the other job's request too). True -> downgrade the plan to just
   * Referer/Origin so the first job keeps its own correct token.
   */
  suppressSensitive = false,
): DnrRule | null {
  if (captured) {
    let plan = planHeaderReplay(captured.headers, {
      sameHost: host === captured.host,
    });
    if (suppressSensitive && plan.hasSensitive) plan = stripSensitive(plan);
    // isEmpty = the capture was entirely made of discarded headers -> treat it as if nothing was
    // captured -> continue down to the fallback.
    if (!plan.isEmpty) {
      // A rule carrying a sensitive header (Authorization, x-* token) must be ANCHORED by origin:
      // DNR's requestDomains also match subdomains, so without anchoring the token leaks to
      // api./accounts./cdn. on the same apex domain.
      return buildHeaderSpoofRule(
        ruleId,
        host,
        plan.headers,
        plan.hasSensitive ? captured.origin : undefined,
      );
    }
  }
  const refererBase =
    pageUrl && pageUrl.startsWith('http') ? pageUrl : targetUrl;
  const origin = originFromUrl(refererBase);
  if (!origin) return null;
  return buildRefererSpoofRule(ruleId, host, refererBase, origin);
}

// Apply a DNR session rule that spoofs Referer/Origin for the media's host (bypasses non-DRM hotlink/403).
// W2.4: `ruleId` is provided by the caller (allocateSpoofRuleId) — a separate id per (download, host)
// so two downloads on the same host don't steal each other's rule.
// W2.1: prefer the player's REAL headers (`captured`), only FABRICATE when there's nothing to replay.
export async function applySpoof(
  ruleId: number,
  targetUrl: string,
  pageUrl?: string,
  captured?: CapturedContext,
  /**
   * W2.1 debt (a) — force the downgrade (keep only the REAL Referer/Origin, drop the token)
   * REGARDLESS of whether there's a conflict. Used for the best-effort BACKGROUND fetch
   * (learnMasterChildren): a live sensitive background rule can make a REAL download of a DIFFERENT
   * asset (different token, same host) downgrade its own token and then 403 (MEASURED in e2e
   * dual-host-different-token). Still uses the capture's real Referer/Origin -> doesn't fabricate an
   * Origin (§2.11).
   */
  forceStripSensitive = false,
): Promise<void> {
  const host = hostFromUrl(targetUrl);
  if (!host) return;
  // W2.1 debt (a) — only downgrade when this host already has a sensitive rule from ANOTHER job that
  // sets a sensitive header with a CONFLICTING value (a different token) than what this job is about
  // to set. (MEASURED: when two rules both match, DNR lets the higher id win and applies it to EVERY
  // request to the origin -> the earlier job picks up the later job's token.)
  // 🔴 A VALUE conflict, not mere existence: two downloads on the same site usually share one session
  // token -> suppressing based on existence would wrongly 403 the same-token case (more common than
  // the different-token case). Same token -> no conflict -> do NOT suppress -> both still download
  // fine. Only checked when this job is ACTUALLY about to set a sensitive header (plan.hasSensitive);
  // the Referer/Origin fallback carries no sensitive header so no check is needed. Best-effort: two
  // jobs starting close together still have a narrow race window (both read the rule before either
  // gets to write) — narrow, acceptable for a debt that's already rare.
  let suppressSensitive = forceStripSensitive;
  if (!suppressSensitive && captured) {
    const plan = planHeaderReplay(captured.headers, {
      sameHost: host === captured.host,
    });
    if (plan.hasSensitive) {
      try {
        const existing =
          (await browser.declarativeNetRequest.getSessionRules()) as unknown as DnrRule[];
        suppressSensitive = hasConflictingSensitiveRule(
          existing,
          host,
          plan.headers,
        );
      } catch {
        // getSessionRules failed -> keep the old behavior (don't suppress); don't block the download.
      }
    }
  }
  const rule = buildSpoofRule(
    ruleId,
    host,
    targetUrl,
    pageUrl,
    captured,
    suppressSensitive,
  );
  if (!rule) return;
  try {
    // Cast: DnrRule (string literals) is structurally compatible with the API's Rule type.
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [rule.id],
      addRules: [rule],
    } as unknown as Parameters<
      typeof browser.declarativeNetRequest.updateSessionRules
    >[0]);
  } catch {
    // Missing host access or an API error -> ignore (still try downloading without the spoof).
  }
}

// Remove a spoof session rule by id (W2.4: a separate id per download). removeRuleIds skips ids that
// don't exist, so calling it redundantly is harmless.
export async function removeSpoofRules(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: ids,
    } as unknown as Parameters<
      typeof browser.declarativeNetRequest.updateSessionRules
    >[0]);
  } catch {
    // ignore
  }
}

/**
 * W2.4 — reconcile & clean up leaked spoof rules: remove every session rule in the spoof range that
 * has NO live job/download still using it.
 *
 * Why this is REQUIRED: switching to a counter-based id lost the "re-adding the same host replaces
 * the old rule" property that the old host-hash scheme gave for free, so a dead job's rule (SW killed
 * mid-way, never got to clean up) would stay around until the browser restarts. Called on
 * `onStartup` (browser reopened) and every time the SW cold-starts mid-session.
 *
 * Safe for a running job: a live job sits in storage at a non-terminal phase -> its id is in the
 * "alive" set -> it is NOT swept. (The SW can die while offscreen keeps downloading; when the SW
 * revives, the job is still at 'fetching' in storage so its rule is kept.)
 */
export async function sweepStaleSpoofRules(): Promise<void> {
  try {
    const rules = await browser.declarativeNetRequest.getSessionRules();
    const sessionIds = rules.map((r) => r.id);
    const alive = new Set<number>();
    const jobs = await getHlsJobs();
    for (const job of Object.values(jobs)) {
      if (!TERMINAL_PHASES.has(job.phase)) {
        for (const id of job.spoofRuleIds ?? []) alive.add(id);
      }
    }
    const downloads = await getDownloads();
    for (const d of Object.values(downloads)) {
      if (d.state === 'in_progress') {
        for (const id of d.spoofRuleIds ?? []) alive.add(id);
      }
    }
    const stale = staleSpoofRuleIds(sessionIds, alive);
    if (stale.length > 0) await removeSpoofRules(stale);
  } catch {
    // best-effort — the sweep is garbage collection, it must never be allowed to break anything.
  }
}
