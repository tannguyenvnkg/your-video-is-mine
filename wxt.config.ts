import { defineConfig } from 'wxt';

// WXT config for the "Your Video Is Mine" MV3 extension.
// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],

  // Enable WXT to generate the globals declaration file for ESLint 9+ (flat config): .wxt/eslint-auto-imports.mjs.
  imports: {
    eslintrc: {
      enabled: 9,
    },
  },

  manifest: {
    name: 'Your Video Is Mine',
    description:
      'Phát hiện và tải video (HLS/DASH/progressive) về máy. KHÔNG hỗ trợ nội dung được bảo vệ DRM.',

    // Minimal-sufficient permissions for MV3 (see CLAUDE.md for the reasoning behind each one).
    permissions: [
      'storage',
      'downloads',
      'offscreen',
      'webRequest',
      'declarativeNetRequestWithHostAccess',
      'scripting',
      'tabs',
      'notifications',
      // W2.7 — periodic tick to detect jobs where offscreen died midway. Use alarms, NOT setInterval:
      // the MV3 service worker can sleep at any time, killing timers with it; an alarm wakes the SW back up.
      'alarms',
    ],
    host_permissions: ['<all_urls>'],

    // CSP: add 'wasm-unsafe-eval' to run ffmpeg.wasm in offscreen.
    // MV3 does NOT allow WebAssembly by default -> must declare it explicitly. Still NOT using a CDN.
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
});
