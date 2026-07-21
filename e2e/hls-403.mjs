// Harness W0.3 — integrated safety net: REAL extension + local fixture server WITH a 403 gate.
//
// WHY THIS IS NEEDED (read carefully before editing):
//   All 193 vitest tests only touch PURE FUNCTIONS. `dnr.test.ts` proves buildRefererSpoofRule()
//   returns the correct object — but CANNOT see that `handleVariants` never calls it. That's the
//   class of bug static gates are completely blind to. This harness measures by RUNNING FOR REAL.
//   e2e/smoke.mjs downloads from a public site and has NO 403 gate -> it proves "the HLS path
//   runs", it proves nothing about anti-hotlink defenses. This file fills that gap.
//
// DIFFERENCE FROM smoke.mjs: offline (local fixture), deterministic, with an observable 403 gate.
//
// 🔬 SELF-ARMING RATCHET (borrows exactly the `it.fails` mechanism from W0.4):
//   A case with `expect: 'known-fail'` pins a KNOWN bug that's still alive. If that case suddenly
//   PASSES (someone finished fixing W2.2/W2.3), the harness turns **RED** with instructions to
//   relabel it to 'pass'. Impossible to forget, unlike a dead TODO.
//
// Run: pnpm e2e:fixture   (needs `pnpm build` first; needs ffprobe for the duration-check part)

import { PLAYER_TOKEN, startFixtureServer, startDemuxedServer } from './fixture-server.mjs';
import {
  requireBuild,
  withBrowser as withBrowserRaw,
  waitJob,
  waitDownloadedFile,
  probeFile,
} from './lib.mjs';
import { existsSync, statSync } from 'node:fs';

const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 120_000);
// fixture = 10 segments x 1s x 10fps (generated with ffmpeg, see e2e/fixtures/hls).
// Count FRAMES, not duration — reason measured empirically, see probeFile() in lib.mjs.
const FIXTURE_FRAMES = 100;
const DOWNLOAD_FOLDER = `yvim-e2e-${process.pid}`;

requireBuild();

const withBrowser = (fn) => withBrowserRaw(DOWNLOAD_FOLDER, fn);

// --- Cases ---------------------------------------------------------------------------------
// Each case returns { ok: boolean, detail: string }. `expect` says whether the case is SUPPOSED
// to pass, or is pinning a known bug.

