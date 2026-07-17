// Đóng gói @ffmpeg/core (single-thread, ESM) vào public/ffmpeg/ để load LOCAL trong offscreen.
// KHÔNG dùng CDN (CSP MV3 chặn). File public/ được WXT copy vào bản build; offscreen (trang
// extension) truy cập qua chrome.runtime.getURL. public/ffmpeg/ nằm trong .gitignore (32MB wasm,
// sinh lại từ node_modules khi cài).
//
// PHẢI lấy bản ESM, KHÔNG phải UMD: @ffmpeg/ffmpeg spawn worker luôn với type:"module", mà module
// worker không có importScripts() -> nó nạp core bằng `(await import(coreURL)).default`. Bản UMD
// không có `export default` -> .default undefined -> "failed to import ffmpeg-core.js".
// Ràng buộc này được khoá bởi scripts/copy-ffmpeg-core.test.ts.

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(root, 'node_modules/@ffmpeg/core/dist/esm');
const outDir = resolve(root, 'public/ffmpeg');
const files = ['ffmpeg-core.js', 'ffmpeg-core.wasm'];

if (!existsSync(resolve(srcDir, files[0]))) {
  console.warn(
    '[copy-ffmpeg-core] Bỏ qua: chưa thấy @ffmpeg/core trong node_modules (chạy pnpm install trước).',
  );
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
for (const f of files) {
  const from = resolve(srcDir, f);
  const to = resolve(outDir, f);
  copyFileSync(from, to);
  const mb = (statSync(to).size / (1024 * 1024)).toFixed(1);
  console.log(`[copy-ffmpeg-core] ${f} -> public/ffmpeg/ (${mb} MB)`);
}
