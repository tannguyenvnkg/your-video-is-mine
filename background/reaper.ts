import {
  getHlsJobs,
  getDownloads,
  updateHlsJob,
  updateDownload,
} from '@/utils/storage';
import {
  HEARTBEAT_TIMEOUT_MS,
  DEAD_OFFSCREEN_ERROR,
  findDeadHlsJobs,
  findDeadDownloads,
} from '@/utils/liveness';
import { describeError } from '@/utils/errors';
import { removeSpoofRules } from '@/background/spoof';

export const DEAD_JOB_ALARM = 'w27-dead-job-tick';

/**
 * W2.7 — finalize an ERROR for a job whose offscreen died mid-way (§2.14).
 *
 * Why this is needed: offscreen dies SILENTLY — Chrome fires no event back to background. Without
 * this tick a job would stay stuck at 'fetching' FOREVER and the popup would spin with no
 * explanation — exactly the worst possible outcome for a download app: the user has no idea whether
 * to keep waiting or click again.
 */
export async function reapDeadHlsJobs(): Promise<void> {
  try {
    const jobs = await getHlsJobs();
    const dead = findDeadHlsJobs(jobs, Date.now(), HEARTBEAT_TIMEOUT_MS);
    if (dead.length === 0) return;
    for (const id of dead) {
      await updateHlsJob(id, {
        phase: 'error',
        error: DEAD_OFFSCREEN_ERROR,
        note: undefined,
      });
      // A dead job's spoof rule is garbage: it can no longer clean itself up (the normal terminal
      // branch never runs). Same leak bug class as W2.4.
      const ids = jobs[id]?.spoofRuleIds;
      if (ids?.length) await removeSpoofRules(ids);
    }
    console.warn(`[bg] W2.7: chốt lỗi ${dead.length} job do offscreen đã chết`);
  } catch (e) {
    // The periodic tick MUST NOT throw: throwing here would be an unhandled rejection every 30 seconds.
    console.warn('[bg] tick dò job chết lỗi:', describeError(e));
  }
}

/**
 * W2.7 — finalize an ERROR for a PROGRESSIVE download whose offscreen died mid-fetch.
 *
 * Why this path is also needed (easy to overlook): W2.5 moved .mp4 to fetch inside offscreen so it
 * could carry the Referer spoof — from that point it depends on offscreen just like HLS does, but the
 * original liveness net only covered HLS. MEASURED via e2e `progressive-offscreen-death`: entry stuck
 * at `in_progress` for >150s.
 */
export async function reapDeadDownloads(): Promise<void> {
  try {
    const entries = await getDownloads();
    const dead = findDeadDownloads(entries, Date.now(), HEARTBEAT_TIMEOUT_MS);
    if (dead.length === 0) return;
    for (const key of dead) {
      await updateDownload(key, {
        state: 'interrupted',
        error: DEAD_OFFSCREEN_ERROR,
      });
      // A dead round's spoof rule can no longer clean itself up: the normal terminal branch
      // (handleBlobDownload / download/progress 'interrupted') never runs. Same leak class as W2.4.
      const ids = entries[key]?.spoofRuleIds;
      if (ids?.length) await removeSpoofRules(ids);
    }
    console.warn(
      `[bg] W2.7: chốt lỗi ${dead.length} lượt tải do offscreen đã chết`,
    );
  } catch (e) {
    console.warn('[bg] tick dò lượt tải chết lỗi:', describeError(e));
  }
}
