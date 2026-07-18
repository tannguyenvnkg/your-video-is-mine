// Harness W0.3 — lưới an toàn tích hợp: extension THẬT + server fixture cục bộ CÓ CỔNG 403.
//
// VÌ SAO CẦN (đọc kỹ trước khi sửa):
//   Toàn bộ 193 test vitest chỉ chạm HÀM THUẦN. `dnr.test.ts` chứng minh buildRefererSpoofRule()
//   trả object đúng — nhưng KHÔNG THỂ thấy `handleVariants` chẳng bao giờ gọi nó. Đó là lớp lỗi
//   mà cổng tĩnh mù hoàn toàn. Harness này đo bằng cách CHẠY THẬT.
//   e2e/smoke.mjs tải từ site công khai và KHÔNG có cổng 403 -> nó chứng minh "đường HLS chạy",
//   không chứng minh được gì về chống hotlink. Đây là chỗ file này bù vào.
//
// KHÁC BIỆT SO VỚI smoke.mjs: offline (fixture cục bộ), tất định, và có cổng 403 quan sát được.
//
// 🔬 RATCHET TỰ BẬT (mượn đúng cơ chế `it.fails` của W0.4):
//   Ca `expect: 'known-fail'` ghim một BUG ĐÃ BIẾT còn sống. Nếu ca đó bỗng ĐẠT (ai đó sửa xong
//   W2.2/W2.3) thì harness **ĐỎ** kèm hướng dẫn đổi nhãn thành 'pass'. Không thể quên như TODO chết.
//
// Chạy: pnpm e2e:fixture   (cần `pnpm build` trước; cần ffprobe cho phần kiểm thời lượng)

import { startFixtureServer } from './fixture-server.mjs';
import {
  requireBuild,
  withBrowser as withBrowserRaw,
  waitJob,
  waitDownloadedFile,
  probeFile,
} from './lib.mjs';
import { existsSync, statSync } from 'node:fs';

const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 120_000);
// fixture = 10 segment x 1s x 10fps (sinh bang ffmpeg, xem e2e/fixtures/hls).
// Dem KHUNG chu khong do thoi luong - ly do da do bang thuc nghiem, xem probeFile() trong lib.mjs.
const FIXTURE_FRAMES = 100;
const DOWNLOAD_FOLDER = `yvim-e2e-${process.pid}`;

requireBuild();

const withBrowser = (fn) => withBrowserRaw(DOWNLOAD_FOLDER, fn);

// --- Các ca ------------------------------------------------------------------------------------
// Mỗi ca trả { ok: boolean, detail: string }. `expect` nói ca đó ĐANG phải đạt hay đang ghim bug.

