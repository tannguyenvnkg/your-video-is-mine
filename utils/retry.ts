// W2.6 — retry loop for fetching segment/key/init.
//
// WHY SPLIT OUT OF offscreen/main.ts: that file imports ffmpeg.wasm + touches `browser.runtime`
// so vitest cannot load it -> the retry loop (something run hundreds of times per job) never had
// a single test. Splitting the PURE part out here (fetch injected) lets red tests reproduce
// exactly the 4 bugs from §2.9.

/** Error that CANNOT be retried — retrying only burns bandwidth for an identical result. */
export class FatalFetchError extends Error {}

/** Job was cancelled mid-flight — NOT a network error, must not be retried, must not be reported as an "error". */
export class CancelledError extends Error {}

/**
 * Ceiling for waiting on the FIRST RESPONSE (header) of each attempt.
 *
 * ⚠️ THIS IS NOT a ceiling for the whole download, and DELIBERATELY so. A 4K segment can be 20MB;
 * on a slow link it can run for 3 minutes and still be perfectly healthy. Capping by TOTAL time
 * would kill exactly the users with weak networks — the same trap W2.5 avoided with the heartbeat
 * watchdog.
 */
// 15s: the header is only a few hundred bytes so this is pure latency — 15s with no response =
// server is dead, NOT "slow network" (slow network affects body download, which has its own
// separate stall clock).
// Total arithmetic: 4 attempts x 15s + backoff (0.5+1+2) = ~63s until the user sees an error,
// instead of hanging forever.
export const HEADERS_TIMEOUT_MS = 15_000;

/**
 * Mid-transfer STALL ceiling: how long with NO additional bytes received counts as dead.
 *
 * Heartbeat resets on every chunk of bytes -> a slow-but-flowing download never gets cut off
 * unfairly; only a connection that goes COMPLETELY STILL gets aborted. This is the key
 * difference versus plain `AbortSignal.timeout`.
 */
export const STALL_TIMEOUT_MS = 30_000;

/** Number of RETRY attempts (total attempts = retries + 1). */
export const DEFAULT_RETRIES = 3;

/** Exponential backoff: 500ms, 1s, 2s… capped so the last attempt doesn't make the user wait unreasonably. */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 8_000;

/**
 * HTTP codes for which retrying is MEANINGLESS — the server already answered definitively, the
 * next attempt would be identical.
 *
 * VDH fail-fasts on 404/416; we extend it with 401/403/410 because that's the code set real HLS
 * throws at us: an expired signed URL returns 403 and will **never** recover — retrying 4 times
 * only makes the CDN treat us like a scanner (risk of escalating from soft throttle to a hard IP
 * ban, §2.9).
 */
export function isFatalHttpStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 410 ||
    status === 416
  );
}

/** How long to wait BEFORE attempt number `attempt` (attempt 0 = first attempt, no wait). */
export function backoffDelayMs(
  attempt: number,
  base = BACKOFF_BASE_MS,
  max = BACKOFF_MAX_MS,
): number {
  if (attempt <= 0) return 0;
  return Math.min(base * Math.pow(2, attempt - 1), max);
}

/**
 * A CANCELLABLE `setTimeout`. Pressing Cancel while backing off must stop IMMEDIATELY, not make
 * the user sit through the full 8 seconds before seeing a response.
 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError('Đã huỷ'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new CancelledError('Đã huỷ'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Merges the job's cancel signal with the timeout of ONE attempt.
 *
 * `AbortSignal.any` exists since Chrome 116; the extension targets MV3 (Chrome 110+) so a
 * fallback path is still needed — and the fallback path MUST remove its listeners, otherwise
 * every segment leaks a listener on a signal that lives for the whole job (hundreds of segments
 * = hundreds of listeners on the same signal).
 */