/** Download the whole stream via hls/download then check the file on disk. */
async function runDownload({ gate, segmentHost }) {
  const srv = await startFixtureServer({ gate, segmentHost });
  try {
    return await withBrowser(async ({ page, logs }) => {
      const start = await page.evaluate(
        ([variantUrl, mediaUrl]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl,
            mediaUrl,
            tabId: -1,
          }),
        [srv.mediaUrl, srv.masterUrl],
      );
      if (!start?.ok) {
        return {
          ok: false,
          detail: `hls/download rejected: ${JSON.stringify(start)}`,
        };
      }
      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (!job) {
        return {
          ok: false,
          detail: `job STUCK after ${JOB_TIMEOUT_MS / 1000}s (neither done nor error)`,
        };
      }
      if (job.phase !== 'done') {
        const b = srv.blocked().length;
        return {
          ok: false,
          detail: `job ${job.phase}: ${job.error ?? '?'}${b ? ` — server blocked ${b} request(s) for missing Referer` : ''}`,
        };
      }
      // INTENDED filename (naming scheme + subfolder) — asserted here because the real on-disk
      // path has been redirected by Playwright, see the note on waitDownloadedFile().
      const wantName = `${DOWNLOAD_FOLDER}/media.mp4`;
      if (job.filename !== wantName) {
        return {
          ok: false,
          detail: `wrong intended filename: "${job.filename}", expected "${wantName}"`,
        };
      }
      const file = await waitDownloadedFile(page, 30_000);
      if (!file)
        return {
          ok: false,
          detail: 'job done but NO file landed on disk',
        };
      if (file.state !== 'complete') {
        return {
          ok: false,
          detail: `download ${file.state}: ${file.error ?? '?'}`,
        };
      }
      if (!existsSync(file.filename)) {
        return {
          ok: false,
          detail: `downloads reports complete but file does not exist: ${file.filename}`,
        };
      }
      const size = statSync(file.filename).size;
      const probe = probeFile(file.filename);
      if (probe.error)
        return {
          ok: false,
          detail: `ffprobe could not read the output file: ${probe.error}`,
        };
      if (!probe.codecs.includes('video')) {
        return {
          ok: false,
          detail: `output file has NO video track (streams: ${probe.codecs.join(',') || 'empty'})`,
        };
      }
      // §2.6: skipping a segment -> MISSING FRAMES (duration stays unchanged — see probeFile).
      // Tolerance ±2 frames: remux -c copy can drift by 1 frame at an edge, but dropping 1 segment
      // means -10 frames.
      if (Math.abs(probe.videoFrames - FIXTURE_FRAMES) > 2) {
        return {
          ok: false,
          detail:
            `missing frames: read ${probe.videoFrames}, expected ${FIXTURE_FRAMES} ` +
            `(dropped segment? duration ${probe.duration.toFixed(2)}s does NOT reflect this bug)`,
        };
      }
      const errLog = logs.filter((l) => l.includes('error:')).slice(-3);
      return {
        ok: true,
        detail:
          `file ${(size / 1024).toFixed(0)}KB, ${probe.duration.toFixed(2)}s, ` +
          `${probe.videoFrames} frames, track: ${probe.codecs.join('+')}` +
          `${errLog.length ? ` (error log: ${errLog.join(' | ')})` : ''}`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W3.1 — download a whole **AES-128 encrypted** HLS stream then check the output file.
 *
 * WHY THIS CASE IS WORTH IT: AES-128 is the only decryption branch §7 allows, yet across THREE
 * sessions no measurement ever touched it — both the 502 unit tests and the 17 e2e cases only ran
 * unencrypted streams. `utils/crypto.test.ts` proves `decryptAes128Cbc()` decrypts correctly, but
 * CANNOT see whether `downloadTrack()` actually calls it with the right key and the right IV —
 * exactly the class of bug static gates are blind to.
 *
 * WHY 100 FRAMES IS STRONG ENOUGH EVIDENCE (for the KEY): the segments here are the EXACT same 10
 * plaintext segments from the `happy` case, encrypted. So the correct path must produce a file
 * that matches that case bit-for-bit. A wrong KEY produces random bytes — MPEG-TS loses sync, and
 * no path can come out to exactly 100 frames.
 *
 * 🔴 BUT NOT FOR THE IV — MEASURED, don't assume the opposite: mutating `seg.seq` to the array
 * index, and mutating to skip `#EXT-X-KEY:IV=`, both leave these cases GREEN. CBC only lets the IV
 * govern the first 16 bytes of each segment: exactly 10/143,444 bytes off, same 100 frames, same
 * video-stream md5, the output .mp4 comes out BYTE-IDENTICAL. The net for IV lives in
 * `utils/crypto.test.ts`, NOT here.
 *
 * ⚠️ Deliberately NOT sharing a body with runDownload(): 17 green cases run through that function,
 * and the debt being paid off here is "missing a net", not "not DRY enough". Merging them would
 * turn every future edit here into a risk for all 17 of those cases.
 */
async function runAesDownload({
  variant,
  gate = 'none',
  wantKeyFetches = 1,
  keyHost = null,
}) {
  const srv = await startFixtureServer({ gate, keyHost });
  try {
    return await withBrowser(async ({ page }) => {
      const start = await page.evaluate(
        ([variantUrl, mediaUrl]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl,
            mediaUrl,
            tabId: -1,
          }),
        [srv.aesUrl(variant), srv.masterUrl],
      );
      if (!start?.ok) {
        return {
          ok: false,
          detail: `hls/download rejected: ${JSON.stringify(start)}`,
        };
      }
      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (!job) return { ok: false, detail: 'job STUCK (neither done nor error)' };
      if (job.phase !== 'done') {
        const b = srv.blocked().length;
        return {
          ok: false,
          detail:
            `job ${job.phase}: ${job.error ?? '?'}` +
            `${b ? ` — server blocked ${b} request(s) for missing Referer` : ''}`,
        };
      }
      const file = await waitDownloadedFile(page, 30_000);
      if (!file)
        return { ok: false, detail: 'job done but NO file on disk' };
      if (file.state !== 'complete')
        return {
          ok: false,
          detail: `download ${file.state}: ${file.error ?? '?'}`,
        };
      if (!existsSync(file.filename))
        return {
          ok: false,
          detail: `downloads reports complete but file does not exist: ${file.filename}`,
        };

      // GATE NUMBER ONE: was the key fetched EXACTLY the right number of times.
      //   TOO FEW  -> the playlist wasn't recognized as encrypted, or the second key cluster got
      //               painted with the first key.
      //   TOO MANY -> the key cache leaks, each segment goes and asks for the key again (CDNs or
      //               rate limits on exactly this endpoint make the extra request a real risk, not
      //               just a cosmetic issue).
      // Pinned to EXACTLY, not >=: this number is DETERMINISTIC after the cache-promise fix
      // (measured — before the fix it ran 3-5 and changed on every run, the exact signature of a
      // leaky cache).
      const keyHits = srv.aesKeyHits();
      if (keyHits !== wantKeyFetches) {
        return {
          ok: false,
          detail:
            `${keyHits} AES key fetch(es), expected EXACTLY ${wantKeyFetches} ` +
            (keyHits < wantKeyFetches
              ? '-> missing key: decryption branch did not run, or the first key got painted over the whole stream'
              : '-> leaky key cache: each segment goes and asks for the key again'),
        };
      }

      const size = statSync(file.filename).size;
      const probe = probeFile(file.filename);
      if (probe.error) {
        return {
          ok: false,
          detail:
            `ffprobe could not read the output file: ${probe.error} ` +
            '-> most likely WRONG decryption (garbage bytes still get written to the file)',
        };
      }
      if (!probe.codecs.includes('video')) {
        return {
          ok: false,
          detail:
            `output file has NO video track (streams: ${probe.codecs.join(',') || 'empty'}) ` +
            '-> wrong decryption broke MPEG-TS sync',
        };
      }
      if (Math.abs(probe.videoFrames - FIXTURE_FRAMES) > 2) {
        return {
          ok: false,
          detail:
            `missing frames: read ${probe.videoFrames}, expected ${FIXTURE_FRAMES} ` +
            '-> SOME segments decrypted wrong (wrong IV/wrong key for the second cluster), the rest ' +
            'still came out right so the file still opens — this is exactly the SILENT-corruption kind',
        };
      }
      return {
        ok: true,
        detail:
          `file ${(size / 1024).toFixed(0)}KB, ${probe.duration.toFixed(2)}s, ` +
          `${probe.videoFrames} frames, ${keyHits} key fetch(es), track: ${probe.codecs.join('+')}`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W3.1 — a BROKEN AES key must produce an error that CAN BE PUT INTO WORDS.
 *
 * 🔴 MEASURED (2026-07-19) on the exact version currently running: give it a wrong key -> the job
 * ends with `phase: 'error'` and **`error: ""`** — an EMPTY string. The popup shows a blank red
 * line. Root cause: WebCrypto throws `DOMException(OperationError)` whose `message` is empty in
 * Chromium, and the error path just forwards `e.message`.
 *
 * This is exactly the kind of failure the project forbids: broken but SAYING NOTHING. The user
 * cannot tell "wrong key" from "lost connection" from "disk full". This case requires the message
 * to MENTION the key/decryption.
 *
 * Two variants because they throw from two DIFFERENT paths, don't merge them:
 *   `bad`    key is exactly 16 bytes but the VALUE is wrong -> throws at the padding-removal step
 *            (decrypt).
 *   `badlen` server returns an HTML page instead of the key -> throws at the LENGTH GUARD inside
 *            `decryptSegment`, BEFORE `importKey` is even called. That guard isn't redundant:
 *            without it the user gets the English string "AES key data must be 128 or 256 bits"
 *            instead of a readable message.
 */
async function runAesBadKey({ variant, wantMessage }) {
  const srv = await startFixtureServer({ gate: 'none' });
  try {
    return await withBrowser(async ({ page }) => {
      const start = await page.evaluate(
        ([variantUrl, mediaUrl]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl,
            mediaUrl,
            tabId: -1,
          }),
        [srv.aesUrl(variant), srv.masterUrl],
      );
      if (!start?.ok) {
        return {
          ok: false,
          detail: `hls/download rejected: ${JSON.stringify(start)}`,
        };
      }
      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (!job) return { ok: false, detail: 'job STUCK (neither done nor error)' };

      // Delivering the file with a wrong key is WORSE than reporting an error: the user gets a
      // garbage .mp4 with a green checkmark.
      if (job.phase !== 'error') {
        return {
          ok: false,
          detail:
            `wrong key but the job ended '${job.phase}' — it should have been 'error'. ` +
            'Handing over a garbage file with a green checkmark is worse than reporting an error.',
        };
      }
      const msg = String(job.error ?? '');
      if (!msg.trim()) {
        return {
          ok: false,
          detail:
            'job errored but the MESSAGE IS EMPTY — the popup shows a blank red line, the user ' +
            'cannot tell wrong key / lost connection / disk full apart (WebCrypto OperationError has ' +
            'an empty message)',
        };
      }
      // Keep this regex verbatim: it checks the ACTUAL runtime error message produced by the
      // extension (still Vietnamese), not test-file narration.
      if (!/khoá|giải mã/i.test(msg)) {
        return {
          ok: false,
          detail: `message doesn't mention key/decryption, so it's meaningless to the user: "${msg}"`,
        };
      }
      // A SEPARATE assertion per variant. If both only required /khoá|giải mã/ then the shared
      // wrapper sentence would already satisfy it, and the "key must be exactly 16 bytes" guard
      // could be deleted with nobody noticing (measured: removing the guard -> case stays green
      // because the importKey error falls into that same wrapper sentence).
      if (wantMessage && !wantMessage.test(msg)) {
        return {
          ok: false,
          detail:
            `message doesn't state the correct CAUSE for this case (${wantMessage}): "${msg}"`,
        };
      }
      // Guard against handing over a garbage file: reporting an error but still dropping a file to
      // disk still leaves the user with a broken .mp4.
      const file = await waitDownloadedFile(page, 3_000);
      if (file) {
        return {
          ok: false,
          detail: `reported the error CORRECTLY but still delivered a file to disk: ${file.filename}`,
        };
      }
      return { ok: true, detail: `clear error message: "${msg}"` };
    });
  } finally {
    await srv.close();
  }
}

/**
 * PACKAGE A — HLS **fMP4/CMAF** (`#EXT-X-MAP`), with/without AES-128 encryption.
 *
 * WHY THIS CASE EXISTS: the 2026-07-20 session patched "the init segment doesn't get decrypted"
 * per RFC 8216 §4.3.2.5, but **no measurement ever exercised that patch** — every existing AES
 * case is MPEG-TS, and TS has no `#EXT-X-MAP`, so the init branch never gets touched. This is the
 * clearest remaining debt of W3.1.
 *
 * 🔬 WHY fMP4 HAS TEETH WHILE TS DOESN'T — this is the core point, measured with node: the first
 * 16 bytes of the init (after decryption) are `0000001c 66747970 69736f35 00000200`, i.e. the
 * `ftyp` box. AES-CBC lets the IV govern EXACTLY the first 16-byte block — on TS those 16 bytes
 * are just one TS packet and ffmpeg resyncs on its own (measured: drift of 10/143,444 bytes, the
 * output .mp4 comes out BYTE-IDENTICAL). On fMP4, those 16 bytes are the magic + box size, and
 * corrupting them means libav simply doesn't recognize the format.
 * => THIS is the only spot in the whole e2e suite where an init/IV layer bug becomes OBSERVABLE.
 *
 * `wantKeyHits` is a gate INDEPENDENT of file content: 0 for the unencrypted variant (guards
 * against "decrypting when it shouldn't"), exactly 1 per track for the encrypted variant (guards
 * against a leaky key cache).
 */
async function runFmp4Download({
  variant,
  demuxed = false,
  wantKeyHits = 0,
  wantAudio = false,
}) {
  const srv = await startFixtureServer({ gate: 'none' });
  try {
    return await withBrowser(async ({ page }) => {
      // The demuxed-audio variant walks the ENTIRE popup path (master -> variant -> audioUrl),
      // because parsing the master is exactly where the audio stream tends to vanish (lesson from
      // W1.1).
      let variantUrl = srv.fmp4Url(variant, 'v');
      let audioUrl;
      const mediaUrl = demuxed
        ? srv.fmp4MasterUrl(variant)
        : srv.fmp4Url(variant, 'v');
      if (demuxed) {
        const vres = await page.evaluate(
          (url) =>
            chrome.runtime.sendMessage({
              kind: 'manifest/variants',
              url,
              mediaType: 'hls',
            }),
          mediaUrl,
        );
        if (!vres?.ok) {
          return {
            ok: false,
            detail: `manifest/variants broken: ${JSON.stringify(vres)}`,
          };
        }
        const v = vres.variants?.[0];
        if (!v) return { ok: false, detail: 'fMP4 master produced no variant' };
        variantUrl = v.uri;
        audioUrl = v.audioRenditions?.find((r) => r.selected)?.uri;
        if (!audioUrl) {
          return {
            ok: false,
            detail:
              'master declares #EXT-X-MEDIA:TYPE=AUDIO but the variant carries no audio rendition ' +
              '-> the job will run single-input and the output file will be MUTE',
          };
        }
      }

      const start = await page.evaluate(
        ([vUrl, aUrl, mUrl]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl: vUrl,
            ...(aUrl ? { audioUrl: aUrl } : {}),
            mediaUrl: mUrl,
            tabId: -1,
          }),
        [variantUrl, audioUrl ?? null, mediaUrl],
      );
      if (!start?.ok) {
        return {
          ok: false,
          detail: `hls/download rejected: ${JSON.stringify(start)}`,
        };
      }
      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (!job) return { ok: false, detail: 'job STUCK (neither done nor error)' };
      if (job.phase !== 'done') {
        // The diagnosis must match the variant actually running. The sentence "init did not get
        // decrypted" pasted onto the UNENCRYPTED variant would itself be a false claim — exactly
        // what the project's rules call a bug (measured: mutating away #EXT-X-MAP makes the
        // `plain` case fail with this wrong diagnosis attached).
        const hint = wantKeyHits
          ? 'the init (#EXT-X-MAP) most likely did NOT get decrypted: ciphertext sits right where ' +
            'ftyp/moov should be so libav does not recognize the format'
          : 'stream is NOT encrypted yet still broke -> the init (#EXT-X-MAP) is most likely being ' +
            'skipped or written to the wrong position (init must come BEFORE the first segment)';
        return {
          ok: false,
          detail: `job ${job.phase}: ${job.error ?? '?'} -> ${hint}`,
        };
      }

      // Gate 1: was the init actually fetched. A build that skips #EXT-X-MAP produces a file
      // missing its header — and for fMP4, a missing header means the ENTIRE track description is
      // gone, not just an edge-case glitch.
      const initHits = srv.fmp4InitHits();
      if (initHits < (demuxed ? 2 : 1)) {
        return {
          ok: false,
          detail: `only ${initHits} init (#EXT-X-MAP) fetch(es) — init branch did not run`,
        };
      }
      // Gate 2: number of key fetches. 0 = no unnecessary decryption on a clean stream; exactly N
      // = healthy key cache.
      const keyHits = srv.fmp4KeyHits();
      if (keyHits !== wantKeyHits) {
        return {
          ok: false,
          detail:
            `${keyHits} AES key fetch(es), expected EXACTLY ${wantKeyHits}` +
            (wantKeyHits === 0
              ? ' -> stream is NOT encrypted but keys were still requested: unnecessary decryption'
              : keyHits < wantKeyHits
                ? ' -> missing key: some track did not get decrypted (or got painted with the other track\'s key)'
                : ' -> leaky key cache'),
        };
      }
      if (demuxed) {
        // Pin the "each track has its OWN separate #EXT-X-KEY" branch: two DIFFERENT keys, exactly
        // 1 fetch each.
        const kv = srv.fmp4KeyHits('v');
        const ka = srv.fmp4KeyHits('a');
        if (kv !== 1 || ka !== 1) {
          return {
            ok: false,
            detail: `video key ${kv} fetch(es) / audio key ${ka} fetch(es) — each side must be EXACTLY 1`,
          };
        }
      }

      const file = await waitDownloadedFile(page, 30_000);
      if (!file)
        return { ok: false, detail: 'job done but NO file on disk' };
      if (file.state !== 'complete')
        return {
          ok: false,
          detail: `download ${file.state}: ${file.error ?? '?'}`,
        };
      if (!existsSync(file.filename))
        return {
          ok: false,
          detail: `downloads reports complete but file does not exist: ${file.filename}`,
        };
      const size = statSync(file.filename).size;
      const probe = probeFile(file.filename);
      if (probe.error) {
        return {
          ok: false,
          detail:
            `ffprobe could not read the output file: ${probe.error} ` +
            '-> a broken init wipes out every track description, the file is just a pile of bytes',
        };
      }
      if (!probe.codecs.includes('video')) {
        return {
          ok: false,
          detail: `output file has NO video track (streams: ${probe.codecs.join(',') || 'empty'})`,
        };
      }
      if (wantAudio && !probe.codecs.includes('audio')) {
        return {
          ok: false,
          detail:
            `output file has NO audio track (streams: ${probe.codecs.join(',')}) ` +
            '-> the audio stream with its OWN separate key got dropped',
        };
      }
      if (Math.abs(probe.videoFrames - FIXTURE_FRAMES) > 2) {
        return {
          ok: false,
          detail:
            `missing frames: read ${probe.videoFrames}, expected ${FIXTURE_FRAMES} ` +
            '-> dropped a .m4s segment, or part of it decrypted wrong',
        };
      }
      return {
        ok: true,
        detail:
          `file ${(size / 1024).toFixed(0)}KB, ${probe.duration.toFixed(2)}s, ` +
          `${probe.videoFrames} frames, ${initHits} init fetch(es), ${keyHits} key fetch(es), ` +
          `track: ${probe.codecs.join('+')}`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * §7 — A DRM-DECLARING PLAYLIST MUST BE REFUSED, AND NOT EVEN A SINGLE SEGMENT MAY BE FETCHED.
 *
 * 🔴 REAL VULNERABILITY MEASURED 2026-07-19 (before the fix): FairPlay/PlayReady/Widevine all
 * produced `isProtected=false` because m3u8-parser swallows `segment.key` whenever KEYFORMAT isn't
 * identity. The §7 hard boundary — what CLAUDE.md calls "DO NOT CROSS" — was breached, and by
 * exactly the three most common DRM systems.
 *
 * This case pins TWO things, and the second one is the hard part:
 *   1. the job must end in `error` with a message that NAMES THE VENDOR (the user needs to know
 *      why, not just an empty "unsupported" sentence).
 *   2. the server must serve ZERO segments. Checking only the message would let a build that
 *      "downloads first, refuses afterward" pass — but downloading protected content to disk is
 *      EXACTLY what §7 forbids.
 */
async function runDrmPlaylistRefused({ system, wantName }) {
  const srv = await startFixtureServer({ gate: 'none' });
  try {
    return await withBrowser(async ({ page }) => {
      const start = await page.evaluate(
        ([variantUrl, mediaUrl]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl,
            mediaUrl,
            tabId: -1,
          }),
        [srv.drmUrl(system), srv.masterUrl],
      );
      // Refusing right at the door is also valid — as long as there's a clear reason.
      if (!start?.ok) {
        const msg = String(start?.error ?? '');
        if (!/bảo vệ|DRM/i.test(msg)) {
          return {
            ok: false,
            detail: `rejected but without a DRM reason: ${JSON.stringify(start)}`,
          };
        }
        return { ok: true, detail: `rejected right at the door: "${msg}"` };
      }
      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (!job) return { ok: false, detail: 'job STUCK (neither done nor error)' };
      if (job.phase !== 'error') {
        return {
          ok: false,
          detail:
            `§7 BOUNDARY BREACHED: job ended '${job.phase}' on a ${system} playlist. ` +
            'The extension just downloaded protected content and handed over a file with a green checkmark.',
        };
      }
      const msg = String(job.error ?? '');
      // Keep this regex verbatim: it checks the ACTUAL runtime error message (still Vietnamese).
      if (!/bảo vệ|DRM/i.test(msg)) {
        return {
          ok: false,
          detail: `job errored but doesn't say the content is protected: "${msg}"`,
        };
      }
      if (wantName && !msg.includes(wantName)) {
        return {
          ok: false,
          detail: `message doesn't name the vendor "${wantName}": "${msg}"`,
        };
      }
      // The REALLY hard gate: was any content byte fetched at all.
      const hits = srv.plainSegmentHits();
      if (hits > 0) {
        return {
          ok: false,
          detail:
            `error reported CORRECTLY but ${hits} protected content segment(s) were already fetched ` +
            '-> still crosses the §7 boundary, just apologizes after the fact',
        };
      }
      return { ok: true, detail: `correctly refused, 0 segments fetched: "${msg}"` };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W2.6 — server ACCEPTS a segment request then goes completely silent (simulates the network
 * dying mid-transfer).
 *
 * Criterion: the job must end in `error` WITHIN A BOUNDED TIME. Before W2.6, `fetch` had no signal
 * at all -> the promise never settled -> the job got stuck in 'fetching' forever (§2.9, failure
 * mode 1) and this case would hang for the entire JOB_TIMEOUT_MS. Post-W2.6 arithmetic: 4 attempts
 * x 15s + 3.5s backoff = ~63s.
 */
async function runSegmentStall() {
  const srv = await startFixtureServer({ gate: 'none', stallSegments: true });
  const budgetMs = 100_000;
  try {
    return await withBrowser(async ({ page }) => {
      const start = await page.evaluate(
        ([variantUrl, mediaUrl]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl,
            mediaUrl,
            tabId: -1,
          }),
        [srv.mediaUrl, srv.masterUrl],
      );
      if (!start?.ok) {
        return {
          ok: false,
          detail: `hls/download rejected: ${JSON.stringify(start)}`,
        };
      }
      const t0 = Date.now();
      const job = await waitJob(page, start.jobId, budgetMs);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (!job) {
        return {
          ok: false,
          detail: `job STUCK >${budgetMs / 1000}s on a silent server — exactly the §2.9 disease (no timeout)`,
        };
      }
      if (job.phase !== 'error') {
        return {
          ok: false,
          detail: `expected phase 'error', got '${job.phase}' after ${secs}s`,
        };
      }
      return {
        ok: true,
        detail: `job reported an error after ${secs}s (did not hang): "${job.error ?? '?'}"`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W2.7 — KILL offscreen mid-download: the job must report an error within a bounded time, not
 * spin forever.
 *
 * Why this case catches something static gates are blind to: offscreen dies SILENTLY — Chrome
 * fires no event to background at all. Without the W2.7 tick, the job stays in 'fetching' until
 * the browser closes, and NO pure test can see it, because the bug lives in "nobody reports it",
 * not in any single function.
 *
 * Uses `stallSegments` to hold the job still in 'fetching' (deterministic), then calls
 * `closeDocument()` to kill offscreen — exactly what Chrome's Task Manager does. Note: killing
 * offscreen also kills the W2.6 retry timer living inside it, so the background tick is the ONLY
 * thing left that can save the job.
 *
 * Budget: 60s silence threshold + up to 30s alarm cycle (Chrome won't allow tighter) => worst case
 * ~90s.
 */
async function runOffscreenDeath() {
  const srv = await startFixtureServer({ gate: 'none', stallSegments: true });
  const budgetMs = 150_000;
  try {
    return await withBrowser(async ({ page }) => {
      const start = await page.evaluate(
        ([variantUrl, mediaUrl]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl,
            mediaUrl,
            tabId: -1,
          }),
        [srv.mediaUrl, srv.masterUrl],
      );
      if (!start?.ok) {
        return {
          ok: false,
          detail: `hls/download rejected: ${JSON.stringify(start)}`,
        };
      }
      // Wait until the job is truly in 'fetching' before killing it — killing too early would
      // measure the wrong thing ("hasn't picked up the job yet").
      let reached = false;
      for (let i = 0; i < 40; i++) {
        const phase = await page.evaluate(async (id) => {
          const all = await chrome.storage.session.get('hlsjobs');
          return all.hlsjobs?.[id]?.phase ?? null;
        }, start.jobId);
        if (phase === 'fetching') {
          reached = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!reached)
        return {
          ok: false,
          detail: 'job never reached the fetching phase so offscreen could be killed',
        };

      const killed = await page.evaluate(async () => {
        try {
          await chrome.offscreen.closeDocument();
          return true;
        } catch (e) {
          return String(e?.message ?? e);
        }
      });
      if (killed !== true)
        return { ok: false, detail: `could not kill offscreen: ${killed}` };
      console.log('      [kill] offscreen was closed — the heartbeat stops from here');

      const t0 = Date.now();
      const job = await waitJob(page, start.jobId, budgetMs);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (!job) {
        return {
          ok: false,
          detail: `job STUCK >${budgetMs / 1000}s after offscreen died — spinner spins forever (§2.14)`,
        };
      }
      if (job.phase !== 'error') {
        return {
          ok: false,
          detail: `expected phase 'error', got '${job.phase}' after ${secs}s`,
        };
      }
      // The message must state EXACTLY what happened: "the processor stopped unexpectedly", not a
      // generic network error.
      if (!/dừng đột ngột/.test(job.error ?? '')) {
        return {
          ok: false,
          detail: `reported an error after ${secs}s but with the WRONG reason: "${job.error ?? '?'}"`,
        };
      }
      return {
        ok: true,
        detail: `job reported an error after ${secs}s, correct reason: "${job.error}"`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W7.1 — §7 HARD BOUNDARY: a page requesting DRM/EME must have the download REFUSED, with a clear
 * reason.
 *
 * Why this case catches something static gates are blind to: before W7.1, `CLAUDE.md` DECLARED
 * this boundary while grepping for `requestMediaKeySystemAccess` returned 0 hits — the declaration
 * had nothing enforcing it. No pure test can detect "a promised feature that doesn't exist"; only
 * running for real can.
 *
 * 🔴 This case downloads NO DRM content. It only opens a page that CALLS the EME API and checks
 * whether the extension refuses — it measures the LOCK, not how to pick it.
 */
async function runDrmRefused() {
  const srv = await startFixtureServer({ gate: 'none' });
  try {
    return await withBrowser(async ({ page }) => {
      // Open the DRM page in a REAL tab (needs a real tabId for the DRM flag to attach in the
      // right place).
      const tabId = await page.evaluate(async (url) => {
        const t = await chrome.tabs.create({ url, active: false });
        return t.id;
      }, srv.drmPageUrl);
      if (typeof tabId !== 'number') {
        return { ok: false, detail: 'could not open the DRM page tab' };
      }

      // Wait for the content script to catch the EME call and report it back to background.
      let systems = [];
      for (let i = 0; i < 40; i++) {
        systems = await page.evaluate(async (id) => {
          const all = await chrome.storage.session.get(`media:${id}`);
          return all[`media:${id}`]?.drmSystems ?? [];
        }, tabId);
        if (systems.length > 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (systems.length === 0) {
        return {
          ok: false,
          detail:
            'DRM was NOT detected — the §7 boundary is still just words on paper',
        };
      }
      if (!systems.includes('Widevine')) {
        return {
          ok: false,
          detail: `DRM detected but with the wrong name: ${JSON.stringify(systems)}`,
        };
      }

      // Door 1: HLS. Must be refused, with a readable reason.
      const hls = await page.evaluate(
        ([v, m, id]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl: v,
            mediaUrl: m,
            tabId: id,
          }),
        [srv.mediaUrl, srv.masterUrl, tabId],
      );
      if (hls?.ok !== false) {
        return {
          ok: false,
          detail: `hls/download was NOT blocked on the DRM tab: ${JSON.stringify(hls)}`,
        };
      }
      if (!/DRM/i.test(hls.error ?? '')) {
        return {
          ok: false,
          detail: `blocked, but the reason doesn't mention DRM: "${hls.error}"`,
        };
      }

      // Door 2: progressive. Same boundary, must be sealed too — no leaving a bypass open.
      const prog = await page.evaluate(
        ([url, id]) =>
          chrome.runtime.sendMessage({
            kind: 'download/progressive',
            url,
            tabId: id,
          }),
        [srv.progressiveUrl, tabId],
      );
      if (prog?.ok !== false) {
        return {
          ok: false,
          detail: `download/progressive was NOT blocked — boundary has a bypass: ${JSON.stringify(prog)}`,
        };
      }

      // Door 3: a CLEAN tab must still be able to download — blocking it wrongly is worse than
      // missing a real case.
      const clean = await page.evaluate(
        ([v, m]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl: v,
            mediaUrl: m,
            tabId: -1,
          }),
        [srv.mediaUrl, srv.masterUrl],
      );
      if (clean?.ok !== true) {
        return {
          ok: false,
          detail: `a CLEAN tab was blocked WRONGLY: ${JSON.stringify(clean)}`,
        };
      }

      return {
        ok: true,
        detail: `detected ${systems.join(', ')}; blocked both HLS and progressive, clean tab still downloads — "${hls.error}"`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W2.7 — downloading PROGRESSIVE (.mp4) also needs a liveness net, not just HLS.
 *
 * W2.5 routed .mp4 through offscreen so it can carry the Referer spoof. A side effect few noticed:
 * from then on, a progressive download DEPENDS on offscreen just like HLS. If offscreen dies
 * mid-fetch ⇒ its `finally` block never runs ⇒ no `download/progress` 'interrupted' state is ever
 * sent ⇒ the entry stays `in_progress` FOREVER, popup spins forever. Worse: `sweepStaleSpoofRules`
 * treats 'in_progress' as still alive, so its spoof rule gets pinned for the whole session.
 */
async function runProgressiveOffscreenDeath() {
  const srv = await startFixtureServer({ gate: 'none', stallSegments: true });
  const budgetMs = 150_000;
  try {
    return await withBrowser(async ({ page }) => {
      const start = await page.evaluate(
        (url) =>
          chrome.runtime.sendMessage({
            kind: 'download/progressive',
            url,
            tabId: -1,
          }),
        srv.stallProgressiveUrl ?? srv.progressiveUrl,
      );
      if (!start?.ok) {
        return {
          ok: false,
          detail: `download/progressive rejected: ${JSON.stringify(start)}`,
        };
      }
      // Wait until the entry is truly 'in_progress' before killing offscreen.
      let ready = false;
      for (let i = 0; i < 40; i++) {
        const st = await page.evaluate(async (key) => {
          const all = await chrome.storage.session.get('downloads');
          return all.downloads?.[key]?.state ?? null;
        }, start.key);
        if (st === 'in_progress') {
          ready = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!ready)
        return {
          ok: false,
          detail: 'entry never reached in_progress so offscreen could be killed',
        };

      const killed = await page.evaluate(async () => {
        try {
          await chrome.offscreen.closeDocument();
          return true;
        } catch (e) {
          return String(e?.message ?? e);
        }
      });
      if (killed !== true)
        return { ok: false, detail: `could not kill offscreen: ${killed}` };
      console.log('      [kill] offscreen was closed mid .mp4 fetch');

      const t0 = Date.now();
      while (Date.now() - t0 < budgetMs) {
        const entry = await page.evaluate(async (key) => {
          const all = await chrome.storage.session.get('downloads');
          return all.downloads?.[key] ?? null;
        }, start.key);
        if (entry && entry.state !== 'in_progress') {
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          if (entry.state !== 'interrupted') {
            return {
              ok: false,
              detail: `expected 'interrupted', got '${entry.state}' after ${secs}s`,
            };
          }
          if (!/dừng đột ngột/.test(entry.error ?? '')) {
            return {
              ok: false,
              detail: `settled after ${secs}s but with the WRONG reason: "${entry.error ?? '?'}"`,
            };
          }
          return {
            ok: true,
            detail: `entry settled 'interrupted' after ${secs}s, correct reason: "${entry.error}"`,
          };
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return {
        ok: false,
        detail: `entry STUCK 'in_progress' >${budgetMs / 1000}s after offscreen died — spinner spins forever`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W2.7 — a QUEUED job must NOT be wrongly reaped as "dead".
 *
 * Why this case exists: HLS jobs run SEQUENTIALLY (one ffmpeg instance). Job #2 sits idle in the
 * queue for the entire time job #1 is downloading — and job #1 taking a few minutes is normal. If
 * the heartbeat only beats while a job is ACTUALLY RUNNING, job #2 stays silent >60s and gets
 * wrongly killed by the W2.7 tick, even though offscreen is perfectly healthy.
 *
 * 👉 Wrongly killing a healthy download is WORSE than the hang that W2.7 was created to fix. This
 * case guards exactly that boundary: job #1 stalls for 63s (long enough to cross the 60s
 * threshold), job #2 must survive.
 */
async function runQueuedJobNotReaped() {
  const srv = await startFixtureServer({ gate: 'none', stallSegments: true });
  try {
    return await withBrowser(async ({ page }) => {
      const startJob = (variantUrl, mediaUrl) =>
        page.evaluate(
          ([v, m]) =>
            chrome.runtime.sendMessage({
              kind: 'hls/download',
              variantUrl: v,
              mediaUrl: m,
              tabId: -1,
            }),
          [variantUrl, mediaUrl],
        );
      const a = await startJob(srv.mediaUrl, srv.masterUrl);
      const b = await startJob(srv.mediaUrl, srv.masterUrl);
      if (!a?.ok || !b?.ok) {
        return {
          ok: false,
          detail: `could not queue 2 jobs: ${JSON.stringify({ a, b })}`,
        };
      }
      // Job #2 is queued behind job #1 (which is stalling for 63s). Watch it cross the 60s
      // threshold — the mark the tick will be checking against.
      const deadline = Date.now() + 75_000;
      while (Date.now() < deadline) {
        const job = await page.evaluate(async (id) => {
          const all = await chrome.storage.session.get('hlsjobs');
          return all.hlsjobs?.[id] ?? null;
        }, b.jobId);
        if (job && /dừng đột ngột/.test(job.error ?? '')) {
          const secs = ((75_000 - (deadline - Date.now())) / 1000).toFixed(1);
          return {
            ok: false,
            detail: `QUEUED job was WRONGLY killed after ${secs}s even though offscreen is still alive: "${job.error}"`,
          };
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return {
        ok: true,
        detail: 'queued job survived the 60s mark — not wrongly killed by the tick',
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W2.5 — download progressive .mp4 via `download/progressive` then check the file on disk.
 *
 * A signal INDEPENDENT OF THE PATH (old direct vs new via-offscreen): did the SERVER ever 403, and
 * did it serve mp4 bytes. The old path (chrome.downloads.download directly) does NOT get the
 * Referer spoof -> server 403s -> hits=0 (MEASURED 2026-07-18). The new path (offscreen fetch)
 * carries the Referer spoof because the extension's own fetch is a tab-less xmlhttprequest ->
 * matches the DNR rule -> server serves 200/206.
 */
async function runProgressive({ gate }) {
  const srv = await startFixtureServer({ gate });
  try {
    return await withBrowser(async ({ page, logs }) => {
      const start = await page.evaluate(
        (url) =>
          chrome.runtime.sendMessage({
            kind: 'download/progressive',
            url,
            tabId: -1,
          }),
        srv.progressiveUrl,
      );
      if (!start?.ok) {
        return {
          ok: false,
          detail: `download/progressive rejected: ${JSON.stringify(start)}`,
        };
      }
      const file = await waitDownloadedFile(page, 30_000);
      // The extension's DownloadEntry (what the popup DISPLAYS) MUST reach 'complete' — this also
      // catches the "tiny blob completes before onChanged matches the entry" race, which
      // chrome.downloads state alone doesn't expose.
      let entryState = null;
      for (let i = 0; i < 20; i++) {
        entryState = await page.evaluate(async (key) => {
          const all = await chrome.storage.session.get('downloads');
          return all.downloads?.[key]?.state ?? null;
        }, start.key);
        if (entryState && entryState !== 'in_progress') break;
        await new Promise((r) => setTimeout(r, 300));
      }
      if (entryState !== 'complete') {
        return {
          ok: false,
          detail: `DownloadEntry stuck at "${entryState}" (popup will show the wrong state)`,
        };
      }
      const blocked = srv.blocked().length;
      const hits = srv.progressiveHits();
      // The gate passes only if the server never 403'd and did serve bytes = the spoof applied to
      // the actual download fetch.
      if (blocked > 0 || hits === 0) {
        return {
          ok: false,
          detail: `server blocked ${blocked} request(s) with 403 (missing Referer), served mp4 ${hits} time(s) — spoof did NOT apply to the download path`,
        };
      }
      if (!file)
        return { ok: false, detail: 'no file landed on disk' };
      if (file.state !== 'complete') {
        return {
          ok: false,
          detail: `download ${file.state}: ${file.error ?? '?'}`,
        };
      }
      if (!existsSync(file.filename)) {
        return {
          ok: false,
          detail: `downloads reports complete but file does not exist: ${file.filename}`,
        };
      }
      const size = statSync(file.filename).size;
      const probe = probeFile(file.filename);
      if (probe.error)
        return {
          ok: false,
          detail: `ffprobe could not read the file: ${probe.error}`,
        };
      if (!probe.codecs.includes('video')) {
        return {
          ok: false,
          detail: `output file has NO video track (streams: ${probe.codecs.join(',') || 'empty'})`,
        };
      }
      const errLog = logs.filter((l) => l.includes('error:')).slice(-3);
      return {
        ok: true,
        detail:
          `file ${size}B, ${probe.videoFrames} frames, track: ${probe.codecs.join('+')}, ` +
          `server served it ${hits} time(s), 0 403s` +
          `${errLog.length ? ` (error log: ${errLog.join(' | ')})` : ''}`,
      };
    });
  } finally {
    await srv.close();
  }
}

/** Just click "Quality" (manifest/variants) — the exact FIRST fetch of the flow. */
async function runVariants({ gate }) {
  const srv = await startFixtureServer({ gate });
  try {
    return await withBrowser(async ({ page }) => {
      const res = await page.evaluate(
        (url) =>
          chrome.runtime.sendMessage({
            kind: 'manifest/variants',
            url,
            mediaType: 'hls',
          }),
        srv.masterUrl,
      );
      if (res?.ok) {
        return { ok: true, detail: `produced ${res.variants.length} quality option(s)` };
      }
      const b = srv.blocked().length;
      return {
        ok: false,
        detail: `${res?.error ?? JSON.stringify(res)}${b ? ` — server blocked ${b} request(s) for missing Referer` : ''}`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W2.1 — CAPTURE & REPLAY the player's REAL headers, instead of FABRICATING Referer/Origin (§2.11).
 *
 * WHY THIS IS THE ONLY CASE THAT PROVES W2.1: the plain `Referer` gate used by earlier cases can
 * also be passed by a FABRICATED value — Referer can just be derived from `pageUrl`. Here the
 * server demands `X-Playback-Session-Id: <a random token generated by the page>`. That token
 * CANNOT be derived from the URL, the host, or pageUrl; the ONLY way for the extension to get it is
 * to listen on `onSendHeaders` while the page's player fetches the manifest, then replay it via
 * DNR. A FABRICATED value fails this gate 100% of the time.
 *
 * Sequence: open the player page (the player itself fetches the manifest carrying the token) ->
 * extension captures the header -> user clicks download -> every extension request must carry the
 * token to get past the 403.
 */
async function runRealHeaderReplay() {
  const srv = await startFixtureServer({ tokenGate: true });
  try {
    return await withBrowser(async ({ page }) => {
      // Step 1: the real player page runs in its OWN TAB (don't touch `page` — that's the
      // extension page, the only place that can read chrome.storage), fires a request with a
      // token -> the extension observes it.
      const playerTab = await page.context().newPage();
      await playerTab.goto(srv.playerPageUrl);
      const played = await playerTab.evaluate(() => window.__played);
      if (!played) {
        return {
          ok: false,
          detail: 'harness broken: the page player could not fetch the manifest',
        };
      }
      // Step 2: wait for background to finish writing the captured headers snapshot to
      // storage.session. The `media:<tabId>` key already carries the player's tabId -> no need to
      // guess with chrome.tabs.query.
      const found = await page.evaluate(async (masterUrl) => {
        for (let i = 0; i < 40; i++) {
          const all = await chrome.storage.session.get(null);
          for (const [k, v] of Object.entries(all)) {
            if (!k.startsWith('media:')) continue;
            const hit = (v?.items ?? []).find((m) => m.url === masterUrl);
            if (hit?.sentHeaders) {
              return { headers: hit.sentHeaders, tabId: Number(k.slice(6)) };
            }
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        return null;
      }, srv.masterUrl);
      const captured = found?.headers;
      if (!captured) {
        return {
          ok: false,
          detail:
            'captured NO player headers at all (onSendHeaders didn\'t fire, ' +
            'or the snapshot was swallowed during the upsertMedia merge)',
        };
      }
      if (captured['x-playback-session-id'] !== PLAYER_TOKEN) {
        return {
          ok: false,
          detail: `captured a header but it's missing/wrong the token: ${JSON.stringify(captured)}`,
        };
      }

      // Step 3: the real download — every request must carry the token to get past the 403 gate.
      const tabId = found.tabId;
      const start = await page.evaluate(
        ([variantUrl, mediaUrl, tid]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl,
            mediaUrl,
            tabId: tid,
          }),
        [srv.mediaUrl, srv.masterUrl, tabId],
      );
      if (!start?.ok) {
        return {
          ok: false,
          detail: `hls/download rejected: ${JSON.stringify(start)}`,
        };
      }
      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (!job) {
        return { ok: false, detail: `job STUCK after ${JOB_TIMEOUT_MS / 1000}s` };
      }
      if (job.phase !== 'done') {
        const bad = srv.requests.filter((r) => r.status === 403).length;
        return {
          ok: false,
          detail:
            `job ${job.phase}: ${job.error ?? '?'} — server 403'd ${bad} request(s) ` +
            'for missing token (the real header was NOT replayed)',
        };
      }
      // Positive evidence: some extension request actually carried the correct token to the server.
      const withToken = srv.requests.filter(
        (r) => r.token === PLAYER_TOKEN && r.status === 200,
      ).length;
      const blocked = srv.requests.filter((r) => r.status === 403).length;
      return {
        ok: true,
        detail: `${withToken} request(s) carried the real token through the gate, ${blocked} blocked`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W2.1 debt (a) — two HLS downloads on the SAME host, each behind its own player token.
 *
 * This is the measurement debt (a) was missing. Conflict-based DNR suppression must behave so:
 *   - 'same' token (the common case: one site, one session token shared by every asset): NOT
 *     suppress -> both downloads finish. An existence-only check would wrongly 403 the second.
 *   - 'different' token: the first (already-running) job keeps its token and finishes; the second
 *     is suppressed and FAILS LOUDLY (its segments 403) instead of silently receiving the wrong
 *     token and shipping a mislabeled file.
 *
 * Mechanism: each player tab fetches only its slot's media playlist carrying its token, so the
 * extension captures the real header per URL. We start download A and wait for its start ack (its
 * DNR rule is now live), then start B so B's applySpoof observes A's rule and makes the decision.
 */
async function runDualHostToken(mode) {
  const srv = await startFixtureServer({ dualToken: mode });
  try {
    return await withBrowser(async ({ page }) => {
      // Step 1: two player tabs, each fetching its own slot's manifest WITH its own token.
      const tabA = await page.context().newPage();
      await tabA.goto(srv.dualPlayerAUrl);
      const tabB = await page.context().newPage();
      await tabB.goto(srv.dualPlayerBUrl);
      const okA = await tabA.evaluate(() => window.__played);
      const okB = await tabB.evaluate(() => window.__played);
      if (!okA || !okB) {
        return {
          ok: false,
          detail: `harness broken: player could not fetch the manifest (a=${okA}, b=${okB})`,
        };
      }

      // Step 2: wait for the extension to write a header snapshot (with token) for BOTH media URLs
      // + learn their tabIds.
      const found = await page.evaluate(
        async ([urlA, urlB]) => {
          const findFor = (all, url) => {
            for (const [k, v] of Object.entries(all)) {
              if (!k.startsWith('media:')) continue;
              const hit = (v?.items ?? []).find((m) => m.url === url);
              if (hit?.sentHeaders?.['x-playback-session-id']) {
                return { headers: hit.sentHeaders, tabId: Number(k.slice(6)) };
              }
            }
            return null;
          };
          for (let i = 0; i < 40; i++) {
            const all = await chrome.storage.session.get(null);
            const a = findFor(all, urlA);
            const b = findFor(all, urlB);
            if (a && b) return { a, b };
            await new Promise((r) => setTimeout(r, 250));
          }
          return null;
        },
        [srv.dualMediaAUrl, srv.dualMediaBUrl],
      );
      if (!found) {
        return {
          ok: false,
          detail: 'did NOT capture the token header of both players',
        };
      }

      // Step 3: start A first, wait for its start ack (its DNR rule is now alive), THEN start B so
      // B's applySpoof observes A's rule and makes the suppression decision.
      const startDl = (mediaUrl, tabId) =>
        page.evaluate(
          ([m, t]) =>
            chrome.runtime.sendMessage({
              kind: 'hls/download',
              variantUrl: m,
              mediaUrl: m,
              tabId: t,
            }),
          [mediaUrl, tabId],
        );
      const startA = await startDl(srv.dualMediaAUrl, found.a.tabId);
      if (!startA?.ok) {
        return { ok: false, detail: `job A rejected: ${JSON.stringify(startA)}` };
      }
      const startB = await startDl(srv.dualMediaBUrl, found.b.tabId);
      if (!startB?.ok) {
        return { ok: false, detail: `job B rejected: ${JSON.stringify(startB)}` };
      }

      const jobA = await waitJob(page, startA.jobId, JOB_TIMEOUT_MS);
      const jobB = await waitJob(page, startB.jobId, JOB_TIMEOUT_MS);
      if (!jobA || !jobB) {
        return {
          ok: false,
          detail: `job STUCK (a=${jobA?.phase}, b=${jobB?.phase})`,
        };
      }

      // Evidence from the server: which slot got served 200, which got 403'd.
      const seg = (slot, status) =>
        srv.requests.filter(
          (r) => r.url.startsWith(`/hls-dual/${slot}/seg`) && r.status === status,
        ).length;

      if (mode === 'same') {
        // Both MUST be 'done'; an existence-based suppressor would 403 B here.
        if (jobA.phase !== 'done' || jobB.phase !== 'done') {
          return {
            ok: false,
            detail:
              `same-token: both should be 'done' but a=${jobA.phase}/${jobA.error ?? ''} ` +
              `b=${jobB.phase}/${jobB.error ?? ''} (seg200 a=${seg('a', 200)} b=${seg('b', 200)}, seg403 b=${seg('b', 403)})`,
          };
        }
        return {
          ok: true,
          detail: `same-token: both finished (seg200 a=${seg('a', 200)}, b=${seg('b', 200)})`,
        };
      }

      // mode === 'different': the first job keeps its token & finishes; the second fails CLEARLY.
      if (jobA.phase !== 'done') {
        return {
          ok: false,
          detail:
            `different-token: the FIRST job (A) should keep its token and be 'done' but a=${jobA.phase}/${jobA.error ?? ''} ` +
            `— its token was stolen by the later job (seg403 a=${seg('a', 403)})`,
        };
      }
      if (jobB.phase === 'done') {
        return {
          ok: false,
          detail: `different-token: the LATER job (B) should FAIL CLEARLY, not silently end 'done' (seg200 b=${seg('b', 200)})`,
        };
      }
      if (seg('b', 200) > 0) {
        return {
          ok: false,
          detail: `different-token: B should NOT receive any 200 segments (received ${seg('b', 200)} — wrong content leaked through)`,
        };
      }
      return {
        ok: true,
        detail: `different-token: A kept its token & finished (seg200 a=${seg('a', 200)}), B failed clearly (${jobB.phase}, seg403 b=${seg('b', 403)})`,
      };
    });
  } finally {
    await srv.close();
  }
}

// --- Scenario list -------------------------------------------------------------------------

/**
 * W1.5 — DASH must download for REAL, and the output file must have BOTH video AND audio.
 *
 * Why this case carries weight: DASH ALWAYS demuxes audio, and the `resolvedUri` of EVERY
 * representation (including audio) is the .mpd file itself. That means any layer that identifies
 * a track by URL will SILENTLY grab the wrong one — the SILENT-corruption disease from §2.1.
 * Checking "there's an audio track" here is the ONLY thing that catches it.
 */
async function runDashDownload() {
  const srv = await startDemuxedServer();
  try {
    return await withBrowser(async ({ page }) => {
      // Step 1: list qualities the way the popup does -> grab the video and audio representation
      // ids.
      const vars = await page.evaluate(
        (url) =>
          chrome.runtime.sendMessage({
            kind: 'manifest/variants',
            url,
            mediaType: 'dash',
          }),
        srv.mpdUrl,
      );
      if (!vars?.ok)
        return {
          ok: false,
          detail: `manifest/variants failed: ${JSON.stringify(vars)}`,
        };
      const variant = vars.variants?.[0];
      const audioId = variant?.audioRenditions?.find((r) => r.selected)?.id;
      if (!variant?.id)
        return {
          ok: false,
          detail: `DASH variant has no id: ${JSON.stringify(vars)}`,
        };
      // Missing audioId = the popup will download the single-input path -> a MUTE file. Catch it
      // right here.
      if (!audioId) {
        return {
          ok: false,
          detail: `DASH exposes no audio rendition -> the output is guaranteed to be MUTE (variant: ${JSON.stringify(variant)})`,
        };
      }

      // Step 2: download exactly the way the popup sends it.
      const start = await page.evaluate(
        ([variantUrl, mediaUrl, variantId, aId]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl,
            mediaUrl,
            tabId: -1,
            mediaType: 'dash',
            variantId,
            audioId: aId,
          }),
        [srv.mpdUrl, srv.mpdUrl, variant.id, audioId],
      );
      if (!start?.ok)
        return {
          ok: false,
          detail: `hls/download failed: ${JSON.stringify(start)}`,
        };

      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (job.phase !== 'done') {
        return {
          ok: false,
          detail: `job did not finish: phase=${job.phase} error=${job.error ?? '-'}`,
        };
      }
      const file = await waitDownloadedFile(page, 30_000);
      if (!file) return { ok: false, detail: 'no file seen on disk' };
      if (file.state !== 'complete') {
        return {
          ok: false,
          detail: `download ${file.state}: ${file.error ?? '?'}`,
        };
      }
      if (!existsSync(file.filename)) {
        return {
          ok: false,
          detail: `downloads reports complete but file does not exist: ${file.filename}`,
        };
      }

      const probe = probeFile(file.filename);
      if (probe.error)
        return { ok: false, detail: `ffprobe could not read it: ${probe.error}` };
      if (!probe.codecs.includes('video')) {
        return {
          ok: false,
          detail: `output file has NO video (streams: ${probe.codecs.join(',') || 'empty'})`,
        };
      }
      // 🔴 The ANTI-MUTE net — the whole reason this case exists.
      if (!probe.codecs.includes('audio')) {
        return {
          ok: false,
          detail: `output file is MUTE: no audio track (streams: ${probe.codecs.join(',')}) — DASH demuxed audio got dropped`,
        };
      }
      if (srv.dashAudioHits() === 0) {
        return {
          ok: false,
          detail:
            'no DASH audio segment was fetched at all -> the audio was never actually downloaded',
        };
      }
      const size = statSync(file.filename).size;
      return {
        ok: true,
        detail:
          `file ${(size / 1024).toFixed(0)}KB, ${probe.duration.toFixed(2)}s, ` +
          `track: ${probe.codecs.join('+')}, fetched ${srv.dashSegmentHits()} DASH segment(s) ` +
          `(audio: ${srv.dashAudioHits()})`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W1.4 — a splice point (EXT-X-DISCONTINUITY) must be COUNTABLE through the exact path the popup
 * uses (`hls/estimate`), and must count correctly in BOTH DIRECTIONS.
 *
 * Why the "clean -> 0" direction matters too: a false-positive warning makes the user abandon a
 * download that's perfectly healthy, and that case has NO symptom anyone would go looking for.
 * MEASURED FOR REAL (m3u8-parser@7.2.0) shows the "obvious" count
 * `discontinuityStarts.length` is wrong in BOTH directions — so the negative direction here isn't
 * mere formality.
 *
 * The popup builds its warning sentence from EXACTLY this number; the confirm dialog itself is out
 * of e2e's reach (the project has no React component tests yet) — that gap is documented in
 * PROMPT-SESSION-MOI.md.
 */
async function runDiscontinuityCounted() {
  const srv = await startFixtureServer({ gate: 'none' });
  try {
    return await withBrowser(async ({ page }) => {
      const estimate = (url) =>
        page.evaluate(
          (u) =>
            chrome.runtime.sendMessage({
              kind: 'hls/estimate',
              variantUrl: u,
              mediaType: 'hls',
              tabId: -1,
            }),
          url,
        );

      const dirty = await estimate(srv.discontinuityUrl);
      if (!dirty?.ok)
        return {
          ok: false,
          detail: `hls/estimate failed on a playlist with a splice point: ${JSON.stringify(dirty)}`,
        };
      if (dirty.discontinuityCount !== 2) {
        return {
          ok: false,
          detail:
            `playlist has 2 splice points but estimate returned ${JSON.stringify(dirty.discontinuityCount)} ` +
            '-> the popup CANNOT warn the user, they get an out-of-sync file with a green checkmark',
        };
      }

      const clean = await estimate(srv.mediaUrl);
      if (!clean?.ok)
        return {
          ok: false,
          detail: `hls/estimate failed on a clean playlist: ${JSON.stringify(clean)}`,
        };
      if (clean.discontinuityCount !== 0) {
        return {
          ok: false,
          detail:
            `playlist is CLEAN but estimate returned ${JSON.stringify(clean.discontinuityCount)} splice point(s) ` +
            '-> a false-positive warning makes the user abandon a perfectly healthy download',
        };
      }
      return {
        ok: true,
        detail: `with splice points -> ${dirty.discontinuityCount}; clean playlist -> ${clean.discontinuityCount}`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W4.3 — the filename must follow the page's VIDEO TITLE, not the URL path.
 *
 * Pins three things unit tests cannot reach, because they live in the wiring inside background:
 *  1. background actually DOES call resolveTitle (instead of the old `media?.title`, which was
 *     almost always empty);
 *  2. `frameIds: [0]` — the page has a player iframe carrying the wrong title, reading the wrong
 *     frame shows up immediately;
 *  3. a unicode title makes it all the way to the filename without being truncated/corrupted.
 */
async function runTitleFromPage({ page: pagePath, want, template, spaNavigate }) {
  const srv = await startFixtureServer({ gate: 'none' });
  try {
    return await withBrowser(async ({ page }) => {
      const pageUrl =
        pagePath === 'og'
          ? srv.ogPageUrl
          : pagePath === 'twitter'
            ? srv.twitterPageUrl
            : srv.docPageUrl;
      // Pins the settings wiring: a template only works if BOTH call sites of
      // buildDownloadFilename read getFilenameTemplate. Missing one makes the setting silently
      // do nothing.
      if (template) {
        await page.evaluate(
          (tpl) => chrome.storage.local.set({ 'settings:filenameTemplate': tpl }),
          template,
        );
      }
      // A REAL tab: resolveTitle reads the DOM via scripting.executeScript so tabId must be a real
      // tab.
      const tabId = await page.evaluate(async (url) => {
        const t = await chrome.tabs.create({ url, active: false });
        return t.id;
      }, pageUrl);
      if (typeof tabId !== 'number') {
        return { ok: false, detail: 'could not open the fixture tab' };
      }
      // Wait for the page's DOM to finish building — reading the title before parsing finishes
      // reads a stale value.
      for (let i = 0; i < 40; i++) {
        const ready = await page.evaluate(async (id) => {
          const [r] = await chrome.scripting.executeScript({
            target: { tabId: id, frameIds: [0] },
            func: () => document.readyState,
          });
          return r?.result;
        }, tabId);
        if (ready === 'complete') break;
        await new Promise((r) => setTimeout(r, 250));
      }

      // Wait for the extension to DETECT the master via webRequest -> generates a real MediaItem,
      // stamped with detectPageUrl. Without this step `media` would be undefined and the
      // wrong-name-guard would never actually be exercised — exactly the hole an adversarial
      // review pointed out.
      let stamped;
      for (let i = 0; i < 40; i++) {
        stamped = await page.evaluate(
          async ([id, url]) => {
            const all = await chrome.storage.session.get(`media:${id}`);
            const it = (all[`media:${id}`]?.items ?? []).find((m) => m.url === url);
            return it ? { detectPageUrl: it.detectPageUrl } : null;
          },
          [tabId, srv.masterUrl],
        );
        if (stamped) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!stamped) {
        return { ok: false, detail: 'extension did NOT detect the master on the fixture tab' };
      }
      if (!stamped.detectPageUrl) {
        return {
          ok: false,
          detail: 'media was NOT stamped with a page at detection time (detectPageUrl is empty)',
        };
      }

      // SPA case: navigating routes WITHOUT reloading the page. The old media entry still belongs
      // to the old page -> the gate must CLOSE and the filename must fall back to a URL-based one,
      // it must NEVER borrow the new page's title.
      if (spaNavigate) {
        await page.evaluate(async (id) => {
          await chrome.scripting.executeScript({
            target: { tabId: id, frameIds: [0] },
            func: () => history.pushState({}, '', '/og.html?v=2'),
          });
        }, tabId);
        for (let i = 0; i < 40; i++) {
          const nav = await page.evaluate(async (id) => {
            const all = await chrome.storage.session.get(`media:${id}`);
            return all[`media:${id}`]?.navUrl;
          }, tabId);
          if (nav && nav.includes('v=2')) break;
          await new Promise((r) => setTimeout(r, 250));
        }
      }

      const start = await page.evaluate(
        ([variantUrl, mediaUrl, id]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl,
            mediaUrl,
            tabId: id,
          }),
        [srv.mediaUrl, srv.masterUrl, tabId],
      );
      if (!start?.ok) {
        return {
          ok: false,
          detail: `hls/download rejected: ${JSON.stringify(start)}`,
        };
      }
      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (!job) return { ok: false, detail: 'job STUCK' };
      const wantName = `${DOWNLOAD_FOLDER}/${want}.mp4`;
      if (job.filename !== wantName) {
        return {
          ok: false,
          detail: `wrong filename: "${job.filename}", expected "${wantName}"`,
        };
      }
      return { ok: true, detail: `correct filename: "${job.filename}"` };
    });
  } finally {
    await srv.close();
  }
}

const SCENARIOS = [
  {
    id: 'happy',
    title: 'No gate: download all 10 segments -> .mp4 on disk, full duration',
    expect: 'pass',
    run: () => runDownload({ gate: 'none', segmentHost: null }),
  },
  {
    id: 'download-spoof',
    title: '403 gate on every path: hls/download DOES call applySpoof -> must get through',
    expect: 'pass',
    run: () => runDownload({ gate: 'all', segmentHost: null }),
  },
  {
    id: 'variants-403',
    title:
      '403 gate on the manifest: clicking "Quality" -> spoof arms BEFORE the fetch (W2.2) -> must get through',
    // W2.2 DONE (2026-07-17): handleVariants now calls applySpoof RIGHT BEFORE the fetch -> gets
    // past the hotlink gate. The ratchet armed at exactly the moment it was fixed (known-fail ->
    // pass), now it's a regression net.
    expect: 'pass',
    run: () => runVariants({ gate: 'manifest' }),
  },
  {
    id: 'segments-other-host',
    title:
      'Segments on a DIFFERENT host than the manifest + 403 gate -> spoof EVERY parsed host (W2.3) -> full download',
    // W2.3 DONE (2026-07-17): handleHlsDownload now parses the playlist FIRST then spoofs every
    // segment/key/init host. The ratchet armed at exactly the moment it was fixed (known-fail ->
    // pass), now a regression net.
    expect: 'pass',
    run: () => runDownload({ gate: 'segments', segmentHost: 'localhost' }),
  },
  {
    id: 'progressive-403',
    title:
      '403 gate on mp4: progressive download must get through (W2.5 routes via offscreen -> fetch carries the Referer)',
    // W2.5 DONE (2026-07-18): handleDownload routes the fetch through offscreen (tab-less
    // xmlhttprequest -> matches the DNR rule). The ratchet armed at exactly the moment it was
    // fixed (known-fail -> pass), now a regression net.
    // MEASURED 2026-07-18: the old direct chrome.downloads.download path -> server sees ref=NONE
    // -> 403.
    expect: 'pass',
    pins: '§2.5/W2.5 (progressive via offscreen)',
    run: () => runProgressive({ gate: 'progressive' }),
  },
  {
    id: 'segment-stall',
    title:
      'Server goes silent mid-transfer: job must report an error within a bounded time (W2.6), not hang in fetching forever',
    // W2.6 (2026-07-18): fetchWithRetry now has a header-wait timer + a silence timer, chained to
    // the job's cancel signal. Before W2.6 this case would hang the whole budget because fetch had
    // no signal at all.
    expect: 'pass',
    pins: '§2.9/W2.6 (retry had no timeout/no cancel)',
    run: () => runSegmentStall(),
  },
  {
    id: 'offscreen-death',
    title:
      'Kill offscreen mid-download: job must report an error within a bounded time (W2.7), not spin forever',
    expect: 'pass',
    pins: '§2.14/W2.7 (offscreen dies silently -> job stuck fetching forever)',
    run: () => runOffscreenDeath(),
  },
  {
    id: 'queued-not-reaped',
    title:
      'A job queued behind a long-running job must NOT be wrongly killed by the W2.7 tick (wrongly killing is worse than hanging)',
    expect: 'pass',
    pins: 'W2.7 (heartbeat must cover the QUEUED state too, not just while running)',
    run: () => runQueuedJobNotReaped(),
  },
  {
    id: 'progressive-offscreen-death',
    title:
      'Kill offscreen mid .mp4 download: entry must settle interrupted, not get stuck in_progress forever',
    expect: 'pass',
    pins: 'W2.7 (W2.5 made progressive depend on offscreen — the liveness net must cover this path too)',
    run: () => runProgressiveOffscreenDeath(),
  },
  {
    id: 'dash-download',
    title: 'DASH downloads for REAL and the output has BOTH video AND audio (W1.5 second half)',
    // Before W1.5's second half: there wasn't even a DASH download button; feeding a .mpd into the
    // HLS parser produced 0 segments WITHOUT throwing -> every static gate stayed green. This case
    // is the only thing that proves the DASH path is alive.
    expect: 'pass',
    pins: '§2.8/W1.5 (DASH dead end + identifying tracks by URL -> mute file)',
    run: () => runDashDownload(),
  },
  {
    id: 'discontinuity-counted',
    title:
      'Playlist with inserted ads -> counts exactly 2 splice points so the popup can warn; clean playlist -> 0 (no false alarm)',
    // Before W1.4: HlsSegmentsResult had no field at all about discontinuities -> ffmpeg received
    // non-monotonic DTS, the output file ended up out of sync/wrong duration, yet the job still
    // reported "Download complete ✓".
    expect: 'pass',
    pins: '§2.?/W1.4 (ghosting through discontinuities -> silently broken file)',
    run: () => runDiscontinuityCounted(),
  },
  {
    id: 'real-header-replay',
    title:
      'Server demands the player\'s own token -> extension must CAPTURE & REPLAY the real header (fabricating fails)',
    expect: 'pass',
    pins: '§2.11/W2.1 (we fabricated Referer/Origin, never once observed a real request header)',
    run: () => runRealHeaderReplay(),
  },
  {
    id: 'dual-host-same-token',
    title:
      'Two downloads on the same host with the SAME session token -> NO wrongful suppression, both finish',
    // 🔴 The most common case, and the one an existence-based suppressor breaks: one site, one
    // token, every asset shares it. Existence-based suppression would demote the later job's token
    // -> its segments 403. Conflict-based suppression must let both through.
    expect: 'pass',
    pins: 'W2.1 debt (a) — same-token wrongly suppressed (bug of an existence check)',
    run: () => runDualHostToken('same'),
  },
  {
    id: 'dual-host-different-token',
    title:
      'Two downloads on the same host with DIFFERENT tokens -> the first job keeps its token & finishes, the second fails CLEARLY (no wrong content)',
    // The first (already-running) job must keep its own token; the later job gets demoted and
    // 403s CLEARLY instead of silently accepting the wrong token and shipping a mislabeled file.
    // This is the safety boundary of debt (a).
    expect: 'pass',
    pins: 'W2.1 debt (a) — a later job steals the first job\'s token (bug when NOT suppressing)',
    run: () => runDualHostToken('different'),
  },
  {
    id: 'title-og',
    title:
      'Page has og:title -> filename follows the VIDEO TITLE (og wins over a dirty <title>; unicode preserved)',
    expect: 'pass',
    pins: 'W4.3 (media detected over the network carries no title -> most files came out master/media.mp4)',
    run: () => runTitleFromPage({ page: 'og', want: 'Tên Video Thật' }),
  },
  {
    id: 'title-doc',
    title:
      'Page only has a dirty <title> -> must strip the "(3)" counter and the site-name suffix, produce the correct video title',
    expect: 'pass',
    pins: 'W4.3 (the title-cleaning chain must run in the real wiring path, not just in vitest)',
    run: () => runTitleFromPage({ page: 'doc', want: 'Tên Video Thật' }),
  },
  {
    id: 'title-template',
    title:
      'A user-defined filename template ({site}_{title}) must reach the real filename, not just live in storage',
    expect: 'pass',
    pins: 'W4.3 (the filename-template setting only had unit tests; the path from storage to filename was never guarded)',
    run: () =>
      runTitleFromPage({
        page: 'og',
        want: '127.0.0.1_Tên Video Thật',
        template: '{site}_{title}',
      }),
  },
  {
    id: 'title-twitter',
    title:
      'Page has ONLY twitter:title (og missing) -> filename follows twitter (the twitter-reading branch had never run in e2e)',
    // 🔴 W4.3 debt — og:title ALWAYS wins so the `read('meta[name="twitter:title"]')` line inside
    // scripting.executeScript had never once run under measurement. This page is the only place
    // that forces it to run; the dirty <title> proves twitter wins over doc, not that doc leaks
    // through.
    expect: 'pass',
    pins: 'W4.3 (the branch reading twitter:title from the DOM had never been touched by any measurement)',
    run: () => runTitleFromPage({ page: 'twitter', want: 'Tên Video Thật' }),
  },
  {
    id: 'title-spa-stale',
    title:
      'SPA-style video switch, then download the OLD entry -> must fall back to a URL-based name, must NOT borrow the new page\'s title',
    expect: 'pass',
    pins: 'W4.3 (the wrong-name guard: better to have no title than a WRONG one)',
    run: () =>
      runTitleFromPage({ page: 'og', want: 'media', spaNavigate: true }),
  },
  // --- §7 — a DRM playlist must be REFUSED (the three most common systems that had slipped through, measured) ---
  {
    id: 'drm-fairplay-refused',
    title:
      'FairPlay playlist (KEYFORMAT com.apple.streamingkeydelivery) -> REFUSED, 0 segments downloaded',
    expect: 'pass',
    run: () => runDrmPlaylistRefused({ system: 'fairplay', wantName: 'FairPlay' }),
  },
  {
    id: 'drm-playready-refused',
    title: 'PlayReady playlist -> REFUSED, 0 segments downloaded',
    expect: 'pass',
    run: () => runDrmPlaylistRefused({ system: 'playready', wantName: 'PlayReady' }),
  },
  {
    id: 'drm-widevine-refused',
    title: 'Widevine playlist (KEYFORMAT urn:uuid) -> REFUSED, 0 segments downloaded',
    expect: 'pass',
    run: () => runDrmPlaylistRefused({ system: 'widevine', wantName: 'Widevine' }),
  },

  // --- W3.1 — AES-128-encrypted HLS (the decryption branch no measurement had ever touched) ---
  {
    id: 'aes128-download',
    title:
      'AES-128-encrypted HLS, IV derived from the media sequence (MEDIA-SEQUENCE=7) -> output has all 100 frames',
    expect: 'pass',
    run: () => runAesDownload({ variant: 'seq' }),
  },
  {
    id: 'aes128-explicit-iv',
    title: 'AES-128-encrypted HLS with an EXPLICIT IV in #EXT-X-KEY -> all 100 frames',
    expect: 'pass',
    run: () => runAesDownload({ variant: 'iv' }),
  },
  {
    id: 'aes128-key-rotation',
    title:
      'AES-128-encrypted HLS that ROTATES KEYS mid-playlist (change at segment 5) -> all 100 frames, 2 keys',
    expect: 'pass',
    // >= 2 key fetches: the URI-keyed cache must fetch BOTH keys. A build that caches "one key for
    // the whole stream" would fetch only once and produce garbage for the second half -> fails
    // here instead of silently drifting.
    run: () => runAesDownload({ variant: 'rot', wantKeyFetches: 2 }),
  },
  {
    id: 'aes128-bad-key',
    title:
      'AES key with the WRONG VALUE -> job must error with a message that CLEARLY STATES it\'s about the key/decryption',
    expect: 'pass',
    run: () => runAesBadKey({ variant: 'bad', wantMessage: /không khớp/ }),
  },
  {
    id: 'aes128-key-not-key',
    title:
      'Server returns an HTML PAGE instead of the AES key (login redirect) -> the error must be expressible in words',
    expect: 'pass',
    run: () =>
      runAesBadKey({ variant: 'badlen', wantMessage: /16 byte|thay vì 16|đăng nhập/ }),
  },
  {
    id: 'aes128-key-403',
    title:
      'AES key on a DIFFERENT HOST + a 403 gate specific to the key path -> spoof must cover the key\'s host too',
    // 🔴 keyHost is what gives this case its teeth. MEASURED: putting the key on the same host as
    // the segments means the DNR rule generated from the segment URL already covers the key too ->
    // removing `add(s.keyUri)` from spoofTargetsFromSegments and the case would still stay GREEN,
    // meaning it pins nothing. In the real world the key is almost ALWAYS on a different host.
    expect: 'pass',
    run: () =>
      runAesDownload({ variant: 'seq', gate: 'key', keyHost: 'localhost' }),
  },

  // --- PACKAGE A — HLS fMP4/CMAF: the #EXT-X-MAP + init-decryption branch (never run before) ---
  {
    id: 'fmp4-plain',
    title:
      'fMP4/CMAF NOT encrypted (#EXT-X-MAP) -> downloads normally, does NOT request a key (guards against wrongful blocking)',
    // The REVERSE-direction case for package A. Any patch that "decrypts whenever it sees
    // #EXT-X-MAP" will fail here.
    expect: 'pass',
    pins: 'PACKAGE A (a clean fMP4 must get through: wrongful blocking/decryption is worse than a miss)',
    run: () => runFmp4Download({ variant: 'plain', wantKeyHits: 0 }),
  },
  {
    id: 'fmp4-aes-init',
    title:
      'fMP4/CMAF AES-128 ENCRYPTED covering the init too (#EXT-X-MAP) + explicit IV -> all 100 frames',
    // 🔴 The MAIN case of package A. Before the RFC 8216 §4.3.2.5 patch, the init was written
    // straight through WITHOUT decryption -> ciphertext sat right where ftyp/moov should be ->
    // libav died with an error blamed on the MUX step. This is the first case in the project to
    // reach that branch.
    expect: 'pass',
    pins: 'PACKAGE A (the init-decryption patch had no measurement running it)',
    run: () => runFmp4Download({ variant: 'enc', wantKeyHits: 1 }),
  },
  {
    id: 'fmp4-clear-init',
    title:
      '#EXT-X-MAP BEFORE #EXT-X-KEY (init IN THE CLEAR, segments encrypted) -> must download fine, must NOT unnecessarily decrypt the init',
    // 🔴 A REAL BUG found by adversarial review, and a REGRESSION caused by the init-decryption
    // patch itself. RFC 8216 §4.3.2.5 scopes keys by TAG POSITION; MAP before KEY = a clear init —
    // a valid and common shape (a clear init lets the player read the codec before requesting a
    // key). The old build inferred the init's key from `segment.key`, so it tried to decrypt an
    // init that was already clear -> WebCrypto threw a padding error -> the job died with an error
    // BLAMING THE SERVER. Wrongly killing a healthy download is a class of bug the project ranks
    // above hanging. MEASURED: m3u8-parser models the correct scope via `segment.map.key`.
    expect: 'pass',
    pins: 'PACKAGE A (the #EXT-X-MAP key scope — the init patch once wrongly killed this exact shape)',
    run: () => runFmp4Download({ variant: 'clear-init', wantKeyHits: 1 }),
  },
  {
    id: 'fmp4-aes-demuxed',
    title:
      'Demuxed-audio fMP4, each track with its OWN #EXT-X-KEY + #EXT-X-MAP -> output has BOTH video AND audio',
    // What was MEASURED to actually be pinned (don't overclaim — adversarial review rejected an
    // earlier over-description):
    //   DOES pin: the SECOND init (the audio track's) gets fetched AND decrypted with its OWN key;
    //             the audio track is actually present in the output.
    //   DOES NOT pin: per-track scoping of `keyCache`. The two tracks use two DIFFERENT keyUris,
    //             and the cache is indexed by URI, so a shared cache (still indexed by URI) still
    //             gives the CORRECT result. Mutation M-A3 fails this case thanks to the
    //             "indexed by a constant" half, and that half is already pinned by
    //             `aes128-key-rotation`.
    expect: 'pass',
    pins: 'PACKAGE A (the second init + the audio track\'s own key — never measured before)',
    run: () =>
      runFmp4Download({
        variant: 'aud',
        demuxed: true,
        wantKeyHits: 2,
        wantAudio: true,
      }),
  },
  {
    id: 'drm-refused',
    title:
      'Page requests DRM/EME -> download REFUSED with a clear reason; a clean tab still downloads fine (the §7 hard boundary)',
    expect: 'pass',
    pins: 'W7.1 (§7 declared a DRM boundary while grepping requestMediaKeySystemAccess returned 0 hits)',
    run: () => runDrmRefused(),
  },
];

// --- Run -------------------------------------------------------------------------------------

let failed = false;
const only = process.argv[2];

console.log(
  'W0.3 — integrated safety net (real extension + local 403 fixture)\n',
);

for (const s of SCENARIOS) {
  if (only && s.id !== only) continue;
  console.log(`▶ [${s.id}] ${s.title}`);
  let r;
  try {
    r = await s.run();
  } catch (e) {
    r = { ok: false, detail: `harness error: ${e?.message ?? e}` };
  }

  if (s.expect === 'pass') {
    if (r.ok) console.log(`  ✓ PASSED — ${r.detail}\n`);
    else {
      failed = true;
      console.log(`  ✗ FAILED — ${r.detail}\n`);
    }
  } else {
    if (!r.ok) {
      console.log(`  ⊘ RED AS EXPECTED (known bug still alive, pinned) — ${r.detail}`);
      console.log(`     pins: ${s.pins}\n`);
    } else {
      // Ratchet armed: the bug got fixed -> force a relabel, don't let it silently drift.
      failed = true;
      console.log(
        `  ✗ RATCHET ARMED — this case was SUPPOSED to be red but PASSED: ${r.detail}`,
      );
      console.log(
        `     => ${s.pins} has been fixed. Change expect: 'known-fail' -> 'pass' in e2e/hls-403.mjs.\n`,
      );
    }
  }
}

console.log(failed ? '✗ W0.3 FAILED' : '✓ W0.3 PASSED');
process.exit(failed ? 1 : 0);
