// MESSAGING CONTRACT (W0.1) — a test layer the old 130 tests never touched.
//
// Warning: this file lives in `tests/` instead of next to `entrypoints/background.ts`
// (unlike the project's `utils/*.test.ts` convention) because WXT treats EVERY file under
// `entrypoints/` as an entrypoint: `background.test.ts` would collide with `background.ts` ->
// `pnpm build` dies with "Multiple entrypoints with the same name". Don't move it there.
//
// Why this file exists: the `onMessage` listener used to RETURN A PROMISE. That's the contract
// of webextension-polyfill, NOT of vanilla Chrome. Chrome only supports returning a Promise
// from version 148, and it's still "rolling out gradually" -> dev machine (Edge 150) runs fine
// while an older user machine gets back `undefined`. Chrome docs: `return true` works
// "whether this capability is enabled or not".
//
// => EVERY async branch MUST return `true` SYNCHRONOUSLY, then call `sendResponse` later.
// This test pins that down.
//
// How the test works: `defineBackground(fn)` just returns `{ main: fn }` (doesn't auto-run),
// so we call `main()` to register the listener, then CALL THE LISTENER OURSELVES with ALL 3
// PARAMETERS. We must call it manually because fakeBrowser simulates the polyfill contract
// (passes only 2 params, no `sendResponse`) — using `.trigger()` would measure the wrong thing.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { browser } from 'wxt/browser';
import background from '../entrypoints/background';

type SendResponse = (response?: unknown) => void;
type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: SendResponse,
) => unknown;

const SENDER = { tab: { id: 1, url: 'https://example.com/watch', title: 'T' } };

/**
 * fakeBrowser does NOT implement webRequest (calling into it throws "not implemented"). We
 * only measure the messaging contract here, so we neutralize the other listener registrations
 * — otherwise the test would fail because the test infrastructure lacks the API, not because
 * of a real bug, which would prove nothing.
 */
function stubUnrelatedListeners(): void {
  const events = [
    browser.webRequest?.onBeforeRequest,
    browser.webRequest?.onHeadersReceived,
    // W2.1 — listener that captures the player's real headers. fakeBrowser doesn't implement this either.
    browser.webRequest?.onSendHeaders,
    browser.downloads?.onChanged,
    browser.storage?.onChanged,
    browser.tabs?.onRemoved,
  ];
  for (const ev of events) {
    if (ev) vi.spyOn(ev, 'addListener').mockImplementation(() => undefined);
  }
  // `download/cancel` calls browser.downloads.cancel directly in the listener body (no
  // try/catch), and fakeBrowser throws SYNCHRONOUSLY while real Chrome returns a Promise ->
  // stub it to match reality.
  // (No need to stub downloads.download: handleDownload already wraps itself in try/catch.)
  vi.spyOn(browser.downloads, 'cancel').mockResolvedValue(undefined);
}

/** Run main() and get the ACTUAL registered listener. */
function registerBackground(): MessageListener {
  stubUnrelatedListeners();
  const spy = vi.spyOn(browser.runtime.onMessage, 'addListener');
  background.main!();
  const listener = spy.mock.calls[0]?.[0] as unknown as MessageListener;
  expect(listener, 'background must register an onMessage listener').toBeTypeOf(
    'function',
  );
  return listener;
}

/** Wait for a microtask/timer so sendResponse has time to fire. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

// Every `kind` that popup/options SENDS AND THEN WAITS FOR A RESPONSE. This list must stay in
// sync with utils/messages.ts: missing a line here = an async branch slipping through the net.
const ASYNC_KINDS: Array<{ name: string; message: Record<string, unknown> }> = [
  {
    name: 'manifest/variants',
    message: {
      kind: 'manifest/variants',
      url: 'https://cdn.example.com/master.m3u8',
      mediaType: 'hls',
    },
  },
  {
    name: 'download/progressive',
    message: {
      kind: 'download/progressive',
      url: 'https://cdn.example.com/v.mp4',
      tabId: 1,
    },
  },
  { name: 'engine/selftest', message: { kind: 'engine/selftest' } },
  {
    name: 'hls/estimate',
    message: {
      kind: 'hls/estimate',
      variantUrl: 'https://cdn.example.com/media.m3u8',
    },
  },
  {
    name: 'hls/download',
    message: {
      kind: 'hls/download',
      variantUrl: 'https://cdn.example.com/media.m3u8',
      mediaUrl: 'https://cdn.example.com/master.m3u8',
      tabId: 1,
    },
  },
  {
    name: 'hls/progress',
    message: {
      kind: 'hls/progress',
      jobId: 'j1',
      patch: { phase: 'fetching' },
    },
  },
  {
    name: 'download/progress',
    message: {
      kind: 'download/progress',
      key: 'k1',
      patch: { bytesReceived: 10 },
    },
  },
];

describe('background onMessage — vanilla Chrome contract (W0.1)', () => {
  let listener: MessageListener;

  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    // Block any real network request during the unit test.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('#EXTM3U', { status: 200 })),
    );
    listener = registerBackground();
  });

  it.each(ASYNC_KINDS)(
    '$name returns `true` SYNCHRONOUSLY (not a Promise)',
    ({ message }) => {
      const sendResponse = vi.fn();
      const ret = listener(message, SENDER, sendResponse);

      // This is the line that catches the bug: old code returned a Promise -> Chrome <148 closes the channel, popup gets undefined.
      expect(ret).toBe(true);
      expect(ret).not.toBeInstanceOf(Promise);
    },
  );

  it.each(ASYNC_KINDS)(
    '$name actually calls sendResponse',
    async ({ message }) => {
      const sendResponse = vi.fn();
      listener(message, SENDER, sendResponse);
      await flush();
      expect(sendResponse).toHaveBeenCalledTimes(1);
      // The response must be an object (not undefined) so popup can cast it.
      expect(sendResponse.mock.calls[0]![0]).toBeTypeOf('object');
    },
  );

  it('handler throws -> still sendResponse {ok:false} instead of hanging the channel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('mạng chết');
      }),
    );
    const sendResponse = vi.fn();
    const ret = listener(
      {
        kind: 'manifest/variants',
        url: 'https://cdn.example.com/master.m3u8',
        mediaType: 'hls',
      },
      SENDER,
      sendResponse,
    );
    expect(ret).toBe(true);
    await flush();
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse.mock.calls[0]![0]).toMatchObject({ ok: false });
  });

  it('message for offscreen (target:offscreen) -> does NOT claim the channel', () => {
    const sendResponse = vi.fn();
    const ret = listener(
      { target: 'offscreen', kind: 'engine/selftest' },
      SENDER,
      sendResponse,
    );
    // Returning true here = background steals offscreen's channel -> offscreen can't respond.
    expect(ret).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('unknown message -> does NOT claim the channel', () => {
    const sendResponse = vi.fn();
    expect(listener({ hello: 'world' }, SENDER, sendResponse)).toBeUndefined();
    expect(listener(null, SENDER, sendResponse)).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'media/dom', message: { kind: 'media/dom', candidates: [] } },
    {
      name: 'media/mse',
      message: { kind: 'media/mse', url: 'blob:https://example.com/x' },
    },
    { name: 'hls/cancel', message: { kind: 'hls/cancel', jobId: 'j1' } },
    {
      name: 'download/cancel',
      message: { kind: 'download/cancel', key: 'k1' },
    },
  ])(
    '$name is fire-and-forget -> returns undefined (does not hold the channel open)',
    ({ message }) => {
      const sendResponse = vi.fn();
      expect(listener(message, SENDER, sendResponse)).toBeUndefined();
    },
  );
});
