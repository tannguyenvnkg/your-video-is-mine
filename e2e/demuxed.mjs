// Harness W1.1 — MUTE BUG (§2.1) measured on a local DEMUXED fixture.
//
// THIS IS THE CENTRAL QUESTION OF THE WHOLE PROJECT: "does the downloaded file have audio?"
// The project owner measured this by hand on a real site (2026-07-17) -> MUTE. This file turns
// that answer into something a machine can measure deterministically, offline, in 30 seconds.
//
// WHY NOT USE e2e/real-demuxed.mjs (Apple bipbop fMP4): that stream dies from bug #30
// (fMP4/CMAF broken during muxing) BEFORE producing a file -> it never reaches the mute question.
// The fixture here is MPEG-TS — a path already proven to work in W0.3 -> isolates EXACTLY one
// variable: audio.
//
// WHY VLC IS NOT NEEDED: the W1.1 roadmap acceptance note is "open VLC, listen for audio".
// `ffprobe` answers that exact question more reliably than a human ear, so acceptance does NOT
// need a manual click-through.
//
// 🔬 SELF-FLIPPING RATCHET (same mechanism as `it.fails` in W0.4 / `known-fail` in W0.3):
//   Today the `mute` case is RED = bug §2.1 is still alive. Once W1.1 is done it will PASS ->
//   the harness flips RED, forcing the label `known-fail` -> `pass` to change. Can't be forgotten
//   like a dead TODO.
//
// Run: pnpm e2e:demuxed-fixture   (needs `pnpm build` first; needs ffprobe)

import { startDemuxedServer } from './fixture-server.mjs';
import {
  requireBuild,
  withBrowser as withBrowserRaw,
  waitJob,
  waitDownloadedFile,
  probeFile,
} from './lib.mjs';
import { existsSync, statSync } from 'node:fs';

const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 120_000);
// Video: 10 segments x 1s x 10fps. Count FRAMES, not duration — duration is BLIND to a dropped
// segment (proven experimentally in W0.3, see probeFile() in lib.mjs).
const FIXTURE_FRAMES = 100;
const FIXTURE_DURATION = 10;
const DOWNLOAD_FOLDER = `yvim-demux-${process.pid}`;

requireBuild();

const withBrowser = (fn) => withBrowserRaw(DOWNLOAD_FOLDER, fn);

/**
 * Walk the FULL popup path: click "Quality" (manifest/variants) -> pick variant -> "Download .mp4".
 *
 * Deliberately does NOT hardcode the video playlist URL: the harness must go through the exact
 * gate the popup uses, otherwise it would skip right past the master-parsing step (where audio
 * evaporates). The audio URL comes from the variant per the W1.1 protocol — today that field
 * doesn't exist yet -> `undefined` -> the job runs single-input -> MUTE.
 */
