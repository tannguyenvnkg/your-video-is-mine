import { singleFlight } from '@/utils/liveness';
import { describeError } from '@/utils/errors';
import type { EngineSelfTestResponse } from '@/utils/messages';

async function handleEngineSelfTest(): Promise<EngineSelfTestResponse> {
  try {
    await ensureOffscreen();
    const res = await browser.runtime.sendMessage({
      target: 'offscreen',
      kind: 'engine/selftest',
    });
    // W2.7 — if offscreen is dead/hasn't registered its listener, `sendMessage` resolves to
    // UNDEFINED instead of throwing. Returning that straight through hands `undefined` to the popup
    // -> the test button stays silent, saying nothing at all.
    // This function's contract is to ALWAYS return a readable object.
    if (!res || typeof res !== 'object') {
      return {
        ok: false,
        error:
          'Bộ xử lý video không trả lời (có thể đã bị trình duyệt thu hồi).',
      };
    }
    return res as EngineSelfTestResponse;
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Không chạy được offscreen.',
    };
  }
}

/**
 * W2.7 — is the offscreen document currently ALIVE?
 *
 * `getContexts` asks the browser directly, unlike the old approach of "just send and see if it
 * throws": offscreen being dead is a NORMAL BRANCH to handle, not an unexpected rejection.
 * (API available since Chrome 116; if missing, return `true` to preserve the old behavior instead of
 * blocking unjustly.)
 */
async function isOffscreenAlive(): Promise<boolean> {
  const rt = browser.runtime as typeof browser.runtime & {
    getContexts?: (f: {
      contextTypes: string[];
    }) => Promise<{ length: number }[]>;
  };
  if (typeof rt.getContexts !== 'function') return true;
  try {
    const ctxs = await rt.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctxs.length > 0;
  } catch {
    return true; // API failed -> don't block unjustly, just try sending as before.
  }
}

/**
 * W2.7 — send a message to offscreen, NEVER throws and never creates an unhandled rejection.
 *
 * Returns `true` if offscreen actually received it. Before W2.7, two call sites (`hls/cancel`,
 * `revoke`) called `sendMessage` bare without `.catch` -> a dead offscreen produced an unhandled
 * rejection, and worse, the caller still assumed the message had arrived.
 */
export async function sendToOffscreen(
  msg: Record<string, unknown>,
): Promise<boolean> {
  if (!(await isOffscreenAlive())) return false;
  try {
    await browser.runtime.sendMessage({ target: 'offscreen', ...msg });
    return true;
  } catch (e) {
    // Common case: offscreen just died BETWEEN the alive check and the send (a race), or hasn't
    // registered its listener yet. Not a fatal error — the caller decides what to do based on `false`.
    console.warn('[bg] không gửi được tin sang offscreen:', describeError(e));
    return false;
  }
}

/**
 * W2.7 — `singleFlight` kills the race "two jobs both call createDocument".
 *
 * Before W2.7: two `handleHlsDownload` calls close together -> both enter `createDocument`; the
 * second one throws "single offscreen document" which was then SWALLOWED as if normal, so it fired
 * `hls/run` at a document that MIGHT not have finished registering its listener -> the job stayed
 * stuck at 'queued' forever, with no error line at all. Now the second call awaits the FIRST call's
 * exact promise, so by the time it proceeds the document is ready.
 */
export const ensureOffscreen = singleFlight(async (): Promise<void> => {
  // Check first: if already alive, no need to touch createDocument (no need to catch an "already
  // exists" error just for fun).
  if (await isOffscreenAlive()) return;
  try {
    await browser.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification:
        'Chạy libav.wasm để ghép/remux video và tạo blob URL để tải.',
    });
  } catch (e) {
    // Each extension only gets 1 offscreen document -> "already exists" is NORMAL, ignore it.
    // Every other error (document creation genuinely failing) MUST be rethrown: swallowing it all
    // would make the caller believe offscreen is alive, and the job would hang forever with no explanation.
    if (!/single offscreen document/i.test(describeError(e))) throw e;
  }
});

export { handleEngineSelfTest };
