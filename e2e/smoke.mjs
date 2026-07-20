// Harness E2E runtime: nạp bản build vào Edge THẬT rồi chạy thử tính năng chủ lực.
//
// VÌ SAO CẦN: compile/lint/test/build đều XANH suốt thời gian tải HLS đã chết (bug ffmpeg core
// UMD-vs-ESM sống sót từ commit đầu tiên). Không cổng TĨNH nào bắt được lớp lỗi này — chỉ có chạy
// thật mới bắt được. Harness này là cổng ĐỘNG đó.
//
// Dùng Edge cài sẵn (channel msedge) + playwright-core -> không tải browser 150MB.
// Extension chỉ nạp được ở persistent context + headed (giới hạn của Chromium).
//
// Chạy: pnpm e2e

import { chromium } from 'playwright-core';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(root, '.output/chrome-mv3');

// Playlist demo công khai: HLS .ts thường, KHÔNG mã hoá, 184 segment.
const MEDIA_URL =
  'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8';
const VARIANT_URL =
  'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/tears-of-steel-audio_eng=128002-video_eng=1001000.m3u8';

const HLS_TIMEOUT_MS = Number(process.env.HLS_TIMEOUT_MS ?? 120_000);

if (!existsSync(EXT)) {
  console.error(`✗ Chưa có bản build ở ${EXT}. Chạy \`pnpm build\` trước.`);
  process.exit(1);
}

const userDataDir = mkdtempSync(join(tmpdir(), 'yvim-e2e-'));
let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(`✗ ${msg}`);
};
const ok = (msg) => console.log(`✓ ${msg}`);

const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'msedge',
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
  ],
});

// Gom log của MỌI ngữ cảnh (kể cả offscreen document) — đây là thứ trước đây không ai nhìn thấy.
const logs = [];
const watch = (target, tag) => {
  target.on?.('console', (m) => {
    const line = `[${tag}] ${m.type()}: ${m.text()}`;
    logs.push(line);
    if (m.type() === 'error') console.log(`  ${line}`);
  });
  target.on?.('pageerror', (e) => {
    const line = `[${tag}] pageerror: ${e.message}`;
    logs.push(line);
    console.log(`  ${line}`);
  });
};
ctx.on('page', (p) => watch(p, `page ${p.url() || 'about:blank'}`));
ctx.on('serviceworker', (w) => watch(w, 'sw'));

try {
  // --- Lấy extension id từ service worker ---
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30_000 });
  watch(sw, 'sw');
  const extId = new URL(sw.url()).host;
  ok(`Extension đã nạp: ${extId}`);

  // --- TEST 1: ffmpeg khởi tạo + chạy được (đường này await nên lỗi hiện ra) ---
  const options = await ctx.newPage();
  watch(options, 'options');
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.getByRole('button', { name: 'Kiểm tra bộ ghép video' }).click();

  const status = options.locator('.ff-status, [class*="status"]').first();
  let ffText = '';
  try {
    await options.waitForFunction(
      () => /✓|✗/.test(document.body.innerText),
      undefined,
      { timeout: 90_000 },
    );
    ffText = (await status.innerText().catch(() => '')) || '';
    if (!ffText) ffText = await options.innerText('body');
  } catch {
    fail(
      'ffmpeg: TREO — không ra ✓ lẫn ✗ sau 90s. ensureFfmpeg() không settle.',
    );
  }
  const ffLine = (ffText.match(/[✓✗][^\n]*/) ?? [''])[0].trim();
  if (ffLine.startsWith('✓')) ok(`ffmpeg: ${ffLine}`);
  else if (ffLine.startsWith('✗')) fail(`ffmpeg: ${ffLine}`);

  // --- TEST 2: tải HLS thật, theo dõi dòng thời gian phase ---
  // Gửi thẳng 'hls/download' từ trang extension: background xử lý y hệt lúc popup bấm nút.
  // tabId -1 = không có media item trong storage -> vẫn chạy được (spoof dùng chính variantUrl).
  const start = await options.evaluate(
    async ([variantUrl, mediaUrl]) =>
      await chrome.runtime.sendMessage({
        kind: 'hls/download',
        variantUrl,
        mediaUrl,
        tabId: -1,
      }),
    [VARIANT_URL, MEDIA_URL],
  );
  if (!start?.ok) {
    fail(`hls/download bị từ chối ngay: ${JSON.stringify(start)}`);
  } else {
    ok(`hls/download đã nhận, jobId=${start.jobId}`);

    const t0 = Date.now();
    let last = '';
    let final = null;
    while (Date.now() - t0 < HLS_TIMEOUT_MS) {
      const job = await options.evaluate(async (id) => {
        const all = await chrome.storage.session.get('hlsjobs');
        return all.hlsjobs?.[id] ?? null;
      }, start.jobId);
      if (job) {
        const now = `${job.phase} ${job.segmentsDone}/${job.segmentsTotal}${job.error ? ` — ${job.error}` : ''}`;
        if (now !== last) {
          console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${now}`);
          last = now;
        }
        if (['done', 'error', 'cancelled'].includes(job.phase)) {
          final = job;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!final) {
      fail(
        `HLS: TREO ở phase "${last}" sau ${HLS_TIMEOUT_MS / 1000}s. ` +
          `(phase 'queued' = message không tới offscreen; 'loading' = kẹt trước khi tải segment)`,
      );
    } else if (final.phase === 'done') {
      ok(`HLS: tải + ghép xong (${final.segmentsTotal} segment)`);
    } else {
      fail(`HLS: ${final.phase} — ${final.error ?? 'không rõ'}`);
    }
  }
} catch (e) {
  fail(`Harness lỗi: ${e?.message ?? e}`);
} finally {
  if (failed && logs.length) {
    console.log('\n--- Log các ngữ cảnh (kể cả offscreen) ---');
    for (const l of logs.slice(-40)) console.log(`  ${l}`);
  }
  await ctx.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failed ? '\n✗ E2E THẤT BẠI' : '\n✓ E2E XANH');
process.exit(failed ? 1 : 0);
