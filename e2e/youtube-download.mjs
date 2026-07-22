// Phase 3 e2e (Track 2 — YouTube fast path): the "runs for real" gate. Opens a real short video,
// triggers a download (background re-extracts fresh URLs from the content script, offscreen fetches
// the two googlevideo tracks and muxes them with libav), then ffprobes the output: it MUST have an
// H.264 video track, an AAC audio track, and a positive frame count.
//
// Needs `pnpm build` first + live network + ffprobe on PATH. ⚠️ POSSIBLY FLAKY (real youtube.com).
// A red run is a signal to re-measure, not automatically a code bug.

import { existsSync } from 'node:fs';
import {
  withBrowser,
  requireBuild,
  waitJob,
  waitDownloadedFile,
  probeFile,
  sleep,
} from './lib.mjs';

// "Me at the zoo" — 19s, tiny, stable, public. Only ~240p avc1, which is exactly what we want: a fast
// download + mux that still exercises the full 2-track pipeline. Overridable via argv.
const VIDEO_ID = process.argv[2] || 'jNQXAC9IVRw';
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const DETECT_MS = 30_000;
const JOB_MS = 120_000;

/** Finds the youtube candidate + its tabId (parsed from the `media:<tabId>` storage key). */
async function findCandidate(extPage) {
  return await extPage.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith('media:')) continue;
      const tabId = Number(k.slice('media:'.length));
      for (const it of v?.items ?? []) {
        if (it.type === 'youtube') {
          return {
            tabId,
            videoId: it.youtubeVideoId,
            heights: it.youtubeHeights ?? [],
          };
        }
      }
    }
    return null;
  });
}

async function main() {
  requireBuild();
  const result = await withBrowser('yt-dl-e2e', async ({ page: extPage }) => {
    const yt = await extPage.context().newPage();
    await yt
      .goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: DETECT_MS })
      .catch((e) => console.error('  ! open youtube:', e?.message ?? e));

    // 1) Wait for the content script to detect + report the candidate.
    let cand = null;
    const t0 = Date.now();
    while (Date.now() - t0 < DETECT_MS) {
      cand = await findCandidate(extPage);
      if (cand?.videoId) break;
      await sleep(500);
    }
    if (!cand?.videoId) {
      return { fail: 'no candidate detected (Phase 2 broke, or video walled)' };
    }
    console.log(
      `  detected ${cand.videoId} tab=${cand.tabId} heights=[${cand.heights.join(', ')}]`,
    );

    // 2) Trigger the download at the LOWEST advertised height (fastest). Background re-extracts fresh
    //    URLs from the still-open youtube tab, then offscreen downloads + muxes.
    const height = cand.heights[cand.heights.length - 1];
    const start = await extPage.evaluate(
      async ({ videoId, tabId, height }) =>
        chrome.runtime.sendMessage({
          kind: 'youtube/download',
          videoId,
          tabId,
          height,
        }),
      { videoId: cand.videoId, tabId: cand.tabId, height },
    );
    console.log(`  youtube/download -> ${JSON.stringify(start)}`);
    if (!start?.ok) return { fail: `download did not start: ${start?.error}` };

    // 3) Wait for the (HlsJob-backed) job to finish, then the file to land on disk. Probe HERE, inside
    //    the callback — `withBrowser`'s finally block deletes the downloads folder on teardown.
    const job = await waitJob(extPage, start.jobId, JOB_MS);
    if (!job) return { fail: 'job HUNG (never reached a terminal phase)' };
    if (job.phase !== 'done') {
      return { fail: `job phase=${job.phase} error=${job.error ?? ''}` };
    }
    const file = await waitDownloadedFile(extPage, 30_000);
    await yt.close().catch(() => {});
    if (!file) return { fail: 'no downloaded file appeared' };
    if (file.state !== 'complete') {
      return { fail: `download ${file.state}: ${file.error ?? '?'}` };
    }
    if (!existsSync(file.filename)) {
      return { fail: `file does not exist: ${file.filename}` };
    }
    console.log(`  job.filename=${job.filename}`);
    const probe = probeFile(file.filename);
    console.log(`  ffprobe: ${JSON.stringify(probe)}`);
    return { job, probe };
  });

  if (result.fail) {
    console.error(`\n✗ FAIL: ${result.fail}`);
    process.exit(1);
  }

  const { job, probe } = result;
  const nameOk = typeof job.filename === 'string' && job.filename.endsWith('.mp4');
  const hasH264 = (probe.codecNames ?? []).some(
    (c) => c === 'h264' || c === 'avc1',
  );
  const hasAac = (probe.codecNames ?? []).some((c) => c === 'aac');
  const framesOk = (probe.videoFrames ?? 0) > 0;

  if (!nameOk || !hasH264 || !hasAac || !framesOk || probe.error) {
    console.error(
      `\n✗ FAIL: nameOk=${nameOk} h264=${hasH264} aac=${hasAac} frames=${probe.videoFrames} err=${probe.error ?? ''}`,
    );
    process.exit(1);
  }
  console.log(
    `\n✓ PASS: ${job.filename} — H.264 + AAC, ${probe.videoFrames} frames, ${probe.duration.toFixed(1)}s.`,
  );
}

main().catch((e) => {
  console.error('PROBE_ERROR:', e?.message ?? e);
  process.exit(2);
});