export function linkSignals(
  primary: AbortSignal,
  jobSignal?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  if (!jobSignal) return { signal: primary, dispose: () => undefined };
  // ⚠️ Signal ALREADY aborted BEFORE entering here: `addEventListener('abort')` will NEVER fire
  // again (the event already happened) -> the fallback branch would return a dead signal, making
  // cancellation completely ineffective. Must check explicitly. (AbortSignal.any already handles
  // this case correctly; only the fallback branch is broken.)
  if (primary.aborted || jobSignal.aborted) {
    const ac = new AbortController();
    ac.abort(primary.aborted ? primary.reason : jobSignal.reason);
    return { signal: ac.signal, dispose: () => undefined };
  }
  if (typeof AbortSignal.any === 'function') {
    return {
      signal: AbortSignal.any([primary, jobSignal]),
      dispose: () => undefined,
    };
  }
  const ac = new AbortController();
  const onPrimary = (): void => ac.abort(primary.reason);
  const onJob = (): void => ac.abort(jobSignal.reason);
  primary.addEventListener('abort', onPrimary, { once: true });
  jobSignal.addEventListener('abort', onJob, { once: true });
  return {
    signal: ac.signal,
    dispose: () => {
      primary.removeEventListener('abort', onPrimary);
      jobSignal.removeEventListener('abort', onJob);
    },
  };
}

/** Merges a total timeout with the job's cancel signal — used for playlists (a few KB, a total ceiling is reasonable). */
export function timeoutSignal(
  timeoutMs: number,
  jobSignal?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  return linkSignals(AbortSignal.timeout(timeoutMs), jobSignal);
}

export interface ByteRange {
  offset: number;
  length: number;
}

export interface FetchRetryOptions {
  retries?: number;
  range?: ByteRange;
  /** JOB cancel signal (not a timeout) — abort = cancel outright, no retry. */
  signal?: AbortSignal;
  /** Ceiling for waiting on the header. */
  timeoutMs?: number;
  /** Mid-transfer stall ceiling while reading the body. */
  stallMs?: number;
  /** Injected for testing; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Injected for testing; defaults to `abortableSleep`. */
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Name of the thing being downloaded ("segment #12", "AES key", "init") — so error messages say what actually broke. */
  label?: string;
  /** Reports that an attempt just failed and a retry is coming — so the UI doesn't sit frozen and silent for ~1 minute. */
  onRetry?: (info: { attempt: number; total: number; reason: string }) => void;
}

/** Translates a fail-fast code into human terms, including what was being downloaded. */
function explainFatalStatus(status: number, label?: string): string {
  const what = label ? `${label}: ` : '';
  if (status === 403 || status === 401) {
    return `${what}máy chủ từ chối (HTTP ${status}) — link có thể đã hết hạn hoặc site chặn tải`;
  }
  if (status === 404 || status === 410) {
    return `${what}không còn tồn tại trên máy chủ (HTTP ${status})`;
  }
  if (status === 416) {
    return `${what}máy chủ không chấp nhận dải byte đã xin (HTTP 416)`;
  }
  return `${what}HTTP ${status}`;
}

/**
 * Reads the body with a HEARTBEAT: every chunk of bytes that arrives resets the stall clock.
 * Standing still past `stallMs` -> aborts this attempt (retry will handle the rest).
 *
 * No `res.body` (some environments/empty responses) -> falls back to `arrayBuffer()`; the stall
 * clock is still running from when the header was received, so it still cannot hang forever.
 */
async function readWithStallGuard(
  res: Response,
  resetStall: () => void,
): Promise<ArrayBuffer> {
  if (!res.body) return await res.arrayBuffer();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    resetStall(); // <- bytes arrived = still alive
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out.buffer;
}

/**
 * Downloads a segment with a PROPER retry (W2.6): per-attempt timeout, cancellable exponential
 * backoff, fail-fast on unrecoverable codes, and immediately aborts the in-flight request on
 * cancellation.
 *
 * `range` present (W1.3) -> sends a `Range` header instead of downloading the whole file.
 */
