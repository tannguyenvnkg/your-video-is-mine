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
