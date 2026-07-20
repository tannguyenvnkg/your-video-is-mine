// HỢP ĐỒNG NHẮN TIN (W0.1) — test lớp mà 130 test cũ KHÔNG chạm tới.
//
// ⚠️ File này nằm ở `tests/` chứ KHÔNG phải cạnh `entrypoints/background.ts` (khác quy ước
// `utils/*.test.ts` của dự án) vì WXT coi MỌI file trong `entrypoints/` là một entrypoint:
// `background.test.ts` trùng tên với `background.ts` -> `pnpm build` chết với
// "Multiple entrypoints with the same name". Đừng chuyển nó về `entrypoints/`.
//
// Vì sao file này tồn tại: listener `onMessage` từng TRẢ VỀ PROMISE. Đó là hợp đồng của
// webextension-polyfill, KHÔNG phải của Chrome gốc. Chrome chỉ hỗ trợ trả Promise từ bản 148,
// và còn "rolling out gradually" -> máy dev (Edge 150) chạy ngon trong khi máy user cũ hơn
// nhận về `undefined`. Chrome docs: `return true` chạy "whether this capability is enabled or not".
//
// => MỌI nhánh async PHẢI trả `true` ĐỒNG BỘ rồi gọi `sendResponse` sau. Test này ghim điều đó.
//
// Cách test: `defineBackground(fn)` chỉ trả `{ main: fn }` (không tự chạy), nên ta gọi `main()`
// để đăng ký listener rồi TỰ GỌI listener với ĐỦ 3 THAM SỐ. Phải tự gọi vì fakeBrowser mô phỏng
// hợp đồng polyfill (chỉ truyền 2 tham số, không có `sendResponse`) — dùng `.trigger()` sẽ đo
// nhầm thứ cần đo.

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
 * fakeBrowser KHÔNG cài đặt webRequest (gọi vào là ném "not implemented"). Ta chỉ đo hợp đồng
 * nhắn tin nên vô hiệu hoá các đăng ký listener khác — nếu không, test sẽ đỏ vì hạ tầng test
 * thiếu API chứ không phải vì lỗi thật, và như thế thì nó chẳng chứng minh được gì.
 */
function stubUnrelatedListeners(): void {
  const events = [
    browser.webRequest?.onBeforeRequest,
    browser.webRequest?.onHeadersReceived,
    // W2.1 — listener bắt header thật của player. fakeBrowser cũng không cài đặt cái này.
    browser.webRequest?.onSendHeaders,
    browser.downloads?.onChanged,
    browser.storage?.onChanged,
    browser.tabs?.onRemoved,
  ];
  for (const ev of events) {
    if (ev) vi.spyOn(ev, 'addListener').mockImplementation(() => undefined);
  }
  // `download/cancel` gọi thẳng browser.downloads.cancel ở thân listener (không bọc try/catch),
  // mà fakeBrowser ném ĐỒNG BỘ trong khi Chrome thật trả Promise -> stub cho giống thật.
  // (Không cần stub downloads.download: handleDownload đã tự bọc try/catch.)
  vi.spyOn(browser.downloads, 'cancel').mockResolvedValue(undefined);
}

/** Chạy main() và lấy ra listener THẬT đã đăng ký. */
function registerBackground(): MessageListener {
  stubUnrelatedListeners();
  const spy = vi.spyOn(browser.runtime.onMessage, 'addListener');
  background.main!();
  const listener = spy.mock.calls[0]?.[0] as unknown as MessageListener;
  expect(listener, 'background phải đăng ký onMessage listener').toBeTypeOf(
    'function',
  );
  return listener;
}

/** Đợi microtask/timer để sendResponse kịp bắn. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

// Mọi `kind` mà popup/options GỬI ĐI RỒI CHỜ CÂU TRẢ LỜI. Đây là danh sách phải giữ đồng bộ với
// utils/messages.ts: thiếu một dòng ở đây = một nhánh async lọt lưới.
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

describe('background onMessage — hợp đồng Chrome gốc (W0.1)', () => {
  let listener: MessageListener;

  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    // Chặn mọi request thật ra internet trong unit test.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('#EXTM3U', { status: 200 })),
    );
    listener = registerBackground();
  });

  it.each(ASYNC_KINDS)(
    '$name trả về `true` ĐỒNG BỘ (không phải Promise)',
    ({ message }) => {
      const sendResponse = vi.fn();
      const ret = listener(message, SENDER, sendResponse);

      // Đây là dòng bắt được lỗi: code cũ trả Promise -> Chrome <148 đóng kênh, popup nhận undefined.
      expect(ret).toBe(true);
      expect(ret).not.toBeInstanceOf(Promise);
    },
  );

  it.each(ASYNC_KINDS)(
    '$name thực sự gọi sendResponse',
    async ({ message }) => {
      const sendResponse = vi.fn();
      listener(message, SENDER, sendResponse);
      await flush();
      expect(sendResponse).toHaveBeenCalledTimes(1);
      // Câu trả lời phải là object (không undefined) -> popup cast được.
      expect(sendResponse.mock.calls[0]![0]).toBeTypeOf('object');
    },
  );

  it('handler ném lỗi -> vẫn sendResponse {ok:false} chứ không treo kênh', async () => {
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

  it('message của offscreen (target:offscreen) -> KHÔNG chiếm kênh', () => {
    const sendResponse = vi.fn();
    const ret = listener(
      { target: 'offscreen', kind: 'engine/selftest' },
      SENDER,
      sendResponse,
    );
    // Trả true ở đây = background cướp kênh của offscreen -> offscreen không trả lời được.
    expect(ret).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('message lạ -> KHÔNG chiếm kênh', () => {
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
    '$name là fire-and-forget -> trả undefined (không giữ kênh chờ)',
    ({ message }) => {
      const sendResponse = vi.fn();
      expect(listener(message, SENDER, sendResponse)).toBeUndefined();
    },
  );
});