export async function fetchWithRetry(
  url: string,
  opts: FetchRetryOptions = {},
): Promise<ArrayBuffer> {
  const {
    retries = DEFAULT_RETRIES,
    range,
    signal,
    timeoutMs = HEADERS_TIMEOUT_MS,
    stallMs = STALL_TIMEOUT_MS,
    fetchFn = fetch,
    sleepFn = abortableSleep,
    label,
    onRetry,
  } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new CancelledError('Đã huỷ');
    if (attempt > 0) {
      // Report BEFORE sleeping: the user is looking at a progress bar that's standing still, they
      // must be told the machine is retrying and not dead (§1.7 — a silent spinner is the worst outcome).
      onRetry?.({
        attempt,
        total: retries + 1,
        reason: describeRetryError(lastErr),
      });
      await sleepFn(backoffDelayMs(attempt), signal);
    }

    // A SEPARATE controller per attempt: the clock (header/stall) aborts only this attempt, while
    // the job's signal aborts everything. Merge both paths into one signal passed to fetch.
    const attemptAc = new AbortController();
    const { signal: attemptSignal, dispose } = linkSignals(
      attemptAc.signal,
      signal,
    );
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      attemptAc.abort(new DOMException('timeout', 'TimeoutError'));
    }, timeoutMs);
    const resetStall = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        attemptAc.abort(new DOMException('timeout', 'TimeoutError'));
      }, stallMs);
    };
    try {
      const res = await fetchFn(url, {
        credentials: 'include',
        signal: attemptSignal,
        // A 403 held by the HTTP cache would be REPLAYED identically on every attempt (and on the
        // later download after the spoof rule is enabled) -> retry becomes a meaningless ritual.
        // Go straight to the network.
        cache: 'reload',
        ...(range
          ? {
              // HTTP Range is CLOSED on both ends: last byte = offset + length - 1.
              headers: {
                Range: `bytes=${range.offset}-${range.offset + range.length - 1}`,
              },
            }
          : {}),
      });
      resetStall(); // header arrived -> switch from the wait-for-header clock to the stall clock
      if (!res.ok) {
        if (isFatalHttpStatus(res.status)) {
          // Fail-fast EXITS IMMEDIATELY, bypassing the "after N attempts" wrapper at the end of
          // the function -> if we only threw "HTTP 403" the user would read exactly those three
          // words and have no idea what's being blocked.
          throw new FatalFetchError(explainFatalStatus(res.status, label));
        }
        throw new Error(`HTTP ${res.status}`);
      }
      // ⚠️ W1.3 TRAP: server IGNORES Range and returns 200 + the WHOLE file. Writing the whole
      // file into a segment's slot = a silently corrupted output file. And since a byterange
      // playlist has hundreds of segments pointing at the SAME file, silently accepting this
      // also means downloading that whole file hundreds of times (measured for real on an Apple
      // fMP4: 27MB x 101 = ~2.8GB). Better to FAIL LOUDLY.
      if (range && res.status !== 206) {
        throw new FatalFetchError(
          `máy chủ không hỗ trợ tải theo đoạn (Range): trả HTTP ${res.status} thay vì 206`,
        );
      }
      const buf = await readWithStallGuard(res, resetStall);
      // ⚠️ RFC 7233 ALLOWS a server/proxy to return a 206 SHORTER than the requested range.
      // Accepting it blindly = a truncated segment, producing a file missing bytes while the job
      // still reports 'done' — exactly the class of silent bug W2.5 just had to patch on the
      // progressive path. Better to FAIL LOUDLY (symmetric with the 200-instead-of-206 guard above).
      if (range && buf.byteLength !== range.length) {
        throw new Error(
          `máy chủ trả thiếu byte cho đoạn đã xin: nhận ${buf.byteLength}, cần ${range.length}`,
        );
      }
      return buf;
    } catch (e) {
      // Job cancelled: NOT a network error, stop immediately, don't burn 3 more attempts.
      if (e instanceof CancelledError) throw e;
      if (signal?.aborted) throw new CancelledError('Đã huỷ');
      // Retrying is meaningless: the server will ignore Range again / return the same code again.
      if (e instanceof FatalFetchError) throw e;
      lastErr = e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      // Every EXIT-DUE-TO-ERROR path leaves behind a partially-read response: without aborting,
      // the socket stays open and bytes keep flowing in (uselessly) while we've moved on to
      // another attempt. Aborting after a successful return is harmless — the request has
      // already completed by then.
      attemptAc.abort();
      dispose();
    }
  }
  throw new Error(
    `Tải ${label ?? 'segment'} lỗi sau ${retries + 1} lần thử: ${describeRetryError(lastErr)}`,
  );
}

/** Describes the last error — AbortSignal.timeout's timeout throws TimeoutError, needs to be phrased in human terms. */
function describeRetryError(e: unknown): string {
  // DO NOT state a specific number here: there are TWO clocks (15s wait-for-header, 30s stall)
  // and this function doesn't know which one just fired. Printing an arbitrary number would lie
  // to the user (measured: e2e printed "timed out after 30s" while the clock that actually
  // expired was the 15s one).
  if (e instanceof DOMException && e.name === 'TimeoutError') {
    return 'máy chủ không phản hồi (quá hạn)';
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