/** Tải trọn stream qua hls/download rồi kiểm file trên đĩa. */
async function runDownload({ gate, segmentHost }) {
  const srv = await startFixtureServer({ gate, segmentHost });
  try {
    return await withBrowser(async ({ page, logs }) => {
      const start = await page.evaluate(
        ([variantUrl, mediaUrl]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl,
            mediaUrl,
            tabId: -1,
          }),
        [srv.mediaUrl, srv.masterUrl],
      );
      if (!start?.ok) {
        return { ok: false, detail: `hls/download bị từ chối: ${JSON.stringify(start)}` };
      }
      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (!job) {
        return { ok: false, detail: `job TREO sau ${JOB_TIMEOUT_MS / 1000}s (không done/error)` };
      }
      if (job.phase !== 'done') {
        const b = srv.blocked().length;
        return {
          ok: false,
          detail: `job ${job.phase}: ${job.error ?? '?'}${b ? ` — server đã chặn ${b} request vì thiếu Referer` : ''}`,
        };
      }
      // Tên file DỰ ĐỊNH (đường đặt tên + thư mục con) — assert ở đây vì đường dẫn thật trên đĩa
      // đã bị Playwright đổi hướng, xem chú thích ở waitDownloadedFile().
      const wantName = `${DOWNLOAD_FOLDER}/media.mp4`;
      if (job.filename !== wantName) {
        return { ok: false, detail: `tên file dự định sai: "${job.filename}", mong đợi "${wantName}"` };
      }
      const file = await waitDownloadedFile(page, 30_000);
      if (!file) return { ok: false, detail: 'job done nhưng KHÔNG có file nào rơi xuống đĩa' };
      if (file.state !== 'complete') {
        return { ok: false, detail: `download ${file.state}: ${file.error ?? '?'}` };
      }
      if (!existsSync(file.filename)) {
        return { ok: false, detail: `downloads báo complete nhưng file không tồn tại: ${file.filename}` };
      }
      const size = statSync(file.filename).size;
      const probe = probeFile(file.filename);
      if (probe.error) return { ok: false, detail: `ffprobe không đọc được file ra: ${probe.error}` };
      if (!probe.codecs.includes('video')) {
        return { ok: false, detail: `file ra KHÔNG có track hình (streams: ${probe.codecs.join(',') || 'rỗng'})` };
      }
      // §2.6: nhảy cóc segment -> THIẾU KHUNG HÌNH (thời lượng thì không đổi — xem probeFile).
      // Dung sai ±2 khung: remux -c copy có thể lệch 1 khung ở mép, nhưng rơi 1 segment = -10 khung.
      if (Math.abs(probe.videoFrames - FIXTURE_FRAMES) > 2) {
        return {
          ok: false,
          detail:
            `thiếu khung hình: đọc được ${probe.videoFrames}, mong đợi ${FIXTURE_FRAMES} ` +
            `(mất segment? thời lượng ${probe.duration.toFixed(2)}s KHÔNG phản ánh lỗi này)`,
        };
      }
      const errLog = logs.filter((l) => l.includes('error:')).slice(-3);
      return {
        ok: true,
        detail:
          `file ${(size / 1024).toFixed(0)}KB, ${probe.duration.toFixed(2)}s, ` +
          `${probe.videoFrames} khung, track: ${probe.codecs.join('+')}` +
          `${errLog.length ? ` (log lỗi: ${errLog.join(' | ')})` : ''}`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W2.6 — server NHẬN request segment rồi câm tuyệt đối (mô phỏng mất mạng giữa chừng).
 *
 * Tiêu chí: job phải kết thúc bằng `error` TRONG THỜI GIAN CÓ HẠN. Trước W2.6, `fetch` không có
 * signal nào -> promise không bao giờ settle -> job kẹt 'fetching' vĩnh viễn (§2.9 hậu quả 1) và
 * ca này TREO hết JOB_TIMEOUT_MS. Số học sau W2.6: 4 lượt x 15s + backoff 3.5s = ~63s.
 */
async function runSegmentStall() {
  const srv = await startFixtureServer({ gate: 'none', stallSegments: true });
  const budgetMs = 100_000;
  try {
    return await withBrowser(async ({ page }) => {
      const start = await page.evaluate(
        ([variantUrl, mediaUrl]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl,
            mediaUrl,
            tabId: -1,
          }),
        [srv.mediaUrl, srv.masterUrl],
      );
      if (!start?.ok) {
        return { ok: false, detail: `hls/download bị từ chối: ${JSON.stringify(start)}` };
      }
      const t0 = Date.now();
      const job = await waitJob(page, start.jobId, budgetMs);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (!job) {
        return {
          ok: false,
          detail: `job TREO >${budgetMs / 1000}s trên server câm — đúng bệnh §2.9 (không timeout)`,
        };
      }
      if (job.phase !== 'error') {
        return { ok: false, detail: `mong đợi phase 'error', nhận '${job.phase}' sau ${secs}s` };
      }
      return {
        ok: true,
        detail: `job báo lỗi sau ${secs}s (không treo): "${job.error ?? '?'}"`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W2.5 — tải progressive .mp4 qua `download/progressive` rồi kiểm file trên đĩa.
 *
 * Tín hiệu ĐỘC LẬP VỚI ĐƯỜNG (cũ trực tiếp vs mới qua offscreen): SERVER có 403 lần nào không +
 * có phục vụ byte mp4 không. Đường cũ (chrome.downloads.download thẳng) KHÔNG nhận Referer spoof
 * -> server 403 -> hits=0 (đã ĐO 2026-07-18). Đường mới (offscreen fetch) mang Referer spoof vì
 * fetch của extension là xmlhttprequest tab-less -> khớp rule DNR -> server phục vụ 200/206.
 */
async function runProgressive({ gate }) {
  const srv = await startFixtureServer({ gate });
  try {
    return await withBrowser(async ({ page, logs }) => {
      const start = await page.evaluate(
        (url) =>
          chrome.runtime.sendMessage({ kind: 'download/progressive', url, tabId: -1 }),
        srv.progressiveUrl,
      );
      if (!start?.ok) {
        return { ok: false, detail: `download/progressive bị từ chối: ${JSON.stringify(start)}` };
      }
      const file = await waitDownloadedFile(page, 30_000);
      // DownloadEntry của extension (thứ popup HIỂN THỊ) PHẢI tới 'complete' — bắt cả race "blob nhỏ
      // complete trước khi onChanged khớp entry" mà chrome.downloads state không lộ ra.
      let entryState = null;
      for (let i = 0; i < 20; i++) {
        entryState = await page.evaluate(async (key) => {
          const all = await chrome.storage.session.get('downloads');
          return all.downloads?.[key]?.state ?? null;
        }, start.key);
        if (entryState && entryState !== 'in_progress') break;
        await new Promise((r) => setTimeout(r, 300));
      }
      if (entryState !== 'complete') {
        return { ok: false, detail: `DownloadEntry kẹt ở "${entryState}" (popup sẽ hiện sai trạng thái)` };
      }
      const blocked = srv.blocked().length;
      const hits = srv.progressiveHits();
      // Cổng bật mà server chưa từng 403 và có phục vụ byte = spoof đã áp cho cú fetch tải.
      if (blocked > 0 || hits === 0) {
        return {
          ok: false,
          detail: `server chặn ${blocked} request 403 (thiếu Referer), phục vụ ${hits} lần mp4 — spoof KHÔNG áp cho đường tải`,
        };
      }
      if (!file) return { ok: false, detail: 'không có file nào rơi xuống đĩa' };
      if (file.state !== 'complete') {
        return { ok: false, detail: `download ${file.state}: ${file.error ?? '?'}` };
      }
      if (!existsSync(file.filename)) {
        return { ok: false, detail: `downloads báo complete nhưng file không tồn tại: ${file.filename}` };
      }
      const size = statSync(file.filename).size;
      const probe = probeFile(file.filename);
      if (probe.error) return { ok: false, detail: `ffprobe không đọc được file: ${probe.error}` };
      if (!probe.codecs.includes('video')) {
        return { ok: false, detail: `file ra KHÔNG có track hình (streams: ${probe.codecs.join(',') || 'rỗng'})` };
      }
      const errLog = logs.filter((l) => l.includes('error:')).slice(-3);
      return {
        ok: true,
        detail:
          `file ${size}B, ${probe.videoFrames} khung, track: ${probe.codecs.join('+')}, ` +
          `server phục vụ ${hits} lần, 0 lần 403` +
          `${errLog.length ? ` (log lỗi: ${errLog.join(' | ')})` : ''}`,
      };
    });
  } finally {
    await srv.close();
  }
}

/** Chỉ bấm "Chất lượng" (manifest/variants) — đúng cú fetch ĐẦU TIÊN của flow. */
async function runVariants({ gate }) {
  const srv = await startFixtureServer({ gate });
  try {
    return await withBrowser(async ({ page }) => {
      const res = await page.evaluate(
        (url) => chrome.runtime.sendMessage({ kind: 'manifest/variants', url, mediaType: 'hls' }),
        srv.masterUrl,
      );
      if (res?.ok) {
        return { ok: true, detail: `ra ${res.variants.length} chất lượng` };
      }
      const b = srv.blocked().length;
      return {
        ok: false,
        detail: `${res?.error ?? JSON.stringify(res)}${b ? ` — server chặn ${b} request vì thiếu Referer` : ''}`,
      };
    });
  } finally {
    await srv.close();
  }
}

// --- Danh sách ca ------------------------------------------------------------------------------

const SCENARIOS = [
  {
    id: 'happy',
    title: 'Không cổng: tải trọn 10 segment -> .mp4 trên đĩa, đủ thời lượng',
    expect: 'pass',
    run: () => runDownload({ gate: 'none', segmentHost: null }),
  },
  {
    id: 'download-spoof',
    title: 'Cổng 403 mọi path: hls/download CÓ gọi applySpoof -> phải qua được',
    expect: 'pass',
    run: () => runDownload({ gate: 'all', segmentHost: null }),
  },
  {
    id: 'variants-403',
    title: 'Cổng 403 manifest: bấm "Chất lượng" -> spoof bật TRƯỚC fetch (W2.2) -> phải qua',
    // W2.2 XONG (2026-07-17): handleVariants nay applySpoof ÔM SÁT cú fetch -> qua cổng hotlink.
    // Ratchet đã bật đúng lúc sửa xong (known-fail -> pass), giờ là lưới chống hồi quy.
    expect: 'pass',
    run: () => runVariants({ gate: 'manifest' }),
  },
  {
    id: 'segments-other-host',
    title: 'Segment ở host KHÁC manifest + cổng 403 -> spoof MỌI host đã parse (W2.3) -> tải trọn',
    // W2.3 XONG (2026-07-17): handleHlsDownload parse playlist TRƯỚC rồi spoof mọi host của
    // segment/key/init. Ratchet đã bật đúng lúc sửa xong (known-fail -> pass), nay là lưới hồi quy.
    expect: 'pass',
    run: () => runDownload({ gate: 'segments', segmentHost: 'localhost' }),
  },
  {
    id: 'progressive-403',
    title: 'Cổng 403 mp4: tải progressive phải qua (W2.5 định tuyến qua offscreen -> fetch mang Referer)',
    // W2.5 XONG (2026-07-18): handleDownload định tuyến fetch qua offscreen (xmlhttprequest tab-less
    // -> khớp rule DNR). Ratchet đã bật đúng lúc sửa xong (known-fail -> pass), nay là lưới hồi quy.
    // ĐO 2026-07-18: đường cũ chrome.downloads.download thẳng -> server nhận ref=NONE -> 403.
    expect: 'pass',
    pins: '§2.5/W2.5 (progressive qua offscreen)',
    run: () => runProgressive({ gate: 'progressive' }),
  },
  {
    id: 'segment-stall',
    title: 'Server câm giữa chừng: job phải BÁO LỖI có hạn (W2.6), không kẹt fetching vĩnh viễn',
    // W2.6 (2026-07-18): fetchWithRetry nay có đồng hồ chờ-header + đồng hồ im-lặng, ghép với
    // signal huỷ của job. Trước W2.6 ca này treo hết budget vì fetch không có signal nào.
    expect: 'pass',
    pins: '§2.9/W2.6 (retry không timeout/không huỷ được)',
    run: () => runSegmentStall(),
  },
];

// --- Chạy --------------------------------------------------------------------------------------

let failed = false;
const only = process.argv[2];

console.log('W0.3 — lưới an toàn tích hợp (extension thật + fixture 403 cục bộ)\n');

for (const s of SCENARIOS) {
  if (only && s.id !== only) continue;
  console.log(`▶ [${s.id}] ${s.title}`);
  let r;
  try {
    r = await s.run();
  } catch (e) {
    r = { ok: false, detail: `harness lỗi: ${e?.message ?? e}` };
  }

  if (s.expect === 'pass') {
    if (r.ok) console.log(`  ✓ ĐẠT — ${r.detail}\n`);
    else {
      failed = true;
      console.log(`  ✗ HỎNG — ${r.detail}\n`);
    }
  } else {
    if (!r.ok) {
      console.log(`  ⊘ ĐỎ NHƯ DỰ KIẾN (bug còn sống, đã ghim) — ${r.detail}`);
      console.log(`     ghim: ${s.pins}\n`);
    } else {
      // Ratchet bật: bug đã được sửa -> ép đổi nhãn, không cho lặng lẽ trôi.
      failed = true;
      console.log(`  ✗ RATCHET BẬT — ca này LẼ RA phải đỏ nhưng đã ĐẠT: ${r.detail}`);
      console.log(`     => ${s.pins} đã được sửa. Đổi expect: 'known-fail' -> 'pass' trong e2e/hls-403.mjs.\n`);
    }
  }
}

console.log(failed ? '✗ W0.3 THẤT BẠI' : '✓ W0.3 XANH');
process.exit(failed ? 1 : 0);
