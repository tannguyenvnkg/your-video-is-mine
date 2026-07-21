import { describe, expect, it, vi } from 'vitest';
import type { DownloadEntry, HlsJob } from './storage';
import {
  DEAD_OFFSCREEN_ERROR,
  HEARTBEAT_TIMEOUT_MS,
  findDeadDownloads,
  findDeadHlsJobs,
  isActiveHlsPhase,
  singleFlight,
} from './liveness';

// W2.7 — §2.14: today, if offscreen dies mid-flight the job stays stuck at 'fetching' FOREVER and
// the popup spins with no explanation. Every test below is RED against pre-W2.7 code (before this
// file existed).

/** Minimal job — only the fields liveness touches. */
function job(id: string, patch: Partial<HlsJob> = {}): HlsJob {
  return {
    id,
    mediaUrl: `https://x/${id}.m3u8`,
    variantUrl: `https://x/${id}-v.m3u8`,
    phase: 'fetching',
    segmentsTotal: 10,
    segmentsDone: 3,
    ...patch,
  };
}

describe('isActiveHlsPhase', () => {
  it('a running phase = alive, must have a heartbeat', () => {
    for (const p of [
      'queued',
      'loading',
      'fetching',
      'muxing',
      'saving',
    ] as const)
      expect(isActiveHlsPhase(p)).toBe(true);
  });

  it('a finished phase = NOT tracked anymore (job is done, silence is correct)', () => {
    for (const p of ['done', 'error', 'cancelled'] as const)
      expect(isActiveHlsPhase(p)).toBe(false);
  });
});

describe('findDeadHlsJobs', () => {
  const NOW = 1_000_000;

  it('a running job silent past the threshold -> DEAD (this is the §2.14 bug to catch)', () => {
    const jobs = {
      a: job('a', { lastSeenAt: NOW - HEARTBEAT_TIMEOUT_MS - 1 }),
    };
    expect(findDeadHlsJobs(jobs, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual(['a']);
  });

  it('a job that just reported a heartbeat -> alive, must NOT be killed unfairly', () => {
    const jobs = { a: job('a', { lastSeenAt: NOW - 1_000 }) };
    expect(findDeadHlsJobs(jobs, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual([]);
  });

  it('an ALREADY finished job is exempt no matter how long it stays silent', () => {
    const jobs = {
      d: job('d', {
        phase: 'done',
        lastSeenAt: NOW - 10 * HEARTBEAT_TIMEOUT_MS,
      }),
      e: job('e', {
        phase: 'error',
        lastSeenAt: NOW - 10 * HEARTBEAT_TIMEOUT_MS,
      }),
      c: job('c', {
        phase: 'cancelled',
        lastSeenAt: NOW - 10 * HEARTBEAT_TIMEOUT_MS,
      }),
    };
    expect(findDeadHlsJobs(jobs, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual([]);
  });

  it('EXACTLY at the threshold is NOT yet dead — only strictly past it counts (avoids killing on a minor hiccup)', () => {
    const jobs = { a: job('a', { lastSeenAt: NOW - HEARTBEAT_TIMEOUT_MS }) };
    expect(findDeadHlsJobs(jobs, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual([]);
  });

  it('a job with NO lastSeenAt (created before the upgrade) -> must NOT be killed unfairly', () => {
    const jobs = { a: job('a', { lastSeenAt: undefined }) };
    expect(findDeadHlsJobs(jobs, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual([]);
  });

  it('correctly filters the dead job out of a crowd, keeps the healthy ones', () => {
    const jobs = {
      alive: job('alive', { lastSeenAt: NOW - 5_000 }),
      dead1: job('dead1', { lastSeenAt: NOW - HEARTBEAT_TIMEOUT_MS - 5_000 }),
      finished: job('finished', { phase: 'done', lastSeenAt: NOW - 999_999 }),
      dead2: job('dead2', {
        phase: 'muxing',
        lastSeenAt: NOW - HEARTBEAT_TIMEOUT_MS - 1,
      }),
    };
    expect(findDeadHlsJobs(jobs, NOW, HEARTBEAT_TIMEOUT_MS).sort()).toEqual([
      'dead1',
      'dead2',
    ]);
  });

  it('the dead-job message must STATE THE REASON to the user, not a bare error code', () => {
    // A silently frozen spinner with no explanation is the worst outcome for a download app.
    expect(DEAD_OFFSCREEN_ERROR.length).toBeGreaterThan(20);
    expect(DEAD_OFFSCREEN_ERROR).toMatch(/dừng|chết|thoát/i);
  });
});

describe('findDeadDownloads (W2.5 made progressive downloads depend on offscreen too)', () => {
  const NOW = 1_000_000;

  function entry(
    key: string,
    patch: Partial<DownloadEntry> = {},
  ): DownloadEntry {
    return {
      key,
      mediaUrl: `https://x/${key}.mp4`,
      state: 'in_progress',
      ...patch,
    };
  }

  it('FETCHING in offscreen and silent past the threshold -> DEAD', () => {
    const d = { a: entry('a', { lastSeenAt: NOW - HEARTBEAT_TIMEOUT_MS - 1 }) };
    expect(findDeadDownloads(d, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual(['a']);
  });

  it('ALREADY has a chromeDownloadId -> chrome.downloads is in charge, silence is NORMAL, must not be killed unfairly', () => {
    // This is the trickiest half to get wrong: the SAVE phase no longer depends on offscreen.
    const d = {
      a: entry('a', {
        chromeDownloadId: 42,
        lastSeenAt: NOW - 10 * HEARTBEAT_TIMEOUT_MS,
      }),
    };
    expect(findDeadDownloads(d, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual([]);
  });

  it('a finished state -> is exempt', () => {
    const d = {
      c: entry('c', { state: 'complete', lastSeenAt: NOW - 999_999 }),
      i: entry('i', { state: 'interrupted', lastSeenAt: NOW - 999_999 }),
    };
    expect(findDeadDownloads(d, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual([]);
  });

  it('just reported a heartbeat -> alive', () => {
    const d = { a: entry('a', { lastSeenAt: NOW - 1_000 }) };
    expect(findDeadDownloads(d, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual([]);
  });

  it('missing lastSeenAt (old entry) -> must NOT be killed unfairly', () => {
    const d = { a: entry('a', { lastSeenAt: undefined }) };
    expect(findDeadDownloads(d, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual([]);
  });
});

describe('singleFlight', () => {
  it('two SIMULTANEOUS calls run the function only ONCE (kills the race that creates 2 offscreens)', async () => {
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 'ok';
    });
    const wrapped = singleFlight(fn);
    const [a, b] = await Promise.all([wrapped(), wrapped()]);
    expect(a).toBe('ok');
    expect(b).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calling again AFTER completion runs it again — offscreen may have died since the last call', async () => {
    const fn = vi.fn(async () => 'ok');
    const wrapped = singleFlight(fn);
    await wrapped();
    await wrapped();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('the function throwing -> every caller in that batch gets the error (NONE of them think it succeeded)', async () => {
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('tạo hỏng');
    });
    const wrapped = singleFlight(fn);
    const results = await Promise.allSettled([wrapped(), wrapped()]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('after throwing, the NEXT call is retried (no permanently stuck broken promise)', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error('hỏng lần đầu');
      return 'ok';
    });
    const wrapped = singleFlight(fn);
    await expect(wrapped()).rejects.toThrow('hỏng lần đầu');
    await expect(wrapped()).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
