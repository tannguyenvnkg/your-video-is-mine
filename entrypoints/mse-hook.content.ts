// Content script chạy trong MAIN world (ngữ cảnh trang) để truy cập window.MediaSource THẬT.
// Mục đích:
//  - Phát hiện player MSE/blob tự chế (URL thật bị giấu) qua hook URL.createObjectURL(MediaSource).
//  - Bỏ qua chặn UI: khôi phục chuột phải / bôi chọn / kéo thả bị trang chặn.
// KHÔNG dùng chrome API ở đây (MAIN world không có) -> báo về content script isolated qua
// window.postMessage; isolated sẽ forward tới background.
//
// Ghi chú: đây là PHÁT HIỆN. Việc dựng lại stream từ appendBuffer (bắt toàn bộ byte) rất nặng
// và dễ vỡ -> để dành nâng cao; ở đây chỉ báo hiệu để user biết trang dùng MSE.

export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: true,
  main() {
    const TAG = 'yvim-mse';
    const post = (payload: Record<string, unknown>) => {
      try {
        window.postMessage({ __yvim: TAG, ...payload }, '*');
      } catch {
        // ignore
      }
    };

    // Hook URL.createObjectURL: bắt blob URL tạo từ MediaSource (dấu hiệu player MSE).
    try {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = ((
        obj: MediaSource | Blob | MediaStream,
      ): string => {
        const url = orig(obj as Blob);
        try {
          if (
            typeof MediaSource !== 'undefined' &&
            obj instanceof MediaSource
          ) {
            post({ kind: 'mse-detected', url });
          }
        } catch {
          // ignore
        }
        return url;
      }) as typeof URL.createObjectURL;
    } catch {
      // ignore
    }

    // ---- Sniff manifest HLS/DASH bị nguỵ trang (URL/đuôi/Content-Type giả) ----
    // MV3 webRequest KHÔNG đọc được body -> mù với manifest giả đuôi (.jpg) / Content-Type giả.
    // Nhưng player LUÔN phải fetch một playlist "#EXTM3U" (HLS) hoặc "<MPD" (DASH).
    // => Hook fetch/XHR, đọc ~256 byte ĐẦU của response để nhận diện, rồi báo URL thật về isolated.
    const seen = new Set<string>();

    // Nhận diện loại manifest từ phần đầu nội dung (đã cắt ~256 ký tự).
    const sniffManifest = (head: string): 'hls' | 'dash' | null => {
      const s = head.trimStart();
      if (s.startsWith('#EXTM3U')) return 'hls';
      // DASH: tài liệu XML có phần tử gốc <MPD>.
      if ((s.startsWith('<?xml') || s.startsWith('<MPD')) && s.includes('MPD')) {
        return 'dash';
      }
      return null;
    };

    // Báo manifest (dedupe theo URL tuyệt đối).
    const reportManifest = (rawUrl: string, mediaType: 'hls' | 'dash') => {
      try {
        const url = new URL(rawUrl, location.href).href;
        if (seen.has(url)) return;
        seen.add(url);
        post({ kind: 'manifest', url, mediaType });
      } catch {
        // ignore
      }
    };

    // Hook window.fetch: clone response, đọc CHUNK ĐẦU rồi cancel (không tiêu thụ body của player).
    try {
      const origFetch = window.fetch.bind(window);
      window.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const res = await origFetch(input, init);
        try {
          const reqUrl =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          if (reqUrl && res.body) {
            const clone = res.clone();
            // Fire-and-forget: KHÔNG chặn response trả về cho player.
            void (async () => {
              try {
                const reader = clone.body?.getReader();
                if (!reader) return;
                const { value } = await reader.read();
                void reader.cancel();
                if (value && value.byteLength > 0) {
                  const head = new TextDecoder().decode(value.subarray(0, 256));
                  const t = sniffManifest(head);
                  if (t) reportManifest(reqUrl, t);
                }
              } catch {
                // ignore
              }
            })();
          }
        } catch {
          // ignore
        }
        return res;
      }) as typeof window.fetch;
    } catch {
      // ignore
    }

    // Hook XMLHttpRequest: lưu URL ở open(), kiểm 256 ký tự đầu responseText khi load xong.
    try {
      const XHRProto = XMLHttpRequest.prototype;
      const origOpen = XHRProto.open;
      XHRProto.open = function (
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        isAsync?: boolean,
        username?: string | null,
        password?: string | null,
      ) {
        try {
          (this as XMLHttpRequest & { __yvimUrl?: string }).__yvimUrl =
            typeof url === 'string' ? url : url.href;
        } catch {
          // ignore
        }
        // Mặc định async = true (đúng hành vi XHR khi bỏ tham số).
        return origOpen.call(this, method, url, isAsync ?? true, username, password);
      } as typeof XHRProto.open;

      const origSend = XHRProto.send;
      XHRProto.send = function (
        this: XMLHttpRequest,
        body?: Document | XMLHttpRequestBodyInit | null,
      ) {
        try {
          this.addEventListener('load', () => {
            try {
              // responseText chỉ đọc được khi responseType là '' hoặc 'text'.
              if (this.responseType === '' || this.responseType === 'text') {
                const text = this.responseText;
                if (text) {
                  const t = sniffManifest(text.slice(0, 256));
                  const u = (this as XMLHttpRequest & { __yvimUrl?: string })
                    .__yvimUrl;
                  if (t && u) reportManifest(u, t);
                }
              }
            } catch {
              // ignore
            }
          });
        } catch {
          // ignore
        }
        return origSend.call(this, body);
      } as typeof XHRProto.send;
    } catch {
      // ignore
    }

    // Bỏ qua chặn UI: khôi phục chuột phải + bôi chọn bị trang chặn.
    // CHỈ contextmenu + selectstart (KHÔNG đụng copy/dragstart để tránh phá app không phải video).
    const reenable = (e: Event) => {
      e.stopImmediatePropagation();
    };
    for (const ev of ['contextmenu', 'selectstart']) {
      window.addEventListener(ev, reenable, true);
    }
  },
});
