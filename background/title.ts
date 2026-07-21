import { pickTitle, sameDocument } from '@/utils/title';
import { setTabNavUrl } from '@/utils/storage';
import { describeError } from '@/utils/errors';
import type { MediaItem } from '@/utils/types';

/**
 * Wait cap when reading the page title. Reading the filename is a SIDE concern — it must not be
 * allowed to hold up the whole download.
 *
 * Real case: if the renderer hangs (heavy page, devtools breakpoint), `executeScript` never resolves.
 * This call sits BEFORE `putHlsJob`/`putDownload`, so hanging here means clicking Download does
 * NOTHING: no job, no error, no log line — exactly the kind of silent failure this project has paid
 * for before.
 */
const TITLE_READ_TIMEOUT_MS = 3_000;

function withTitleTimeout<T>(p: Promise<T>): Promise<T | undefined> {
  return Promise.race([
    p,
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), TITLE_READ_TIMEOUT_MS),
    ),
  ]);
}

/**
 * W4.3 — seed `navUrl` for tabs ALREADY OPEN when the service worker starts up.
 *
 * Without this step, a tab open before the extension was installed/updated has no `navUrl` (only
 * `resetTab` via main_frame and `tabs.onUpdated` ever set it), so any media detected in it does NOT
 * get stamped -> the anti-wrong-name guard closes -> the filename falls back to `master.mp4` even
 * though the user is standing right on that page. Seed it upfront so the common case still gets a nice name.
 */
export async function seedNavUrls(
  run: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<void> {
  try {
    const tabs = await browser.tabs.query({});
    for (const t of tabs) {
      const id = t.id;
      const url = t.url;
      if (typeof id === 'number' && id >= 0 && url?.startsWith('http')) {
        await run(() => setTabNavUrl(id, url));
      }
    }
  } catch (e) {
    console.warn('[bg] W4.3 không nạp được navUrl ban đầu:', describeError(e));
  }
}

/**
 * W4.3 — resolve the video title AT DOWNLOAD TIME, not at detection time.
 *
 * WHY READ LATE: network-based detection (`onBeforeRequest`/`onHeadersReceived`/`onSendHeaders`)
 * runs BEFORE the content script (`document_idle`) — that's exactly why most HLS/DASH media used to
 * have no title at all and fell back to `master.mp4`. Reading when the user clicks download means the
 * DOM is already built and `og:title` already exists. Reading late also means we do NOT need to store
 * the title on `MediaItem` -> avoids `upsertMedia`'s "first writer wins" trap, and there's no race to lose.
 *
 * On `frameIds: [0]` — MEASURED (e2e `title-og` + mutation ME5, 2026-07-19): it is NOT what's doing
 * the work. `executeScript` already only injects into the TOP frame by default, so removing this line
 * still leaves the e2e test green. Kept because it states intent clearly and guards against someone
 * later switching to `allFrames: true` — that's when an embedded player's iframe (with its own title
 * like 'JW Player') would actually have a chance to sneak in. DO NOT write it off as "required":
 * fixture `/og.html` already has an iframe with a wrong title and the mutation still doesn't fire.
 */
export async function resolveTitle(
  tabId: number | undefined,
  media: MediaItem | undefined,
): Promise<string | undefined> {
  const stored = media?.title;
  const detectedAt = media?.detectPageUrl;
  if (tabId === undefined || tabId < 0) {
    return pickTitle({ stored }, detectedAt);
  }

  let tab: { url?: string; title?: string } | undefined;
  try {
    tab = await withTitleTimeout(browser.tabs.get(tabId));
  } catch {
    // Tab already closed / evicted from memory by Chrome. Not an error — just use what was stored.
    tab = undefined;
  }
  const currentUrl = tab?.url;

  // 🔴 The anti-WRONG-NAME guard — CLOSED when facts are missing (adversarial review: 6 independent
  // lenses all pointed here). Both cases must be blocked:
  //  - media detected on a different page than the one currently open (user switched videos SPA-style);
  //  - media with NO page stamp (`detectPageUrl` empty) -> we have no way to know which page it
  //    belongs to, so we must NOT borrow the title of the currently open page.
  // Blocking here only makes the filename fall back to a URL-derived name. Letting it through would
  // produce a WRONG name that looks very real — far worse than `master.mp4`, because the user TRUSTS it.
  if (!detectedAt || !sameDocument(detectedAt, currentUrl)) {
    return pickTitle({ stored }, detectedAt ?? currentUrl);
  }

  let meta: { og?: string; twitter?: string; doc?: string } = {};
  try {
    const results = await withTitleTimeout(
      browser.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => {
          const read = (sel: string): string | undefined => {
            const el = document.querySelector(sel);
            const v = el?.getAttribute('content') ?? undefined;
            return v && v.trim() ? v : undefined;
          };
          return {
            og: read('meta[property="og:title"]'),
            twitter:
              read('meta[name="twitter:title"]') ??
              read('meta[property="twitter:title"]'),
            doc: document.title || undefined,
          };
        },
      }),
    );
    meta = results?.[0]?.result ?? {};
  } catch (e) {
    // Page forbids script injection (chrome://, Web Store, PDF viewer) — NOT an error for the download.
    // Log it instead of swallowing it whole: a bare `catch {}` is what hid 3 fatal bugs in this project.
    console.warn('[bg] W4.3 không đọc được tiêu đề trang:', describeError(e));
  }

  return pickTitle(
    {
      og: meta.og,
      twitter: meta.twitter,
      doc: meta.doc,
      tab: tab?.title,
      stored,
    },
    currentUrl ?? detectedAt,
  );
}
