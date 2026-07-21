// Harness: MUTE BUG (§2.1) on a public DEMUXED stream — this is the project's central question.
//
// WHY NOT USE TWITTER/X: X requires login -> a machine can't run this unattended. But the mute
// bug is NOT an X specialty: it fires on ANY master playlist whose audio stream lives in a
// separate rendition (`#EXT-X-MEDIA:TYPE=AUDIO` + variant with `AUDIO="..."`). Apple's public
// sample stream has EXACTLY that structure (MEASURED 2026-07-17: 3 audio groups `aud1/aud2/aud3`,
// each group with its own URI, plus 1 subtitle group `sub1`) -> a valid substitute for X, no
// account needed at all.
//
// WHY VLC IS NOT NEEDED: `ffprobe` answers "does the output file have an audio track" more
// reliably than a human ear. The W1.1 roadmap acceptance note is "open VLC, listen for audio" —
// a machine can do that, and do it more precisely.
//
// 🔬 SELF-FLIPPING RATCHET: today this case is RED (output file is MUTE = bug §2.1 still alive).
// Once W1.1 is done it will PASS -> the harness flips RED demanding `EXPECT_MUTE` be changed to
// false. Can't be forgotten like a dead TODO.
//
// ✅ STATUS 2026-07-17 — GREEN after W1.1 + W1.3: 38.1MB, 600.0s, 201 segments (100 video +
// 101 audio), track video+audio. This is the project's genuinely hardest real case because it
// combines all THREE things at once: fMP4/CMAF + `#EXT-X-BYTERANGE` + demuxed audio.
//
// HISTORY (don't retread this path): this stream used to die with a terse `FS error` that got
// misnamed "bug #30 — fMP4/CMAF broken". WRONG. The root cause was **byterange** (W1.3): the
// playlist has EVERY segment point at the same 27MB `main.mp4` file, we ignored
// `#EXT-X-BYTERANGE` so we downloaded the full 27MB x 101 times and concatenated ~2.8GB of
// garbage bytes. `concat:` muxes fMP4 completely fine. See PROMPT-THUC-THI.md §2b.
//
// Run: pnpm e2e:demuxed   (needs `pnpm build` first; needs ffprobe). Slow (~30s, downloads a real
// 38MB) — for a FAST, offline mute-bug check use `pnpm e2e:demuxed-fixture`.

import {
  requireBuild,
  withBrowser,
  waitJob,
  waitDownloadedFile,
  probeFile,
} from './lib.mjs';
import { existsSync, statSync } from 'node:fs';

// Public master, NO login needed, demuxed audio + has subtitles (fMP4/CMAF).
const MASTER_URL =
  'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8';

// ✅ 2026-07-17: W1.1 + W1.3 done -> the output file MUST HAVE AUDIO. The ratchet self-flipped
// demanding this flag change. Measured for real on the Apple stream: 38.1MB, 600.0s, 201
// segments, track video+audio [h264, aac].
// From here on this case is a regression safety net on a REAL STREAM (fMP4 + byterange +
// demuxed audio all at once).
const EXPECT_MUTE = false;

const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 600_000);
const DOWNLOAD_FOLDER = `yvim-demuxed-${process.pid}`;

requireBuild();

console.log('Mute bug (§2.1) on a public DEMUXED stream (Apple, fMP4)\n');

