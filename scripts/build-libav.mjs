// Dựng lại variant libav.js `ts2mp4d` từ mã nguồn và đặt kết quả vào vendor/libav/.
//
// Bình thường KHÔNG cần chạy script này: kết quả đã được commit sẵn trong public/libav/.
// Chỉ chạy khi nâng cấp libav.js hoặc đổi danh sách component — và khi đó phải commit lại
// binary mới kèm cập nhật public/libav/BUILD.md.
//
// Nghĩa vụ LGPL-2.1: script này CHÍNH LÀ "the scripts used to control compilation" mà
// giấy phép bắt phải công bố kèm binary. Đừng xoá nó chỉ vì thường ngày không ai chạy.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public/libav');

const VARIANT = 'ts2mp4d';
const LIBAV_VER = '6.9.8.1';

// Giữ ĐỒNG BỘ với public/libav/config.json. Hai chỗ phải khớp, và
// scripts/libav-vendor.test.ts khoá lại điều đó.
const COMPONENTS = [
  'avformat',
  'avcodec',
  // BẮT BUỘC: thiếu fragment này thì bsf được biên dịch vào libavcodec nhưng KHÔNG
  // export hàm av_bsf_* nào sang JS -> gọi tới là undefined.
  'avbsf',
  'demuxer-mpegts',
  'format-mp4',
  'parser-h264',
  'parser-aac',
  // BẮT BUỘC dù ta chỉ stream-copy: thiếu nó avformat_find_stream_info không xác định
  // nổi sample_rate/channels của AAC -> mp4 muxer chết "sample rate not set".
  'decoder-aac',
  'bsf-extract_extradata',
  'bsf-aac_adtstoasc',
  'bsf-h264_mp4toannexb',
];

const srcDir = process.env.LIBAV_SRC;
if (!srcDir || !existsSync(srcDir)) {
  console.error(
    [
      '[build-libav] Cần mã nguồn libav.js.',
      '',
      '  1) Tải tarball npm và giải nén:  npm pack libav.js@6.9.8 && tar xzf libav.js-6.9.8.tgz',
      '  2) Giải nén tiếp package/sources/libav.js.tar.xz để lấy cây nguồn',
      '  3) Chạy lại với:  LIBAV_SRC=/đường/dẫn/tới/libav.js pnpm build:libav',
      '',
      'Cần sẵn emsdk 6.0.3 đã activate (emcc phải nằm trong PATH).',
    ].join('\n'),
  );
  process.exit(1);
}

try {
  execFileSync('emcc', ['--version'], { stdio: 'pipe' });
} catch {
  console.error(
    '[build-libav] Không thấy `emcc`. Cài emsdk rồi `source ./emsdk_env.sh`.',
  );
  process.exit(1);
}

// 🔴 Bẫy macOS: mk/ffmpeg.mk truyền --ranlib=emranlib nhưng QUÊN --ar=emar, nên configure
// lấy `ar` của Apple. Nó tạo archive rỗng 96 byte trong im lặng, và lỗi chỉ lộ ra tận lúc
// link dưới dạng hàng chục dòng "wasm-ld: symbol exported via --export not found".
// Chèn shim ar -> emar vào đầu PATH để tránh. Trên Linux/CI không cần nhưng vô hại.
const shimDir = resolve(root, 'node_modules/.cache/libav-arfix');
mkdirSync(shimDir, { recursive: true });
const shim = resolve(shimDir, 'ar');
writeFileSync(shim, '#!/bin/sh\nexec emar "$@"\n');
chmodSync(shim, 0o755);
const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}` };

console.log(`[build-libav] Khai báo variant ${VARIANT}...`);
execFileSync('node', ['./mkconfig.js', VARIANT, JSON.stringify(COMPONENTS)], {
  cwd: srcDir,
  env,
  stdio: 'inherit',
});

// Dựng cả wasm lẫn entry ESM. Entry ESM (.mjs) KHÔNG được sinh mặc định cho variant tự
// khai báo — thiếu nó thì offscreen không import được, đúng cái bẫy UMD/ESM đã giết dự án
// một lần với @ffmpeg/core.
for (const target of [
  `dist/libav-${LIBAV_VER}-${VARIANT}.wasm.mjs`,
  `dist/libav-${LIBAV_VER}-${VARIANT}.mjs`,
]) {
  console.log(`[build-libav] make ${target}`);
  execFileSync('make', ['-j8', target], { cwd: srcDir, env, stdio: 'inherit' });
}

mkdirSync(outDir, { recursive: true });
const artifacts = [
  `libav-${LIBAV_VER}-${VARIANT}.mjs`,
  `libav-${LIBAV_VER}-${VARIANT}.wasm.mjs`,
  `libav-${LIBAV_VER}-${VARIANT}.wasm.wasm`,
];
for (const f of artifacts) {
  copyFileSync(resolve(srcDir, 'dist', f), resolve(outDir, f));
  console.log(`[build-libav] ${f} -> public/libav/`);
}
copyFileSync(
  resolve(srcDir, `configs/configs/${VARIANT}/config.json`),
  resolve(outDir, 'config.json'),
);

console.log(
  '[build-libav] Xong. Nhớ commit lại public/libav/ và cập nhật BUILD.md.',
);
