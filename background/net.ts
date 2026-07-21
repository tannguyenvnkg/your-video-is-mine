import {
  applySpoof,
  removeSpoofRules,
  capturedContextOf,
  type CapturedContext,
} from '@/background/spoof';
import { allocateSpoofRuleId, getTabMedia } from '@/utils/storage';

/**
 * W2.2 — enable a Referer/Origin spoof TIGHTLY WRAPPED around one fetch, then remove it right in `finally`.
 *
 * §2.3: `handleVariants`/`handleHlsEstimate` are the FIRST TWO fetches of the flow, and they used to
 * fetch bare ⇒ an anti-hotlink site would 403 right at the "Quality" step, so `handleHlsDownload`
 * (the function WITH spoofing) never got called at all ⇒ the 403-bypass feature was dead code exactly
 * on the site that needed it most.
 *
 * `pageUrl` (looked up from `media.pageUrl` by tabId) is the page's REAL Referer — important because
 * hotlink checks usually match Referer against the site's domain, not the CDN's. Without pageUrl,
 * applySpoof falls back to using targetUrl itself (enough to pass a "missing Referer" gate, but a
 * weaker match on a site that checks the domain).
 *
 * W2.4: allocate a SEPARATE id for each fetch (allocateSpoofRuleId) and remove exactly that id -> two
 * downloads/estimates on the SAME host no longer steal each other's rule (the old W2.2 limitation is gone).
 */
export async function withSpoofedFetch<T>(
  targetUrl: string,
  pageUrl: string | undefined,
  fn: () => Promise<T>,
  captured?: CapturedContext,
  forceStripSensitive = false,
): Promise<T> {
  const ruleId = await allocateSpoofRuleId();
  await applySpoof(ruleId, targetUrl, pageUrl, captured, forceStripSensitive);
  try {
    return await fn();
  } finally {
    await removeSpoofRules([ruleId]);
  }
}

/**
 * pageUrl to build the real Referer. Prefer the item matching `url` (the master); if none matches
 * (e.g. estimate only has the variant URL, no matching media) fall back to the pageUrl of any item on
 * the tab — pageUrl is really a fact about the whole PAGE (resetTab clears everything on navigation
 * so every item belongs to the same page). undefined when there's no tabId or the tab has no media yet.
 */
export async function pageUrlFor(
  tabId?: number,
  url?: string,
): Promise<string | undefined> {
  if (tabId === undefined || tabId < 0) return undefined;
  const items = await getTabMedia(tabId);
  if (url) {
    const exact = items.find((m) => m.url === url)?.pageUrl;
    if (exact) return exact;
  }
  return items.find((m) => m.pageUrl)?.pageUrl;
}

/**
 * W2.1 — real header capture for the EXACT `url`. EXACT MATCH ONLY, no fallback.
 *
 * Intentionally different from `pageUrlFor` right above: that function is allowed to fall back to
 * any item because `pageUrl` is a fact at the PAGE level. Headers are a fact at the REQUEST level —
 * assigning another media's headers to this request is FABRICATION, the exact thing W2.1 exists to
 * kill. No match -> undefined -> fall back to the old spoof.
 */
export async function capturedFor(
  tabId: number | undefined,
  url: string,
): Promise<CapturedContext | undefined> {
  if (tabId === undefined || tabId < 0) return undefined;
  const items = await getTabMedia(tabId);
  return capturedContextOf(items.find((m) => m.url === url));
}
