import { defineConfig } from 'wxt';

// Cấu hình WXT cho extension MV3 "Your Video Is Mine".
// Xem https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],

  // Bật WXT sinh file khai báo globals cho ESLint 9+ (flat config): .wxt/eslint-auto-imports.mjs.
  imports: {
    eslintrc: {
      enabled: 9,
    },
  },

  manifest: {
    name: 'Your Video Is Mine',
    description:
      'Phát hiện và tải video (HLS/DASH/progressive) về máy. KHÔNG hỗ trợ nội dung được bảo vệ DRM.',

    // Quyền tối thiểu-đủ-dùng cho MV3 (xem CLAUDE.md để biết lý do từng quyền).
    permissions: [
      'storage',
      'downloads',
      'offscreen',
      'webRequest',
      'declarativeNetRequestWithHostAccess',
      'scripting',
      'tabs',
      'notifications',
    ],
    host_permissions: ['<all_urls>'],

    // CSP: thêm 'wasm-unsafe-eval' để chạy ffmpeg.wasm trong offscreen.
    // MV3 mặc định KHÔNG cho WebAssembly -> phải khai báo tường minh. Vẫn KHÔNG dùng CDN.
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
});
