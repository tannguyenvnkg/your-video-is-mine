// Shared code for the e2e harnesses: load real Edge + read job state + inspect the output file with ffprobe.
// Used by: hls-403.mjs (local 403 fixture), real-demuxed.mjs (public demuxed stream).

import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXT = join(ROOT, '.output/chrome-mv3');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function requireBuild() {
  if (!existsSync(EXT)) {
    console.error(`✗ No build found at ${EXT}. Run \`pnpm build\` first.`);
    process.exit(1);
  }
}

/**
 * Runs `fn` with a CLEAN Edge context that has the extension loaded.
 *
 * A separate context per CASE is REQUIRED, not excess caution: the DNR session rule lives for
 * the whole session (exactly bug §2.10 "leaking rule"). Sharing a context would let the previous
 * case's rule inject a Referer into the next case -> the "variants get 403" case would pass
 * WRONGLY and the ratchet would trip by mistake. This was considered — don't merge them for speed.
 */
export async function withBrowser(downloadFolder, fn) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'yvim-e2e-'));
  const downloadsPath = mkdtempSync(join(tmpdir(), 'yvim-dl-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'msedge',
    headless: false,
    downloadsPath,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
    ],
  });
  const logs = [];
  const watch = (t, tag) => {
    t.on?.('console', (m) => logs.push(`[${tag}] ${m.type()}: ${m.text()}`));
    t.on?.('pageerror', (e) => logs.push(`[${tag}] pageerror: ${e.message}`));
  };
  ctx.on('page', (p) => watch(p, 'page'));
  ctx.on('serviceworker', (w) => watch(w, 'sw'));
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30_000 });
    watch(sw, 'sw');
    const extId = new URL(sw.url()).host;
    const page = await ctx.newPage();
    watch(page, 'options');
    await page.goto(`chrome-extension://${extId}/options.html`);
    // Download into a run-specific folder -> doesn't touch the user's real files, cleans up fully.
    await page.evaluate(
      (folder) => chrome.storage.local.set({ 'settings:downloadFolder': folder }),
      downloadFolder,
    );
    return await fn({ page, logs, extId });
  } finally {
    await ctx.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(downloadsPath, { recursive: true, force: true });
  }
}

/** Waits for the HLS job to finish; returns the final job record (or null if HUNG). */
export async function waitJob(page, jobId, timeoutMs) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    const job = await page.evaluate(async (id) => {
      const all = await chrome.storage.session.get('hlsjobs');
      return all.hlsjobs?.[id] ?? null;
    }, jobId);
    if (job) {
      const now = `${job.phase} ${job.segmentsDone}/${job.segmentsTotal}`;
      if (now !== last) {
        console.log(`      [${((Date.now() - t0) / 1000).toFixed(1)}s] ${now}`);
        last = now;
      }
      if (['done', 'error', 'cancelled'].includes(job.phase)) return job;
    }
    await sleep(400);
  }
  return null;
}

/**
 * Waits for the file to land on disk; returns the finished downloads entry.
 *
 * ⚠️ MEASURED, DON'T "FIX" THIS TO FILTER-BY-NAME: Playwright INTERCEPTS every download and
 * redirects it to its own artifact folder, named by UUID. So `item.filename` is NOT
 * `~/Downloads/<folder>/x.mp4` but `<downloadsPath>/<uuid>`. The INTENDED filename must be
 * asserted separately via `job.filename`. Each case has its own clean context -> exactly one
 * download -> taking the newest entry is enough.
 */
export async function waitDownloadedFile(page, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const items = await page.evaluate(async () => {
      const list = await chrome.downloads.search({ limit: 5, orderBy: ['-startTime'] });
      return list.map((i) => ({
        filename: i.filename,
        state: i.state,
        bytesReceived: i.bytesReceived,
        error: i.error,
      }));
    });
    const done = items.find((i) => i.state !== 'in_progress');
    if (done) return done;
    await sleep(300);
  }
  return null;
}

/**
 * ffprobes the output file: COUNTS FRAMES + duration + whether video/audio tracks exist.
 *
 * 🔬 WHY COUNT FRAMES instead of just measuring duration — MEASURED, DON'T "SIMPLIFY" THIS BACK:
 * Injected a mutation that drops segment #5 entirely and ran it for real: the file shrank from
 * 122KB -> 111KB but **duration STAYED 10.03s** and a duration-based assertion reported PASS
 * (a false green in this very test). Reason: `concat:` byte-joins the MPEG-TS segments, the
 * original timestamps in the remaining segments are kept as-is -> dropping a middle segment just
 * creates a GAP, the final PTS marker is still at the end.
 * => Duration is BLIND to a dropped segment. Frame count is not.
 * ⚠️ Consequence: acceptance criterion W1.2 in NGHIEN-CUU-VDH.md ("output file duration matches
 *    totalDuration") is WRONG — it fails to catch the very §2.6 race it was written to catch.
 */
export function probeFile(path, { countFrames = true } = {}) {
  try {
    const out = execFileSync(
      'ffprobe',
      [
        '-v', 'error',
        ...(countFrames ? ['-count_frames'] : []),
        '-show_entries', 'format=duration',
        '-show_entries', `stream=codec_type,codec_name${countFrames ? ',nb_read_frames' : ''}`,
        '-of', 'json',
        path,
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    const j = JSON.parse(out);
    const streams = j.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    return {
      duration: Number(j.format?.duration ?? 0),
      codecs: streams.map((s) => s.codec_type),
      codecNames: streams.map((s) => s.codec_name),
      videoFrames: Number(video?.nb_read_frames ?? 0),
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
    };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}
