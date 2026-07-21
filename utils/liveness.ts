// W2.7 — detect a "dead video processor" (§2.14).
//
// PROBLEM: the offscreen document can be killed by Chrome at any time (Task Manager, OOM, tab
// crash). It dies SILENTLY — no event reports back to background. The running job stays stuck in
// storage at phase 'fetching' FOREVER, the popup spins forever with no explanation. That's the
// worst possible outcome for a download app: the user doesn't know whether to keep waiting or retry.
//
// FIX: offscreen sends a steady heartbeat; background stamps `lastSeenAt` on every message
// received, and a periodic tick marks a REAL ERROR for any job that's been silent too long.
//
// 🔴 CLOCK BY SILENCE, NOT BY TOTAL DURATION — same lesson as W2.5/W2.6. A valid HLS job running
// for 30 minutes is normal; what's ABNORMAL is 60 seconds without a single sound.
//
// Pure logic (no browser API) so it's unit-testable — background.ts is an entrypoint that vitest
// doesn't touch.

import type { DownloadEntry, HlsJob, HlsPhase } from './storage';

/** How often offscreen sends a heartbeat (dense enough that the 60s threshold doesn't false-alarm). */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Silence longer than this = the processor has died.
 *
 * Why 60s and not shorter: the heartbeat goes through `runtime.sendMessage`, and the service worker
 * may be asleep/restarting — dropping a few beats is normal. 60s = 12 consecutive missed beats,
 * at which point concluding "dead" is safe. Shorter would kill healthy jobs.
 */
export const HEARTBEAT_TIMEOUT_MS = 60_000;

/** Message shown when the processor dies — must state CLEARLY what happened and what to do next, not a bare error code. */
export const DEAD_OFFSCREEN_ERROR =
  'Bộ xử lý video đã dừng đột ngột (thường do hết bộ nhớ hoặc trình duyệt thu hồi). Hãy thử tải lại — nếu video rất lớn, chọn chất lượng thấp hơn.';

/** Phase still RUNNING = must have a heartbeat. Silence during a finished phase is normal — stop tracking it. */
const ACTIVE_PHASES: readonly HlsPhase[] = [
  'queued',
  'loading',
  'fetching',
  'muxing',
  'saving',
];

export function isActiveHlsPhase(phase: HlsPhase): boolean {
  return ACTIVE_PHASES.includes(phase);
}

/**
 * Which jobs have been silent too long -> their ids (the caller marks the error).
 *
 * Two layers of protection against WRONGFUL KILLS:
 * - `>` instead of `>=`: exactly at the threshold doesn't count as dead yet (a small clock jitter isn't a death sentence).
 * - missing `lastSeenAt` -> SKIPPED. A job created before this upgrade has no timestamp; no proof of
 *   life also means no proof of death, and a wrongful kill is worse than a miss.
 */
export function findDeadHlsJobs(
  jobs: Record<string, HlsJob>,
  now: number,
  timeoutMs: number,
): string[] {
  const dead: string[] = [];
  for (const [id, job] of Object.entries(jobs)) {
    if (!job || !isActiveHlsPhase(job.phase)) continue;
    if (typeof job.lastSeenAt !== 'number') continue;
    if (now - job.lastSeenAt > timeoutMs) dead.push(id);
  }
  return dead;
}

/**
 * W2.7 — which PROGRESSIVE downloads have been silent too long -> their keys.
 *
 * Why this path also needs a safety net: W2.5 routes .mp4 through offscreen (to carry the Referer
 * spoof), so from then on progressive downloads DEPEND on offscreen just like HLS does. Offscreen
 * dies ⇒ its `finally` doesn't run ⇒ no `download/progress` 'interrupted' ever gets sent ⇒ the
 * entry stays stuck at `in_progress` forever.
 *
 * 🔴 ONLY watch the FETCH phase (`chromeDownloadId === undefined`). Once there's an id, offscreen
 * has already handed off the blob and `chrome.downloads` is in charge — that download NO LONGER
 * depends on offscreen, and silence from it is normal (downloads.onChanged is the source of truth
 * there). Watching it too would wrongfully kill the save phase.
 */
export function findDeadDownloads(
  entries: Record<string, DownloadEntry>,
  now: number,
  timeoutMs: number,
): string[] {
  const dead: string[] = [];
  for (const [key, e] of Object.entries(entries)) {
    if (!e || e.state !== 'in_progress') continue;
    if (e.chromeDownloadId !== undefined) continue;
    if (typeof e.lastSeenAt !== 'number') continue;
    if (now - e.lastSeenAt > timeoutMs) dead.push(key);
  }
  return dead;
}

/**
 * Coalesces every SIMULTANEOUS call into a single in-flight run.
 *
 * Why this is needed (§2.14): two `handleHlsDownload` calls hit `ensureOffscreen()` back to back ->
 * both enter `createDocument`, the second one throws "single offscreen document" and gets SWALLOWED,
 * the caller thinks offscreen is ready and fires `hls/run` at a document that HASN'T finished
 * registering its listener -> the job gets stuck at 'queued' forever. This is exactly the class of
 * bug that made HLS die silently for many of the project's early commits.
 *
 * 🔴 Does NOT cache the result once done: offscreen can die at any moment, so the next call MUST
 * probe again from scratch. Only coalesces while still in flight.
 * 🔴 On throw, also clears the in-flight slot: keeping a broken promise around would make every
 * subsequent attempt fail forever.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const p = (async () => fn())().finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  };
}
