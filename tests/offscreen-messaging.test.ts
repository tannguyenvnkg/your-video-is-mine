// HỢP ĐỒNG NHẮN TIN CỦA OFFSCREEN (W0.1) — nửa còn lại của bản sửa.
//
// Vì sao file này PHẢI tồn tại: review đối kháng đã CHỨNG MINH bằng thực nghiệm rằng hai nửa
// KHÔNG đối xứng. Nhét `async` vào listener của background -> 12 test đỏ (bắt được). Nhét đúng
// lỗi đó vào listener của offscreen -> compile + lint + toàn bộ test **XANH HẾT** (không ai thấy).
// Tệ hơn: khi listener bị đánh dấu `async`, chính tsc gợi ý "Did you mean to write
// 'Promise<true | undefined>'?" — làm theo gợi ý đó thì mọi cổng xanh trong khi hợp đồng đã hỏng.
//
// Và đây đúng là file có tiền sử tệ nhất dự án: giả định sai về `chrome.storage` ở đây từng sống
// sót qua MỌI cổng tĩnh kể từ commit đầu tiên. Nên nó phải được ghim.
//
// (Để ở `tests/` chứ không phải `entrypoints/` — xem tests/background-messaging.test.ts.)

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { browser } from 'wxt/browser';

// W3.1 — Worker ghép video không dựng được trong Node (không có OPFS/SyncAccessHandle), và ta
// KHÔNG đo việc ghép ở đây, chỉ đo HỢP ĐỒNG NHẮN TIN. Nên thay `MuxSession` bằng bản giả.
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
 * offscreen/main.ts đăng ký listener NGAY LÚC IMPORT -> phải cài spy TRƯỚC khi import, và
 * resetModules() để mỗi lần lấy lại là một lần đăng ký mới.
 */
async function loadOffscreenListener(): Promise<MessageListener> {
  vi.resetModules();
  const spy = vi.spyOn(browser.runtime.onMessage, 'addListener');
  await import('../entrypoints/offscreen/main');
  const listener = spy.mock.calls[0]?.[0] as unknown as MessageListener;
  expect(listener, 'offscreen phải đăng ký onMessage listener').toBeTypeOf(
    'function',
  );
  return listener;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('offscreen onMessage — hợp đồng Chrome gốc (W0.1)', () => {
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

  it('engine/selftest trả `true` ĐỒNG BỘ rồi mới sendResponse', async () => {
    const sendResponse = vi.fn();
    const ret = listener(
      { target: 'offscreen', kind: 'engine/selftest' },
      {},
      sendResponse,
    );

    // Dòng bắt lỗi: trả Promise -> Chrome <148 đóng kênh -> nút kiểm tra bộ ghép treo mãi.
    expect(ret).toBe(true);
    expect(ret).not.toBeInstanceOf(Promise);

    await flush();
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse.mock.calls[0]![0]).toBeTypeOf('object');
  });

  it('message KHÔNG phải của offscreen -> trả undefined (không cướp kênh của background)', () => {
    const sendResponse = vi.fn();
    // Cả background lẫn offscreen đều nhận MỌI runtime message. Nếu offscreen trả `true` ở đây,
    // nó cướp kênh và câu trả lời thật của background bị mất.
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
  ])('$name là fire-and-forget -> trả undefined', ({ message }) => {
    const sendResponse = vi.fn();
    expect(listener(message, {}, sendResponse)).toBeUndefined();
  });
});
