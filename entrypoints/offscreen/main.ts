// Offscreen document — runs heavy work that needs DOM/WASM: mux/remux HLS with libav.js,
// fetch + decrypt segments, create blob URLs for download. MV3 service worker CANNOT do this.
//
// W3.1 — @ffmpeg/core (GPL, 32.2 MB, holds the whole video in RAM) HAS BEEN REMOVED, replaced by a
// self-built libav.js (variant `ts2mp4d`, LGPL-2.1, 1.56 MB wasm, 0 encoders) running in a Worker and
// streaming bytes through OPFS. Three reasons, in order of importance:
//   1. LEGAL: @ffmpeg/core is built with --enable-gpl so it's GPL, while the project declares MIT.
//   2. Memory: the old build kept the whole video in RAM; this one has FLAT RAM (measured up to a 1.19 GB input).
//   3. Bundle size: 34.8 MB -> ~2.4 MB.
// The muxing lives in `mux-worker.ts` (the only place with FileSystemSyncAccessHandle); the pure
// core is in `utils/remux-core.ts` + `utils/remux-time.ts` so it can be tested under node.
import { enqueueHlsJob, jobAborts } from './hls-job';
import { runYoutubeJob, youtubeAborts } from './youtube-job';
import { runProgressiveDownload, progressiveAborts } from './progressive';
import { runEngineSelfTest } from './selftest';
import { revokeBlob } from './blob-store';
import { sweepOrphanOpfsFiles } from './libav-mux';
import { describeError } from '@/utils/errors';
import type {
  EngineSelfTestResponse,
  OffscreenRequest,
} from '@/utils/messages';

function asOffscreenRequest(m: unknown): OffscreenRequest | null {
  if (
    typeof m === 'object' &&
    m !== null &&
    (m as { target?: unknown }).target === 'offscreen'
  ) {
    return m as OffscreenRequest;
  }
  return null;
}

// Same contract as background (see the comment in entrypoints/background.ts): return `true`
// SYNCHRONOUSLY for the async branch, do NOT return a Promise. A message that isn't for offscreen
// -> return `undefined` so it does NOT hijack background's response channel.
browser.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender: unknown,
    sendResponse: (response?: unknown) => void,
  ): true | undefined => {
    const req = asOffscreenRequest(message);
    if (!req) return undefined;
    switch (req.kind) {
      case 'engine/selftest':
        void runEngineSelfTest()
          .then(
            (res: EngineSelfTestResponse) => sendResponse(res),
            (e: unknown) =>
              sendResponse({ ok: false, error: describeError(e) }),
          )
          .catch(() => undefined);
        return true;
      case 'hls/run':
        enqueueHlsJob(req);
        return undefined;
      case 'hls/cancel':
        // Cancellation can arrive BEFORE the job leaves the queue (jobChain is sequential) -> create
        // a controller that's already aborted so runHlsJob picks it up and exits immediately, rather
        // than finishing the download and only then discovering it was cancelled.
        {
          const existing = jobAborts.get(req.jobId);
          if (existing) existing.abort();
          else {
            const pre = new AbortController();
            pre.abort();
            jobAborts.set(req.jobId, pre);
            // Cancelling a job that's already finished (or never existed) would leave this entry
            // FOREVER — offscreen is a persistent page so the Map would just keep growing. Schedule
            // a cleanup: if the job was real, it already picked up the controller and runHlsJob
            // deletes it itself in `finally`, so deleting again here is harmless.
            setTimeout(() => {
              if (jobAborts.get(req.jobId) === pre) jobAborts.delete(req.jobId);
            }, 60_000);
          }
        }
        return undefined;
      case 'youtube/run':
        // Independent of jobChain: each MuxSession owns its OWN libav Worker + a unique OPFS jobKey,
        // so it can't collide with an HLS job (unlike the old single-instance ffmpeg). Catches its own
        // errors and reports them via reportJob; only swallow the leftover rejection here.
        void runYoutubeJob(req).catch((e: unknown) =>
          console.warn(
            '[offscreen] tải YouTube lỗi ngoài dự kiến:',
            describeError(e),
          ),
        );
        return undefined;
      case 'youtube/cancel':
        // Same pattern as hls/cancel: a cancel can arrive before the job starts -> pre-register an
        // already-aborted controller so runYoutubeJob picks it up and exits immediately.
        {
          const existing = youtubeAborts.get(req.jobId);
          if (existing) existing.abort();
          else {
            const pre = new AbortController();
            pre.abort();
            youtubeAborts.set(req.jobId, pre);
            setTimeout(() => {
              if (youtubeAborts.get(req.jobId) === pre)
                youtubeAborts.delete(req.jobId);
            }, 60_000);
          }
        }
        return undefined;
      case 'revoke':
        revokeBlob(req.url);
        return undefined;
      case 'download/run':
        // Progressive does NOT use ffmpeg/the virtual FS -> runs INDEPENDENTLY of jobChain (no need
        // to be sequential like HLS). runProgressiveDownload catches its own errors and reports them
        // to background, so this only needs to swallow the leftover rejection.
        void runProgressiveDownload(req).catch((e: unknown) =>
          console.warn(
            '[offscreen] tải progressive lỗi ngoài dự kiến:',
            describeError(e),
          ),
        );
        return undefined;
      case 'download/abort':
        progressiveAborts.get(req.key)?.abort();
        return undefined;
    }
  },
);

// W3.1 — sweeps orphaned OPFS files left by dead jobs (offscreen killed mid-flight, browser closed
// abruptly). MEASURED: OPFS files survive closeDocument, extension reload, and even a browser
// restart — nobody cleans them up automatically. Runs right when offscreen is set up: at that
// moment no job can possibly be running yet, so it can never accidentally delete a file still in use.
void sweepOrphanOpfsFiles()
  .then((n) => {
    if (n > 0) console.log('[offscreen] đã dọn', n, 'tệp tạm mồ côi');
  })
  .catch(() => undefined);

// W3.1 — engine prewarming is NO LONGER done here. The old ffmpeg build had to preload 32 MB of
// wasm since loading it took several seconds; libav.js is only 1.56 MB and its Worker is spun up
// IMMEDIATELY when a job starts, in parallel with downloading the playlist (`MuxSession.start` is
// called before the first `await` in runHlsJob), so the dead time is already covered without
// having to keep wasm alive for the whole session.
