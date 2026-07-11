import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing';

// Vitest chạy unit test cho logic thuần (parser HLS/DASH, crypto AES-128, detect...).
// WxtVitest() nạp auto-imports của WXT + fakeBrowser để test code phụ thuộc browser API.
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    include: ['**/*.{test,spec}.{ts,tsx}'],
  },
});