const result = await withBrowser(DOWNLOAD_FOLDER, async ({ page, logs }) => {
  const bail = (msg) => ({
    fatal: msg,
    logs: logs.filter((l) => /error|ffmpeg|FS|Error/i.test(l)).slice(-25),
  });
  // --- Step 1: click "Quality" exactly as the popup does ---
  const vres = await page.evaluate(
    (url) => chrome.runtime.sendMessage({ kind: 'manifest/variants', url, mediaType: 'hls' }),
    MASTER_URL,
  );
  if (!vres?.ok) return bail(`manifest/variants broken: ${vres?.error ?? JSON.stringify(vres)}`);
  console.log(`  ✓ Got ${vres.variants.length} qualities`);

  // Pick the SMALLEST variant WITH VIDEO for speed — the mute bug doesn't depend on bitrate.
  // Filter by `height` because Apple's master also has an AUDIO-ONLY variant (HLS Authoring
  // Spec §2.3 requires it): picking that one would give "output has no video", unrelated to
  // the mute bug.
  const variant = [...vres.variants]
    .filter((v) => (v.height ?? 0) > 0)
    .sort((a, b) => (a.height ?? 1e9) - (b.height ?? 1e9) || (a.bandwidth ?? 0) - (b.bandwidth ?? 0))[0];
  const audioUrl = variant.audioRenditions?.find((r) => r.selected)?.uri;
  console.log(`  → downloading variant ${variant.height ?? '?'}p (${variant.bandwidth ?? '?'} bps)`);
  console.log(`  → audio stream: ${audioUrl ?? '(none — audio is inside the variant)'}`);

  // --- Step 2: real download ---
  // MUST send audioUrl exactly as the popup does (W1.1 protocol). Without it the harness would
  // manually reproduce the exact mute bug and then blame the product — a wrong measurement, and
  // worse, wrong in the pessimistic direction.
  const start = await page.evaluate(
    ([variantUrl, mediaUrl, height, aUrl]) =>
      chrome.runtime.sendMessage({
        kind: 'hls/download',
        variantUrl,
        mediaUrl,
        tabId: -1,
        height,
        audioUrl: aUrl,
      }),
    [variant.uri, MASTER_URL, variant.height, audioUrl],
  );
  if (!start?.ok) return bail(`hls/download rejected: ${JSON.stringify(start)}`);

  const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
  if (!job) return bail(`job HUNG after ${JOB_TIMEOUT_MS / 1000}s`);
  if (job.phase !== 'done') return bail(`job ${job.phase}: ${job.error ?? '?'}`);

  // --- Step 3: inspect the output file — DOES IT HAVE AUDIO? ---
  const file = await waitDownloadedFile(page, 60_000);
  if (!file) return bail('job done but NO file landed on disk');
  if (file.state !== 'complete') return bail(`download ${file.state}: ${file.error ?? '?'}`);
  if (!existsSync(file.filename)) return bail(`file does not exist: ${file.filename}`);

  // countFrames: false — this stream is long, counting frames is costly and the question here
  // is about the audio track.
  const probe = probeFile(file.filename, { countFrames: false });
  if (probe.error) return bail(`ffprobe could not read the file: ${probe.error}`);

  return {
    sizeMB: statSync(file.filename).size / 1024 / 1024,
    segments: job.segmentsTotal,
    probe,
  };
});

if (result.fatal) {
  console.log(`\n✗ Could not reach a conclusion: ${result.fatal}`);
  if (result.logs?.length) {
    console.log('\n--- logs from all contexts (including offscreen) ---');
    for (const l of result.logs) console.log(`  ${l}`);
  }
  process.exit(1);
}

const { probe, sizeMB, segments } = result;
console.log(
  `\n  Output file: ${sizeMB.toFixed(1)}MB, ${probe.duration.toFixed(1)}s, ${segments} segments\n` +
    `  Track:   ${probe.codecs.join(' + ') || '(empty)'}  [${probe.codecNames.join(', ')}]\n` +
    `  HAS AUDIO? ${probe.hasAudio ? 'YES' : 'NO — MUTE'}\n`,
);

if (EXPECT_MUTE) {
  if (!probe.hasAudio) {
    console.log('⊘ RED AS EXPECTED — output file is MUTE. Bug §2.1 STILL ALIVE, now measured on a real stream.');
    console.log('   pinned: §2.1 -> W1.1 package (mux demuxed audio stream)');
    console.log('\n✓ Conclusion reached (bug confirmed by a real run)');
    process.exit(0);
  }
  console.log('✗ RATCHET FLIPPED — output file HAS AUDIO, meaning §2.1 has been fixed.');
  console.log('   => Change EXPECT_MUTE to false in e2e/real-demuxed.mjs.');
  process.exit(1);
}

if (probe.hasAudio) {
  console.log('✓ PASS — output file HAS AUDIO. W1.1 works on a real demuxed stream.');
  process.exit(0);
}
console.log('✗ BROKEN — output file is still MUTE even though W1.1 was supposed to be done.');
process.exit(1);
