// E2E runtime harness: loads the build into REAL Edge and runs the core feature end-to-end.
//
// WHY THIS IS NEEDED: compile/lint/test/build all stayed GREEN throughout the period when HLS
// downloading was dead (the ffmpeg core UMD-vs-ESM bug survived from the first commit). No STATIC
// gate catches this class of bug — only an actual run does. This harness is that DYNAMIC gate.
//
// Uses the pre-installed Edge (channel msedge) + playwright-core -> no 150MB browser download.
// The extension only loads in a persistent context + headed mode (Chromium limitation).
//
// Run: pnpm e2e

import { chromium } from 'playwright-core';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(root, '.output/chrome-mv3');

// Public demo playlist: plain HLS .ts, NOT encrypted, 184 segments.
const MEDIA_URL =
  'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8';
const VARIANT_URL =
  'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/tears-of-steel-audio_eng=128002-video_eng=1001000.m3u8';

const HLS_TIMEOUT_MS = Number(process.env.HLS_TIMEOUT_MS ?? 120_000);

if (!existsSync(EXT)) {
  console.error(`✗ No build found at ${EXT}. Run \`pnpm build\` first.`);
  process.exit(1);
}

const userDataDir = mkdtempSync(join(tmpdir(), 'yvim-e2e-'));
let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(`✗ ${msg}`);
};
const ok = (msg) => console.log(`✓ ${msg}`);

const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'msedge',
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
  ],
});

// Collect logs from EVERY context (including the offscreen document) — this is what nobody could see before.
const logs = [];
const watch = (target, tag) => {
  target.on?.('console', (m) => {
    const line = `[${tag}] ${m.type()}: ${m.text()}`;
    logs.push(line);
    if (m.type() === 'error') console.log(`  ${line}`);
  });
  target.on?.('pageerror', (e) => {
    const line = `[${tag}] pageerror: ${e.message}`;
    logs.push(line);
    console.log(`  ${line}`);
  });
};
ctx.on('page', (p) => watch(p, `page ${p.url() || 'about:blank'}`));
ctx.on('serviceworker', (w) => watch(w, 'sw'));

try {
  // --- Get extension id from the service worker ---
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30_000 });
  watch(sw, 'sw');
  const extId = new URL(sw.url()).host;
  ok(`Extension loaded: ${extId}`);

  // --- TEST 1: ffmpeg initializes + runs (this path awaits so errors surface) ---
  const options = await ctx.newPage();
  watch(options, 'options');
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.getByRole('button', { name: 'Kiểm tra bộ ghép video' }).click();

  const status = options.locator('.ff-status, [class*="status"]').first();
  let ffText = '';
  try {
    await options.waitForFunction(
      () => /✓|✗/.test(document.body.innerText),
      undefined,
      { timeout: 90_000 },
    );
    ffText = (await status.innerText().catch(() => '')) || '';
    if (!ffText) ffText = await options.innerText('body');
  } catch {
    fail(
      'ffmpeg: HANG — neither ✓ nor ✗ after 90s. ensureFfmpeg() did not settle.',
    );
  }
  const ffLine = (ffText.match(/[✓✗][^\n]*/) ?? [''])[0].trim();
  if (ffLine.startsWith('✓')) ok(`ffmpeg: ${ffLine}`);
  else if (ffLine.startsWith('✗')) fail(`ffmpeg: ${ffLine}`);

  // --- TEST 2: real HLS download, track the phase timeline ---
  // Send 'hls/download' directly from the extension page: background handles it exactly like
  // when the popup button is clicked. tabId -1 = no media item in storage -> still works (spoof
  // uses variantUrl itself).
  const start = await options.evaluate(
    async ([variantUrl, mediaUrl]) =>
      await chrome.runtime.sendMessage({
        kind: 'hls/download',
        variantUrl,
        mediaUrl,
        tabId: -1,
      }),
    [VARIANT_URL, MEDIA_URL],
  );
  if (!start?.ok) {
    fail(`hls/download was rejected immediately: ${JSON.stringify(start)}`);
  } else {
    ok(`hls/download accepted, jobId=${start.jobId}`);

    const t0 = Date.now();
    let last = '';
    let final = null;
    while (Date.now() - t0 < HLS_TIMEOUT_MS) {
      const job = await options.evaluate(async (id) => {
        const all = await chrome.storage.session.get('hlsjobs');
        return all.hlsjobs?.[id] ?? null;
      }, start.jobId);
      if (job) {
        const now = `${job.phase} ${job.segmentsDone}/${job.segmentsTotal}${job.error ? ` — ${job.error}` : ''}`;
        if (now !== last) {
          console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${now}`);
          last = now;
        }
        if (['done', 'error', 'cancelled'].includes(job.phase)) {
          final = job;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!final) {
      fail(
        `HLS: HUNG at phase "${last}" after ${HLS_TIMEOUT_MS / 1000}s. ` +
          `(phase 'queued' = message never reached offscreen; 'loading' = stuck before segment download)`,
      );
    } else if (final.phase === 'done') {
      ok(`HLS: download + mux done (${final.segmentsTotal} segments)`);
    } else {
      fail(`HLS: ${final.phase} — ${final.error ?? 'unknown'}`);
    }
  }
} catch (e) {
  fail(`Harness error: ${e?.message ?? e}`);
} finally {
  if (failed && logs.length) {
    console.log('\n--- Logs from all contexts (including offscreen) ---');
    for (const l of logs.slice(-40)) console.log(`  ${l}`);
  }
  await ctx.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failed ? '\n✗ E2E FAILED' : '\n✓ E2E GREEN');
process.exit(failed ? 1 : 0);
