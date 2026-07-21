import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing';

// Vitest runs unit tests for pure logic (HLS/DASH parser, AES-128 crypto, detect...).
// WxtVitest() loads WXT's auto-imports + fakeBrowser to test code that depends on browser APIs.
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    include: ['**/*.{test,spec}.{ts,tsx}'],
  },
});
