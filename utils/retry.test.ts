import { describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_MAX_MS,
  CancelledError,
  FatalFetchError,
  backoffDelayMs,
  fetchWithRetry,
  isFatalHttpStatus,
  linkSignals,
} from './retry';

// W2.6 — 4 properties that §2.9 says the old retry loop LACKED. Each describe below is RED against
// the pre-W2.6 code (verified by running this exact test suite against the old loop — see §2b).

/** Minimal fake response — only the fields fetchWithRetry touches. */
function res(status: number, body = new ArrayBuffer(8)): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A fake fetch that HANGS — but honors the signal just like real fetch (rejects on abort). */
function hangingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const s = init?.signal;
      if (!s) return; // no signal -> hangs FOREVER, matching the old code's behavior
      if (s.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      s.addEventListener(
        'abort',
        () =>
          reject(
            (s as AbortSignal).reason ??
              new DOMException('aborted', 'AbortError'),
          ),
        { once: true },
      );
    })) as unknown as typeof fetch;
}

describe('W2.6 (1) timeout per attempt', () => {
  it('server hangs -> throws, does NOT hang forever', async () => {
    // Old code: fetch without a signal -> this promise never settles -> the job gets stuck at
    // 'fetching' forever, no error, uncancellable (§2.9 consequence 1).
    await expect(
      fetchWithRetry('http://x/seg.ts', {
        fetchFn: hangingFetch(),
        timeoutMs: 20,
        retries: 1,
        sleepFn: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/lần thử/);
  }, 2_000);

  it('the error message clearly says it timed out, not an empty string', async () => {
    const err = await fetchWithRetry('http://x/seg.ts', {
      fetchFn: hangingFetch(),
      timeoutMs: 20,
      retries: 0,
      sleepFn: () => Promise.resolve(),
    }).catch((e: unknown) => e);
    expect(String((err as Error).message)).toMatch(/quá hạn|không phản hồi/);
  }, 2_000);
});

/**
 * A fake response whose body streams in on a rhythm: `gaps` are the silent gaps (ms) BEFORE each
 * chunk of bytes. Honors the signal — aborting makes the reader throw, just like real fetch.
 */
function streamingFetch(gaps: number[]): typeof fetch {
  return ((_url: string, init?: RequestInit) => {
    const s = init?.signal;
    let i = 0;
    const body = {
      getReader: () => ({
        read: () =>
          new Promise<{ done: boolean; value?: Uint8Array }>(
            (resolve, reject) => {
              if (i >= gaps.length) {
                resolve({ done: true });
                return;
              }
              const gap = gaps[i]!;
              i++;
              const t = setTimeout(
                () => resolve({ done: false, value: new Uint8Array(4) }),
                gap,
              );
              s?.addEventListener(
                'abort',
                () => {
                  clearTimeout(t);
                  reject(s.reason ?? new DOMException('aborted', 'AbortError'));
                },
                { once: true },
              );
            },
          ),
      }),
    };
    return Promise.resolve({
      ok: true,
      status: 200,
      body,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

describe('W2.6 (1b) timeout based on SILENCE, not total time', () => {
  it('server sends headers then goes silent mid-stream -> aborts, does not hang', async () => {
    // 3 chunks arrive fast then it goes silent forever (gap 10_000 > stallMs).
    await expect(
      fetchWithRetry('http://x/seg.ts', {
        fetchFn: streamingFetch([1, 1, 1, 10_000]),
        stallMs: 30,
        retries: 1,
        sleepFn: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/lần thử/);
  }, 3_000);

  it('🔴 does NOT wrongly cut off a SLOW download that is flowing steadily', async () => {
    // Lesson from W2.5: a cap on TOTAL time kills exactly the users with weak connections. Here the
    // total time (10 chunks x 20ms = 200ms) FAR EXCEEDS stallMs (50ms) — but no single chunk stalls
    // more than 50ms, so the request must survive. Any fix using plain AbortSignal.timeout would go
    // RED here.
    const out = await fetchWithRetry('http://x/seg.ts', {
      fetchFn: streamingFetch(Array.from({ length: 10 }, () => 20)),
      stallMs: 50,
      timeoutMs: 50,
      retries: 0,
    });
    expect(out.byteLength).toBe(40);
  }, 3_000);
});

describe('W2.6 (2) cancel yanks an in-flight request out IMMEDIATELY', () => {
  it('abort while fetch is hanging -> rejects CancelledError, does not wait out the retries', async () => {
    const ac = new AbortController();
    const p = fetchWithRetry('http://x/seg.ts', {
      fetchFn: hangingFetch(),
      signal: ac.signal,
      timeoutMs: 60_000, // long timeout: if the signal isn't honored, the test will time out
      retries: 3,
    });
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
  }, 2_000);

  it('signal already aborted beforehand -> fetch is never called', async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchFn = vi.fn(() => Promise.resolve(res(200)));
    await expect(
      fetchWithRetry('http://x/seg.ts', {
        signal: ac.signal,
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('cancel while backing off -> stops immediately, does not sit out the full 8 seconds', async () => {
    const ac = new AbortController();
    const fetchFn = vi.fn(() => Promise.resolve(res(500)));
    const p = fetchWithRetry('http://x/seg.ts', {
      fetchFn: fetchFn as unknown as typeof fetch,
      signal: ac.signal,
      retries: 5,
    });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    // Hasn't had time to burn through all 6 attempts: real backoff (500ms+) holds it back.
    expect(fetchFn.mock.calls.length).toBeLessThan(4);
  }, 3_000);
});

describe('W2.6 (3) fail-fast on unrecoverable HTTP codes', () => {
  it.each([401, 403, 404, 410, 416])(
    'HTTP %i -> tries EXACTLY once then gives up (an expired signed URL never recovers)',
    async (status) => {
      const fetchFn = vi.fn(() => Promise.resolve(res(status)));
      await expect(
        fetchWithRetry('http://x/seg.ts', {
          fetchFn: fetchFn as unknown as typeof fetch,
          sleepFn: () => Promise.resolve(),
        }),
      ).rejects.toBeInstanceOf(FatalFetchError);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it('HTTP 500/429 STILL retries (transient error)', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(res(503)));
    await expect(
      fetchWithRetry('http://x/seg.ts', {
        fetchFn: fetchFn as unknown as typeof fetch,
        retries: 2,
        sleepFn: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/3 lần thử/);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('W1.3 no regression: server ignores Range (200 instead of 206) -> fatal, no retry', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(res(200)));
    await expect(
      fetchWithRetry('http://x/main.mp4', {
        range: { offset: 719, length: 274201 },
        fetchFn: fetchFn as unknown as typeof fetch,
        sleepFn: () => Promise.resolve(),
      }),
    ).rejects.toBeInstanceOf(FatalFetchError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('W2.6 review patch', () => {
  it('206 SHORTER than the requested range -> throws, does NOT stitch truncated bytes (symmetric with W2.5)', async () => {
    // RFC 7233 lets a server/proxy return less than requested. Accepting it blindly means the
    // segment is short bytes, the muxed file comes out broken, yet the job still reports 'done' —
    // exactly the class of silent bug W2.5 just had to patch on the progressive path.
    const short = new ArrayBuffer(100);
    const fetchFn = vi.fn(() => Promise.resolve(res(206, short)));
    await expect(
      fetchWithRetry('http://x/main.mp4', {
        range: { offset: 0, length: 999 },
        fetchFn: fetchFn as unknown as typeof fetch,
        retries: 0,
        sleepFn: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/thiếu byte/);
  });

  it('linkSignals: a signal ALREADY aborted beforehand must still abort immediately (cancel must not lose effect)', () => {
    const done = new AbortController();
    done.abort();
    const fresh = new AbortController();
    // The old fallback branch used addEventListener -> the event already fired, so it never fires again.
    expect(linkSignals(fresh.signal, done.signal).signal.aborted).toBe(true);
    expect(linkSignals(done.signal, fresh.signal).signal.aborted).toBe(true);
  });

  it('onRetry reports every retry attempt (so the popup does not freeze silently)', async () => {
    const seen: number[] = [];
    const fetchFn = vi.fn(() => Promise.resolve(res(503)));
    await fetchWithRetry('http://x/seg.ts', {
      fetchFn: fetchFn as unknown as typeof fetch,
      retries: 2,
      sleepFn: () => Promise.resolve(),
      onRetry: (i) => seen.push(i.attempt),
    }).catch(() => undefined);
    expect(seen).toEqual([1, 2]);
  });

  it('403 now has a message that STATES what went wrong, not a bare "HTTP 403"', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(res(403)));
    const err = await fetchWithRetry('http://x/seg.ts', {
      fetchFn: fetchFn as unknown as typeof fetch,
      label: 'segment #3/10',
      sleepFn: () => Promise.resolve(),
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('segment #3/10');
    expect((err as Error).message).toMatch(/từ chối|hết hạn|chặn/);
  });
});

describe('W2.6 (4) exponential backoff between attempts', () => {
  it('waits 500ms, 1s, 2s — does NOT fire 4 attempts within a few microseconds', async () => {
    const delays: number[] = [];
    const fetchFn = vi.fn(() => Promise.resolve(res(503)));
    await fetchWithRetry('http://x/seg.ts', {
      fetchFn: fetchFn as unknown as typeof fetch,
      retries: 3,
      sleepFn: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    }).catch(() => undefined);
    // Firing back-to-back with no pause looks like an attack -> CDN escalates from soft throttling to an IP ban (§2.9).
    expect(delays).toEqual([500, 1000, 2000]);
  });

  it('backoffDelayMs: no wait on the first attempt, has a CEILING', () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(1)).toBe(500);
    expect(backoffDelayMs(2)).toBe(1000);
    expect(backoffDelayMs(99)).toBe(BACKOFF_MAX_MS);
  });
});

describe('the success path remains intact', () => {
  it('200 -> returns bytes, calls fetch exactly once', async () => {
    const body = new ArrayBuffer(16);
    const fetchFn = vi.fn(() => Promise.resolve(res(200, body)));
    const out = await fetchWithRetry('http://x/seg.ts', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(out.byteLength).toBe(16);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a transient network error then success -> returns bytes', async () => {
    let n = 0;
    const fetchFn = vi.fn(() => {
      n++;
      return n === 1
        ? Promise.reject(new TypeError('network error'))
        : Promise.resolve(res(200));
    });
    const out = await fetchWithRetry('http://x/seg.ts', {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: () => Promise.resolve(),
    });
    expect(out.byteLength).toBe(8);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('sends the Range header in closed-interval form + cache reload', async () => {
    // Body MUST match the exact length of the requested range — the short-206 guard (review patch) throws if bytes are missing.
    const full = new ArrayBuffer(274201);
    const fetchFn = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(res(206, full)),
    );
    await fetchWithRetry('http://x/main.mp4', {
      range: { offset: 719, length: 274201 },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const init = fetchFn.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).Range).toBe(
      'bytes=719-274919',
    );
    // A 403 kept by the cache would replay identically on every retry -> must go straight to the network.
    expect(init.cache).toBe('reload');
  });
});

describe('isFatalHttpStatus', () => {
  it('classifies correctly', () => {
    expect(isFatalHttpStatus(403)).toBe(true);
    expect(isFatalHttpStatus(404)).toBe(true);
    expect(isFatalHttpStatus(500)).toBe(false);
    expect(isFatalHttpStatus(429)).toBe(false);
  });
});
