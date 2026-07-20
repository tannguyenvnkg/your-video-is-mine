import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Ratchet cho bộ ghép libav.js tự dựng. Mỗi khẳng định dưới đây ứng với một lỗi ĐÃ ĐO
// được, thuộc loại XANH-mà-chết-câm: tsc/eslint/vitest đều không thấy, chỉ runtime mới lộ.
// Đừng nới lỏng cái nào mà không đo lại.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'public/libav');

const VER = '6.9.8.1';
const VARIANT = 'ts2mp4d';
const loader = resolve(dist, `libav-${VER}-${VARIANT}.mjs`);
const factory = resolve(dist, `libav-${VER}-${VARIANT}.wasm.mjs`);
const wasm = resolve(dist, `libav-${VER}-${VARIANT}.wasm.wasm`);

describe('libav.js variant tự dựng trong public/libav', () => {
  it('có đủ bộ ba file, đúng tên phiên bản', () => {
    // Loader tự ghép tên factory từ base + VER + CONFIG. Đổi tên file = loader đi tìm
    // một URL không tồn tại rồi chết lúc chạy.
    expect(
      existsSync(loader),
      `Thiếu ${loader} — xem public/libav/BUILD.md`,
    ).toBe(true);
    expect(existsSync(factory)).toBe(true);
    expect(existsSync(wasm)).toBe(true);
  });

  it('loader và factory đều là ESM có `export default`', () => {
    // @ffmpeg/core từng được đóng gói nhầm bản UMD: worker type:"module" nạp bằng
    // import() nên cần export default; bản UMD không có -> .default undefined ->
    // HLS chết 100% mà không một dòng lỗi. Đừng để tái diễn với libav.
    expect(readFileSync(loader, 'utf8')).toContain('export default');
    expect(readFileSync(factory, 'utf8')).toContain('export default');
  });

  it('loader khai đúng VER và CONFIG mà tên file phụ thuộc vào', () => {
    const src = readFileSync(loader, 'utf8');
    expect(src).toContain(`libav.VER="${VER}"`);
    expect(src).toContain(`libav.CONFIG="${VARIANT}"`);
  });

  it('mang theo văn bản LGPL-2.1 — nghĩa vụ giấy phép, không phải hình thức', () => {
    // Ta phát hành binary dựng từ nguồn LGPL nên PHẢI kèm giấy phép. @ffmpeg/core trước
    // đây không kèm gì cả, và đó là một vi phạm riêng bên cạnh chuyện dán nhãn sai.
    expect(existsSync(resolve(dist, 'LICENSE.txt'))).toBe(true);
    expect(readFileSync(resolve(dist, 'LICENSE.txt'), 'utf8')).toContain(
      'GNU LESSER GENERAL PUBLIC LICENSE',
    );
    expect(readFileSync(factory, 'utf8')).toContain(
      'GNU LESSER GENERAL PUBLIC LICENSE',
    );
  });

  it('config KHÔNG kéo theo encoder hay thành phần GPL', () => {
    // Lý do tồn tại của cả gói W3.1: @ffmpeg/core là GPL vì nó link libx264/libx265,
    // trong khi extension chỉ stream-copy và không bao giờ gọi tới encoder nào.
    const components: string[] = JSON.parse(
      readFileSync(resolve(dist, 'config.json'), 'utf8'),
    );
    expect(components.filter((c) => c.startsWith('encoder-'))).toEqual([]);
    for (const gpl of ['libx264', 'libx265', 'libxvid', 'gpl']) {
      expect(components.some((c) => c.includes(gpl))).toBe(false);
    }
  });

  it('giữ hai component "thừa mà bắt buộc" — đã trả giá mới biết', () => {
    const components: string[] = JSON.parse(
      readFileSync(resolve(dist, 'config.json'), 'utf8'),
    );
    // decoder-aac: dù chỉ stream-copy, thiếu nó thì find_stream_info trả
    // sample_rate=0/channels=0 -> mp4 muxer chết "sample rate not set" (divide by zero).
    expect(components).toContain('decoder-aac');
    // avbsf: thiếu fragment này thì av_bsf_* không được export sang JS, dù bsf đã được
    // biên dịch vào libavcodec.
    expect(components).toContain('avbsf');
    // demuxer-mpegts là lý do phải tự dựng: KHÔNG bản npm dựng sẵn nào có nó.
    expect(components).toContain('demuxer-mpegts');
    expect(components).toContain('format-mp4');
  });
});
