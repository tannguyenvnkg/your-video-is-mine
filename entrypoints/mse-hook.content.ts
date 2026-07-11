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
