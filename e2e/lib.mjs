// Phần dùng chung của các harness e2e: nạp Edge thật + đọc trạng thái job + soi file ra bằng ffprobe.
// Dùng bởi: hls-403.mjs (fixture 403 cục bộ), real-demuxed.mjs (stream tách tiếng công khai).

import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXT = join(ROOT, '.output/chrome-mv3');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function requireBuild() {
  if (!existsSync(EXT)) {
    console.error(`✗ Chưa có bản build ở ${EXT}. Chạy \`pnpm build\` trước.`);
    process.exit(1);
  }
}

/**
 * Chạy `fn` với một context Edge SẠCH đã nạp extension.
 *
 * Context riêng cho MỖI ca là BẮT BUỘC, không phải cẩn thận thừa: session rule DNR sống hết phiên
 * (đúng lỗi §2.10 "rule rò rỉ"). Dùng chung context thì rule của ca trước sẽ tiêm Referer cho ca
 * sau -> ca "variants bị 403" ĐẠT OAN và ratchet bật nhầm. Đã cân nhắc, đừng gộp lại cho nhanh.
 */
export async function withBrowser(downloadFolder, fn) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'yvim-e2e-'));
  const downloadsPath = mkdtempSync(join(tmpdir(), 'yvim-dl-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'msedge',
    headless: false,
    downloadsPath,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
    ],
  });
  const logs = [];
  const watch = (t, tag) => {
    t.on?.('console', (m) => logs.push(`[${tag}] ${m.type()}: ${m.text()}`));
    t.on?.('pageerror', (e) => logs.push(`[${tag}] pageerror: ${e.message}`));
  };
  ctx.on('page', (p) => watch(p, 'page'));
  ctx.on('serviceworker', (w) => watch(w, 'sw'));
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30_000 });
    watch(sw, 'sw');
    const extId = new URL(sw.url()).host;
    const page = await ctx.newPage();
    watch(page, 'options');
    await page.goto(`chrome-extension://${extId}/options.html`);
    // Tải về thư mục riêng của lần chạy -> không đụng file thật của người dùng, dọn được sạch.
    await page.evaluate(
      (folder) => chrome.storage.local.set({ 'settings:downloadFolder': folder }),
      downloadFolder,
    );
    return await fn({ page, logs, extId });
  } finally {
    await ctx.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(downloadsPath, { recursive: true, force: true });
  }
}

/** Chờ job HLS kết thúc; trả về record job cuối (hoặc null nếu TREO). */
export async function waitJob(page, jobId, timeoutMs) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    const job = await page.evaluate(async (id) => {
      const all = await chrome.storage.session.get('hlsjobs');
      return all.hlsjobs?.[id] ?? null;
    }, jobId);
    if (job) {
      const now = `${job.phase} ${job.segmentsDone}/${job.segmentsTotal}`;
      if (now !== last) {
        console.log(`      [${((Date.now() - t0) / 1000).toFixed(1)}s] ${now}`);
        last = now;
      }
      if (['done', 'error', 'cancelled'].includes(job.phase)) return job;
    }
    await sleep(400);
  }
  return null;
}

/**
 * Chờ file rơi xuống đĩa; trả về mục downloads đã kết thúc.
 *
 * ⚠️ ĐÃ ĐO, ĐỪNG SỬA THÀNH LỌC-THEO-TÊN: Playwright CHẶN mọi download và đổi hướng sang thư mục
 * artifact riêng, đặt tên bằng UUID. Nên `item.filename` KHÔNG phải `~/Downloads/<folder>/x.mp4`
 * mà là `<downloadsPath>/<uuid>`. Tên file DỰ ĐỊNH phải assert riêng qua `job.filename`.
 * Mỗi ca một context sạch -> đúng một download -> lấy mục mới nhất là đủ.
 */
export async function waitDownloadedFile(page, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const items = await page.evaluate(async () => {
      const list = await chrome.downloads.search({ limit: 5, orderBy: ['-startTime'] });
      return list.map((i) => ({
        filename: i.filename,
        state: i.state,
        bytesReceived: i.bytesReceived,
        error: i.error,
      }));
    });
    const done = items.find((i) => i.state !== 'in_progress');
    if (done) return done;
    await sleep(300);
  }
  return null;
}

/**
 * ffprobe file ra: ĐẾM KHUNG HÌNH + thời lượng + có track hình/tiếng không.
 *
 * 🔬 VÌ SAO ĐẾM KHUNG chứ không chỉ đo thời lượng — ĐÃ ĐO, ĐỪNG "ĐƠN GIẢN HOÁ" LẠI:
 * Cấy mutation bỏ hẳn segment #5 rồi chạy thật: file tụt 122KB -> 111KB nhưng **thời lượng VẪN
 * 10.03s** và assert-theo-thời-lượng báo ĐẠT (false green trong chính test này).
 * Lý do: `concat:` nối BYTE các segment MPEG-TS, timestamp gốc trong segment còn lại được giữ
 * nguyên -> mất segment giữa chừng chỉ tạo LỖ HỔNG, mốc PTS cuối vẫn ở cuối.
 * => Thời lượng MÙ với lỗi mất segment. Số khung thì không.
 * ⚠️ Kéo theo: tiêu chí nghiệm thu W1.2 trong NGHIEN-CUU-VDH.md ("thời lượng file ra khớp
 *    totalDuration") là SAI — nó không bắt nổi đúng cái race §2.6 mà nó sinh ra để bắt.
 */
export function probeFile(path, { countFrames = true } = {}) {
  try {
    const out = execFileSync(
      'ffprobe',
      [
        '-v', 'error',
        ...(countFrames ? ['-count_frames'] : []),
        '-show_entries', 'format=duration',
        '-show_entries', `stream=codec_type,codec_name${countFrames ? ',nb_read_frames' : ''}`,
        '-of', 'json',
        path,
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    const j = JSON.parse(out);
    const streams = j.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    return {
      duration: Number(j.format?.duration ?? 0),
      codecs: streams.map((s) => s.codec_type),
      codecNames: streams.map((s) => s.codec_name),
      videoFrames: Number(video?.nb_read_frames ?? 0),
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
    };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}
