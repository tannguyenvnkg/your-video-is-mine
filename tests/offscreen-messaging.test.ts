// OFFSCREEN MESSAGING CONTRACT (W0.1) — the other half of the fix.
//
// Why this file MUST exist: adversarial review PROVED empirically that the two halves are
// NOT symmetric. Sticking `async` on the background listener -> 12 tests turn red (caught).
// Sticking that exact same bug on the offscreen listener -> compile + lint + every test
// stays **ALL GREEN** (nobody notices). Worse: when the listener gets marked `async`, tsc
// itself suggests "Did you mean to write 'Promise<true | undefined>'?" — follow that
// suggestion and every gate stays green while the contract is broken.
//
// And this really is the file with the worst track record in the project: the wrong
// assumption about `chrome.storage` here survived EVERY static gate since the first commit.
// So it has to be pinned down.
//
// (Lives in `tests/`, not `entrypoints/` — see tests/background-messaging.test.ts.)

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { browser } from 'wxt/browser';

// W3.1 — The mux worker can't build in Node (no OPFS/SyncAccessHandle), and we're NOT
// measuring muxing here, only the MESSAGING CONTRACT. So swap `MuxSession` for a fake.
vi.mock('@/entrypoints/offscreen/libav-mux', () => ({
  MuxSession: {
    start: async () => ({
      appendSegment: async () => undefined,
      mux: async () => ({
        outName: 'x.mp4',
        outBytes: 1,
        packets: 1,
        seams: 0,
        moovAtFront: true,
        attempts: 1,
      }),
      cleanup: async () => undefined,
      cancel: async () => undefined,
      dispose: () => undefined,
    }),
    openOutput: async () => new Blob([new Uint8Array([0])]),
  },
  MuxCancelledError: class extends Error {},
  removeOpfsFile: async () => undefined,
  sweepOrphanOpfsFiles: async () => 0,
}));

type SendResponse = (response?: unknown) => void;
type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: SendResponse,
) => unknown;

/**
 * offscreen/main.ts registers its listener AT IMPORT TIME -> the spy must be installed
 * BEFORE importing, and resetModules() ensures each fetch is a fresh registration.
 */
async function loadOffscreenListener(): Promise<MessageListener> {
  vi.resetModules();
  const spy = vi.spyOn(browser.runtime.onMessage, 'addListener');
  await import('../entrypoints/offscreen/main');
  const listener = spy.mock.calls[0]?.[0] as unknown as MessageListener;
  expect(listener, 'offscreen must register an onMessage listener').toBeTypeOf(
    'function',
  );
  return listener;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('offscreen onMessage — vanilla Chrome contract (W0.1)', () => {
  let listener: MessageListener;

  beforeEach(async () => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('#EXTM3U', { status: 200 })),
    );
    listener = await loadOffscreenListener();
  });

  it('engine/selftest returns `true` SYNCHRONOUSLY, then sendResponse later', async () => {
    const sendResponse = vi.fn();
    const ret = listener(
      { target: 'offscreen', kind: 'engine/selftest' },
      {},
      sendResponse,
    );

    // Line that catches the bug: returning a Promise -> Chrome <148 closes the channel -> the mux self-test button hangs forever.
    expect(ret).toBe(true);
    expect(ret).not.toBeInstanceOf(Promise);

    await flush();
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse.mock.calls[0]![0]).toBeTypeOf('object');
  });

  it("message NOT meant for offscreen -> returns undefined (does not steal background's channel)", () => {
    const sendResponse = vi.fn();
    // Both background and offscreen receive EVERY runtime message. If offscreen returns
    // `true` here, it steals the channel and background's real response is lost.
    expect(
      listener(
        { kind: 'hls/progress', jobId: 'j', patch: {} },
        {},
        sendResponse,
      ),
    ).toBeUndefined();
    expect(
      listener({ kind: 'manifest/variants' }, {}, sendResponse),
    ).toBeUndefined();
    expect(listener(null, {}, sendResponse)).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'hls/cancel',
      message: { target: 'offscreen', kind: 'hls/cancel', jobId: 'j1' },
    },
    {
      name: 'revoke',
      message: { target: 'offscreen', kind: 'revoke', url: 'blob:x' },
    },
  ])('$name is fire-and-forget -> returns undefined', ({ message }) => {
    const sendResponse = vi.fn();
    expect(listener(message, {}, sendResponse)).toBeUndefined();
  });
});
