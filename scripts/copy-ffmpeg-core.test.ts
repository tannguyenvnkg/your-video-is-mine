import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Vì sao core BẮT BUỘC phải là bản ESM (không phải UMD):
// @ffmpeg/ffmpeg spawn worker LUÔN với type:"module" (dist/esm/classes.js — cả nhánh
// classWorkerURL lẫn nhánh mặc định). Module worker KHÔNG có importScripts() -> thư viện rơi
// vào catch rồi chạy `self.createFFmpegCore = (await import(coreURL)).default` (dist/esm/worker.js).
// Bản UMD kết thúc bằng module.exports/define/exports — KHÔNG có `export default` -> `.default`
// là undefined -> worker ném ERROR_IMPORT_FAILURE = "failed to import ffmpeg-core.js".

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreJs = resolve(root, 'public/ffmpeg/ffmpeg-core.js');
const coreWasm = resolve(root, 'public/ffmpeg/ffmpeg-core.wasm');

describe('ffmpeg core đóng gói trong public/ffmpeg', () => {
  it('tồn tại (sinh bởi scripts/copy-ffmpeg-core.mjs)', () => {
    expect(existsSync(coreJs), `Thiếu ${coreJs} — chạy: pnpm copy:ffmpeg`).toBe(
      true,
    );
    expect(existsSync(coreWasm)).toBe(true);
  });

  it('là bản ESM có `export default` — thứ module worker cần', () => {
    expect(readFileSync(coreJs, 'utf8')).toContain(
      'export default createFFmpegCore',
    );
  });

  it('KHÔNG phải bản UMD (module.exports/define -> .default undefined -> lỗi import)', () => {
    expect(readFileSync(coreJs, 'utf8')).not.toContain(
      "typeof define === 'function' && define['amd']",
    );
  });
});
