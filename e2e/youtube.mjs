// Phase 2 e2e (Track 2 — YouTube fast path): proves the isolated-world content script really runs
// inside the built extension, calls youtubei/v1/player impersonating the ANDROID/IOS app client,
// and reports a downloadable `type:'youtube'` candidate into chrome.storage.session.
//
// This is the "runs for real" gate for Phase 2 — the static gates cannot prove an isolated-world
// same-origin fetch to YouTube actually works. Needs `pnpm build` first + live network.
//
// ⚠️ POSSIBLY FLAKY: it hits the real youtube.com. YouTube changes under us (SABR rollout, client
// version bumps, bot walls). A red run here is a signal to RE-MEASURE, not automatically a code bug.

import { withBrowser, requireBuild, sleep } from './lib.mjs';

// Default: Rick Astley (VEVO) — measured 2026-07-22 to return avc1 1080p + AAC. Overridable via argv.
const VIDEO_ID = process.argv[2] || 'dQw4w9WgXcQ';
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const DEADLINE_MS = 30_000;

/** Scans ALL `media:<tabId>` session entries for youtube items (avoids needing the exact tabId). */
async function readYoutubeItems(extPage) {
  return await extPage.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    const out = [];
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith('media:')) continue;
      for (const it of v?.items ?? []) {
        if (it.type === 'youtube') out.push(it);
      }
    }
    return out;
  });
}

async function main() {
  requireBuild();
  const { items, ok } = await withBrowser('yt-e2e', async ({ page: extPage }) => {
    // extPage is the extension's own options.html (can read chrome.storage.session).
    // Open the real YouTube watch page in a SEPARATE tab of the same browser context so the
    // youtube.com content script runs against a genuine page + origin.
    const yt = await extPage.context().newPage();
    try {
      await yt.goto(WATCH_URL, {
        waitUntil: 'domcontentloaded',
        timeout: DEADLINE_MS,
      });
    } catch (e) {
      console.error('  ! could not open youtube:', e?.message ?? e);
    }
    // Poll storage.session until the candidate lands (content script runs at document_idle, then
    // fetches InnerTube, then messages background which writes storage).
    const t0 = Date.now();
    let found = [];
    while (Date.now() - t0 < DEADLINE_MS) {
      found = await readYoutubeItems(extPage);
      if (found.length > 0) break;
      await sleep(500);
    }
    // Diagnostic on failure: prove whether the endpoint itself works from this machine/session by
    // calling it in the PAGE (main world). If this succeeds but the candidate never appeared, the
    // problem is the isolated-world content script, not the network.
    let pageProbe = null;
    if (found.length === 0) {
      pageProbe = await yt
        .evaluate(async (videoId) => {
          try {
            const res = await fetch(
              'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  context: {
                    client: {
                      clientName: 'ANDROID',
                      clientVersion: '20.10.38',
                      androidSdkVersion: 34,
                      hl: 'en',
                      gl: 'US',
                    },
                  },
                  videoId,
                  contentCheckOk: true,
                  racyCheckOk: true,
                }),
              },
            );
            const j = await res.json();
            const adap = j?.streamingData?.adaptiveFormats ?? [];
            return {
              status: j?.playabilityStatus?.status,
              adaptiveWithUrl: adap.filter((f) => !!f.url).length,
            };
          } catch (e) {
            return { error: String(e?.message ?? e) };
          }
        }, VIDEO_ID)
        .catch((e) => ({ error: String(e?.message ?? e) }));
    }
    await yt.close().catch(() => {});
    if (pageProbe) console.error('  page-world probe:', JSON.stringify(pageProbe));
    return { items: found, ok: found.length > 0 };
  });

  console.log(`\n  youtube candidates found: ${items.length}`);
  for (const it of items) {
    console.log(
      `    videoId=${it.youtubeVideoId} heights=[${(it.youtubeHeights ?? []).join(', ')}] title=${JSON.stringify(it.title ?? '')}`,
    );
  }

  const item = items[0];
  const heightsOk = Array.isArray(item?.youtubeHeights) && item.youtubeHeights.length > 0;
  const idOk = item?.youtubeVideoId === VIDEO_ID;
  const pass = ok && heightsOk && idOk;

  if (!pass) {
    console.error(
      `\n✗ FAIL: expected a youtube candidate for ${VIDEO_ID} with >=1 height` +
        ` (ok=${ok} idOk=${idOk} heightsOk=${heightsOk}).`,
    );
    process.exit(1);
  }
  console.log(`\n✓ PASS: detected ${VIDEO_ID} — ${item.youtubeHeights.length} height(s), best ${item.youtubeHeights[0]}p.`);
}

main().catch((e) => {
  console.error('PROBE_ERROR:', e?.message ?? e);
  process.exit(2);
});