async function runDemuxedDownload() {
  const srv = await startDemuxedServer();
  try {
    return await withBrowser(async ({ page, logs }) => {
      const vres = await page.evaluate(
        (url) =>
          chrome.runtime.sendMessage({ kind: 'manifest/variants', url, mediaType: 'hls' }),
        srv.masterUrl,
      );
      if (!vres?.ok) {
        return { ok: false, detail: `manifest/variants broken: ${JSON.stringify(vres)}` };
      }
      const variant = vres.variants[0];
      if (!variant) return { ok: false, detail: 'master produced no variant' };
      if (variant.uri !== srv.videoUrl) {
        return { ok: false, detail: `variant points to wrong playlist: ${variant.uri}` };
      }

      const start = await page.evaluate(
        ([v, mediaUrl]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl: v.uri,
            // W1.1 protocol: the audio stream URL the variant ACTUALLY uses. Today the parser
            // doesn't fill it in -> undefined -> this is exactly where the mute bug is born.
            audioUrl: v.audioRenditions?.find((r) => r.selected)?.uri,
            mediaUrl,
            tabId: -1,
            height: v.height,
          }),
        [variant, srv.masterUrl],
      );
      if (!start?.ok) {
        return { ok: false, detail: `hls/download rejected: ${JSON.stringify(start)}` };
      }

      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (!job) {
        return { ok: false, detail: `job HUNG after ${JOB_TIMEOUT_MS / 1000}s (no done/error)` };
      }
      if (job.phase !== 'done') {
        return { ok: false, detail: `job ${job.phase}: ${job.error ?? '?'}` };
      }
      const file = await waitDownloadedFile(page, 30_000);
      if (!file) return { ok: false, detail: 'job done but NO file landed on disk' };
      if (!existsSync(file.filename)) {
        return { ok: false, detail: `downloads reported complete but file does not exist` };
      }

      const size = statSync(file.filename).size;
      const probe = probeFile(file.filename);
      if (probe.error) return { ok: false, detail: `ffprobe could not read the output file: ${probe.error}` };

      const has = (t) => probe.codecs.includes(t);
      const tracks = probe.codecs.join('+') || 'empty';
      const hits = srv.audioSegmentHits();
      const errLog = logs.filter((l) => l.includes('error:')).slice(-3);
      const suffix =
        `— file ${(size / 1024).toFixed(0)}KB, ${probe.duration.toFixed(2)}s, ` +
        `${probe.videoFrames} frames, track: ${tracks}, fetched ${hits} audio segments` +
        `${errLog.length ? ` (error log: ${errLog.join(' | ')})` : ''}`;

      if (!has('video')) return { ok: false, detail: `output file has NO video track ${suffix}` };
      // THIS IS THE QUESTION. Today: no audio -> MUTE -> case red as expected.
      if (!has('audio')) return { ok: false, detail: `MUTE: output file has NO audio track ${suffix}` };
      // Muxing two sources with mismatched duration = audio doesn't sync with video -> just as bad
      // as mute, must be caught.
      if (Math.abs(probe.duration - FIXTURE_DURATION) > 0.5) {
        return { ok: false, detail: `duration mismatch ${probe.duration.toFixed(2)}s ${suffix}` };
      }
      if (Math.abs(probe.videoFrames - FIXTURE_FRAMES) > 2) {
        return { ok: false, detail: `missing frames ${suffix}` };
      }
      return { ok: true, detail: `has FULL video + audio ${suffix}` };
    });
  } finally {
    await srv.close();
  }
}

const SCENARIOS = [
  {
    id: 'mute',
    title: 'Demuxed master -> downloaded file must have FULL video + audio',
    // ✅ W1.1 (2026-07-17): 'known-fail' -> 'pass'. The ratchet SELF-FLIPPED exactly as designed:
    // as soon as the fix landed, this case passed and the harness flipped RED demanding the
    // label change — nobody had to remember.
    // Before the fix: "MUTE: output file has NO audio track — 81KB, track: video, fetched 0
    // audio segments". After: "164KB, track: video+audio, fetched 11 audio segments".
    // From here on this case is a REGRESSION SAFETY NET: if the mute bug comes back -> red
    // immediately.
    expect: 'pass',
    run: runDemuxedDownload,
  },
];

let failed = false;
console.log('W1.1 — mute bug on local demuxed fixture (real extension)\n');

for (const s of SCENARIOS) {
  console.log(`▶ [${s.id}] ${s.title}`);
  let r;
  try {
    r = await s.run();
  } catch (e) {
    r = { ok: false, detail: `harness error: ${e?.message ?? e}` };
  }

  if (s.expect === 'pass') {
    if (r.ok) console.log(`  ✓ PASS — ${r.detail}\n`);
    else {
      failed = true;
      console.log(`  ✗ BROKEN — ${r.detail}\n`);
    }
  } else {
    if (!r.ok) {
      console.log(`  ⊘ RED AS EXPECTED (bug still alive, pinned) — ${r.detail}`);
      console.log(`     pinned: ${s.pins}\n`);
    } else {
      failed = true;
      console.log(`  ✗ RATCHET FLIPPED — this case was SUPPOSED to be red but PASSED: ${r.detail}`);
      console.log(`     => ${s.pins} is fixed now. Change expect: 'known-fail' -> 'pass' in e2e/demuxed.mjs.\n`);
    }
  }
}

console.log(failed ? '✗ W1.1 harness FAILED' : '✓ W1.1 harness GREEN (pinned bug still red as expected)');
process.exit(failed ? 1 : 0);
