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

import { startFixtureServer, startDemuxedServer } from './fixture-server.mjs';
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
        return {
          ok: false,
          detail: `hls/download bị từ chối: ${JSON.stringify(start)}`,
        };
      }
      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (!job) {
        return {
          ok: false,
          detail: `job TREO sau ${JOB_TIMEOUT_MS / 1000}s (không done/error)`,
        };
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
        return {
          ok: false,
          detail: `tên file dự định sai: "${job.filename}", mong đợi "${wantName}"`,
        };
      }
      const file = await waitDownloadedFile(page, 30_000);
      if (!file)
        return {
          ok: false,
          detail: 'job done nhưng KHÔNG có file nào rơi xuống đĩa',
        };
      if (file.state !== 'complete') {
        return {
          ok: false,
          detail: `download ${file.state}: ${file.error ?? '?'}`,
        };
      }
      if (!existsSync(file.filename)) {
        return {
          ok: false,
          detail: `downloads báo complete nhưng file không tồn tại: ${file.filename}`,
        };
      }
      const size = statSync(file.filename).size;
      const probe = probeFile(file.filename);
      if (probe.error)
        return {
          ok: false,
          detail: `ffprobe không đọc được file ra: ${probe.error}`,
        };
      if (!probe.codecs.includes('video')) {
        return {
          ok: false,
          detail: `file ra KHÔNG có track hình (streams: ${probe.codecs.join(',') || 'rỗng'})`,
        };
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
        return {
          ok: false,
          detail: `hls/download bị từ chối: ${JSON.stringify(start)}`,
        };
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
        return {
          ok: false,
          detail: `mong đợi phase 'error', nhận '${job.phase}' sau ${secs}s`,
        };
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
 * W2.7 — GIẾT offscreen giữa lúc tải: job phải BÁO LỖI có hạn, không quay spinner vĩnh viễn.
 *
 * Vì sao ca này bắt được thứ cổng tĩnh mù: offscreen chết IM LẶNG — Chrome không bắn sự kiện nào về
 * background. Không có tick W2.7 thì job nằm lại 'fetching' tới lúc đóng trình duyệt, và KHÔNG một
 * test thuần nào thấy được, vì lỗi nằm ở chỗ "không ai báo" chứ không ở một hàm nào cả.
 *
 * Dùng `stallSegments` để job đứng yên ở 'fetching' (tất định), rồi `closeDocument()` giết offscreen
 * — đúng thứ Task Manager của Chrome làm. Lưu ý: giết offscreen cũng giết luôn đồng hồ retry W2.6
 * nằm trong đó, nên tick của background là thứ DUY NHẤT còn có thể cứu job.
 *
 * Ngân sách: ngưỡng im 60s + chu kỳ alarm tối đa 30s (Chrome không cho dày hơn) => tệ nhất ~90s.
 */
async function runOffscreenDeath() {
  const srv = await startFixtureServer({ gate: 'none', stallSegments: true });
  const budgetMs = 150_000;
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
        return {
          ok: false,
          detail: `hls/download bị từ chối: ${JSON.stringify(start)}`,
        };
      }
      // Chờ job thực sự vào 'fetching' rồi mới giết — giết sớm quá thì ta đo nhầm ca "chưa nhận việc".
      let reached = false;
      for (let i = 0; i < 40; i++) {
        const phase = await page.evaluate(async (id) => {
          const all = await chrome.storage.session.get('hlsjobs');
          return all.hlsjobs?.[id]?.phase ?? null;
        }, start.jobId);
        if (phase === 'fetching') {
          reached = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!reached)
        return {
          ok: false,
          detail: 'job không vào được phase fetching để giết offscreen',
        };

      const killed = await page.evaluate(async () => {
        try {
          await chrome.offscreen.closeDocument();
          return true;
        } catch (e) {
          return String(e?.message ?? e);
        }
      });
      if (killed !== true)
        return { ok: false, detail: `không giết được offscreen: ${killed}` };
      console.log('      [kill] offscreen đã bị đóng — nhịp tim dừng từ đây');

      const t0 = Date.now();
      const job = await waitJob(page, start.jobId, budgetMs);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (!job) {
        return {
          ok: false,
          detail: `job TREO >${budgetMs / 1000}s sau khi offscreen chết — spinner quay vĩnh viễn (§2.14)`,
        };
      }
      if (job.phase !== 'error') {
        return {
          ok: false,
          detail: `mong đợi phase 'error', nhận '${job.phase}' sau ${secs}s`,
        };
      }
      // Thông báo phải nói ĐÚNG chuyện gì xảy ra: "bộ xử lý đã dừng", không phải lỗi mạng chung chung.
      if (!/dừng đột ngột/.test(job.error ?? '')) {
        return {
          ok: false,
          detail: `báo lỗi sau ${secs}s nhưng SAI lý do: "${job.error ?? '?'}"`,
        };
      }
      return {
        ok: true,
        detail: `job báo lỗi sau ${secs}s, đúng lý do: "${job.error}"`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W7.1 — RANH GIỚI CỨNG §7: trang xin DRM/EME thì extension phải TỪ CHỐI TẢI, và nói rõ vì sao.
 *
 * Vì sao ca này bắt được thứ cổng tĩnh mù: trước W7.1 `CLAUDE.md` TUYÊN BỐ ranh giới này mà grep
 * `requestMediaKeySystemAccess` ra 0 hit — tức là lời tuyên bố không có gì thi hành nó. Không một
 * test thuần nào phát hiện được "một tính năng đã hứa mà không tồn tại"; chỉ chạy thật mới thấy.
 *
 * 🔴 Ca này KHÔNG tải nội dung DRM nào. Nó chỉ mở một trang GỌI API EME rồi kiểm tra extension có
 * từ chối hay không — đo cái KHÓA, không phải đo cách mở khoá.
 */
async function runDrmRefused() {
  const srv = await startFixtureServer({ gate: 'none' });
  try {
    return await withBrowser(async ({ page }) => {
      // Mở trang DRM trong một tab THẬT (cần tabId thật thì cờ DRM mới gắn đúng chỗ).
      const tabId = await page.evaluate(async (url) => {
        const t = await chrome.tabs.create({ url, active: false });
        return t.id;
      }, srv.drmPageUrl);
      if (typeof tabId !== 'number') {
        return { ok: false, detail: 'không mở được tab trang DRM' };
      }

      // Chờ content script bắt được lời gọi EME rồi báo về background.
      let systems = [];
      for (let i = 0; i < 40; i++) {
        systems = await page.evaluate(async (id) => {
          const all = await chrome.storage.session.get(`media:${id}`);
          return all[`media:${id}`]?.drmSystems ?? [];
        }, tabId);
        if (systems.length > 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (systems.length === 0) {
        return {
          ok: false,
          detail:
            'KHÔNG phát hiện được DRM — ranh giới §7 vẫn chỉ là lời tuyên bố suông',
        };
      }
      if (!systems.includes('Widevine')) {
        return {
          ok: false,
          detail: `phát hiện DRM nhưng sai tên: ${JSON.stringify(systems)}`,
        };
      }

      // Cửa 1: HLS. Phải bị từ chối, kèm lý do đọc được.
      const hls = await page.evaluate(
        ([v, m, id]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl: v,
            mediaUrl: m,
            tabId: id,
          }),
        [srv.mediaUrl, srv.masterUrl, tabId],
      );
      if (hls?.ok !== false) {
        return {
          ok: false,
          detail: `hls/download KHÔNG bị chặn trên tab DRM: ${JSON.stringify(hls)}`,
        };
      }
      if (!/DRM/i.test(hls.error ?? '')) {
        return {
          ok: false,
          detail: `bị chặn nhưng lý do không nói tới DRM: "${hls.error}"`,
        };
      }

      // Cửa 2: progressive. Cùng ranh giới, phải bịt luôn — không để hở đường vòng.
      const prog = await page.evaluate(
        ([url, id]) =>
          chrome.runtime.sendMessage({
            kind: 'download/progressive',
            url,
            tabId: id,
          }),
        [srv.progressiveUrl, tabId],
      );
      if (prog?.ok !== false) {
        return {
          ok: false,
          detail: `download/progressive KHÔNG bị chặn — ranh giới hở đường vòng: ${JSON.stringify(prog)}`,
        };
      }

      // Cửa 3: tab SẠCH vẫn phải tải được — chặn oan còn tệ hơn bỏ sót.
      const clean = await page.evaluate(
        ([v, m]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl: v,
            mediaUrl: m,
            tabId: -1,
          }),
        [srv.mediaUrl, srv.masterUrl],
      );
      if (clean?.ok !== true) {
        return {
          ok: false,
          detail: `tab SẠCH bị chặn OAN: ${JSON.stringify(clean)}`,
        };
      }

      return {
        ok: true,
        detail: `phát hiện ${systems.join(', ')}; chặn cả HLS lẫn progressive, tab sạch vẫn tải được — "${hls.error}"`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W2.7 — tải PROGRESSIVE (.mp4) cũng phải có lưới liveness, không chỉ HLS.
 *
 * W2.5 định tuyến .mp4 qua offscreen để mang được Referer spoof. Hệ quả ít ai để ý: từ đó lượt tải
 * progressive PHỤ THUỘC vào offscreen y như HLS. Offscreen chết giữa lúc fetch ⇒ `finally` của nó
 * không bao giờ chạy ⇒ không có `download/progress` state 'interrupted' nào được gửi ⇒ entry nằm
 * lại `in_progress` VĨNH VIỄN, popup quay spinner. Tệ hơn: `sweepStaleSpoofRules` coi 'in_progress'
 * là còn sống nên rule spoof của nó bị ghim nguyên phiên.
 */
async function runProgressiveOffscreenDeath() {
  const srv = await startFixtureServer({ gate: 'none', stallSegments: true });
  const budgetMs = 150_000;
  try {
    return await withBrowser(async ({ page }) => {
      const start = await page.evaluate(
        (url) =>
          chrome.runtime.sendMessage({
            kind: 'download/progressive',
            url,
            tabId: -1,
          }),
        srv.stallProgressiveUrl ?? srv.progressiveUrl,
      );
      if (!start?.ok) {
        return {
          ok: false,
          detail: `download/progressive bị từ chối: ${JSON.stringify(start)}`,
        };
      }
      // Chờ entry thực sự vào 'in_progress' rồi mới giết offscreen.
      let ready = false;
      for (let i = 0; i < 40; i++) {
        const st = await page.evaluate(async (key) => {
          const all = await chrome.storage.session.get('downloads');
          return all.downloads?.[key]?.state ?? null;
        }, start.key);
        if (st === 'in_progress') {
          ready = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!ready)
        return {
          ok: false,
          detail: 'entry không vào được in_progress để giết offscreen',
        };

      const killed = await page.evaluate(async () => {
        try {
          await chrome.offscreen.closeDocument();
          return true;
        } catch (e) {
          return String(e?.message ?? e);
        }
      });
      if (killed !== true)
        return { ok: false, detail: `không giết được offscreen: ${killed}` };
      console.log('      [kill] offscreen đã bị đóng giữa lúc fetch .mp4');

      const t0 = Date.now();
      while (Date.now() - t0 < budgetMs) {
        const entry = await page.evaluate(async (key) => {
          const all = await chrome.storage.session.get('downloads');
          return all.downloads?.[key] ?? null;
        }, start.key);
        if (entry && entry.state !== 'in_progress') {
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          if (entry.state !== 'interrupted') {
            return {
              ok: false,
              detail: `mong đợi 'interrupted', nhận '${entry.state}' sau ${secs}s`,
            };
          }
          if (!/dừng đột ngột/.test(entry.error ?? '')) {
            return {
              ok: false,
              detail: `chốt sau ${secs}s nhưng SAI lý do: "${entry.error ?? '?'}"`,
            };
          }
          return {
            ok: true,
            detail: `entry chốt 'interrupted' sau ${secs}s, đúng lý do: "${entry.error}"`,
          };
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return {
        ok: false,
        detail: `entry KẸT 'in_progress' >${budgetMs / 1000}s sau khi offscreen chết — spinner vĩnh viễn`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W2.7 — job XẾP HÀNG không được bị chốt "chết" OAN.
 *
 * Vì sao ca này tồn tại: job HLS chạy TUẦN TỰ (một instance ffmpeg). Job #2 nằm im trong hàng đợi
 * suốt thời gian job #1 tải — mà job #1 chạy vài phút là chuyện thường. Nếu nhịp tim chỉ đập lúc
 * job ĐANG CHẠY thì job #2 im >60s và bị tick W2.7 giết oan, dù offscreen hoàn toàn khoẻ.
 *
 * 👉 Giết oan một lượt tải khoẻ còn TỆ HƠN cái treo mà W2.7 sinh ra để chữa. Đây là ca canh đúng
 * ranh giới đó: job #1 stall 63s (đủ lâu để vượt ngưỡng 60s), job #2 phải sống qua được.
 */
async function runQueuedJobNotReaped() {
  const srv = await startFixtureServer({ gate: 'none', stallSegments: true });
  try {
    return await withBrowser(async ({ page }) => {
      const startJob = (variantUrl, mediaUrl) =>
        page.evaluate(
          ([v, m]) =>
            chrome.runtime.sendMessage({
              kind: 'hls/download',
              variantUrl: v,
              mediaUrl: m,
              tabId: -1,
            }),
          [variantUrl, mediaUrl],
        );
      const a = await startJob(srv.mediaUrl, srv.masterUrl);
      const b = await startJob(srv.mediaUrl, srv.masterUrl);
      if (!a?.ok || !b?.ok) {
        return {
          ok: false,
          detail: `không xếp được 2 job: ${JSON.stringify({ a, b })}`,
        };
      }
      // Job #2 xếp sau job #1 (đang stall 63s). Theo dõi nó qua mốc 60s — mốc mà tick sẽ soi tới.
      const deadline = Date.now() + 75_000;
      while (Date.now() < deadline) {
        const job = await page.evaluate(async (id) => {
          const all = await chrome.storage.session.get('hlsjobs');
          return all.hlsjobs?.[id] ?? null;
        }, b.jobId);
        if (job && /dừng đột ngột/.test(job.error ?? '')) {
          const secs = ((75_000 - (deadline - Date.now())) / 1000).toFixed(1);
          return {
            ok: false,
            detail: `job XẾP HÀNG bị giết OAN sau ${secs}s dù offscreen còn sống: "${job.error}"`,
          };
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return {
        ok: true,
        detail: 'job xếp hàng sống qua mốc 60s — không bị tick giết oan',
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
          chrome.runtime.sendMessage({
            kind: 'download/progressive',
            url,
            tabId: -1,
          }),
        srv.progressiveUrl,
      );
      if (!start?.ok) {
        return {
          ok: false,
          detail: `download/progressive bị từ chối: ${JSON.stringify(start)}`,
        };
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
        return {
          ok: false,
          detail: `DownloadEntry kẹt ở "${entryState}" (popup sẽ hiện sai trạng thái)`,
        };
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
      if (!file)
        return { ok: false, detail: 'không có file nào rơi xuống đĩa' };
      if (file.state !== 'complete') {
        return {
          ok: false,
          detail: `download ${file.state}: ${file.error ?? '?'}`,
        };
      }
      if (!existsSync(file.filename)) {
        return {
          ok: false,
          detail: `downloads báo complete nhưng file không tồn tại: ${file.filename}`,
        };
      }
      const size = statSync(file.filename).size;
      const probe = probeFile(file.filename);
      if (probe.error)
        return {
          ok: false,
          detail: `ffprobe không đọc được file: ${probe.error}`,
        };
      if (!probe.codecs.includes('video')) {
        return {
          ok: false,
          detail: `file ra KHÔNG có track hình (streams: ${probe.codecs.join(',') || 'rỗng'})`,
        };
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
        (url) =>
          chrome.runtime.sendMessage({
            kind: 'manifest/variants',
            url,
            mediaType: 'hls',
          }),
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

/**
 * W1.5 — DASH tải được THẬT, và file ra phải có ĐỦ hình + tiếng.
 *
 * Vì sao ca này nặng ký: DASH LUÔN tách tiếng, và `resolvedUri` của MỌI representation (kể cả
 * tiếng) đều là chính file .mpd. Nghĩa là mọi tầng định danh track bằng URL sẽ IM LẶNG tải nhầm
 * — bệnh CÂM §2.1. Kiểm "có track audio" ở đây là thứ DUY NHẤT bắt được nó.
 */
async function runDashDownload() {
  const srv = await startDemuxedServer();
  try {
    return await withBrowser(async ({ page }) => {
      // Bước 1: liệt kê chất lượng như popup làm -> lấy id representation hình + tiếng.
      const vars = await page.evaluate(
        (url) =>
          chrome.runtime.sendMessage({
            kind: 'manifest/variants',
            url,
            mediaType: 'dash',
          }),
        srv.mpdUrl,
      );
      if (!vars?.ok)
        return {
          ok: false,
          detail: `manifest/variants lỗi: ${JSON.stringify(vars)}`,
        };
      const variant = vars.variants?.[0];
      const audioId = variant?.audioRenditions?.find((r) => r.selected)?.id;
      if (!variant?.id)
        return {
          ok: false,
          detail: `variant DASH không có id: ${JSON.stringify(vars)}`,
        };
      // Thiếu audioId = popup sẽ tải đường một-input -> file CÂM. Bắt ngay tại đây.
      if (!audioId) {
        return {
          ok: false,
          detail: `DASH không lộ ra rendition tiếng nào -> chắc chắn ra file CÂM (variant: ${JSON.stringify(variant)})`,
        };
      }

      // Bước 2: tải đúng như popup gửi.
      const start = await page.evaluate(
        ([variantUrl, mediaUrl, variantId, aId]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl,
            mediaUrl,
            tabId: -1,
            mediaType: 'dash',
            variantId,
            audioId: aId,
          }),
        [srv.mpdUrl, srv.mpdUrl, variant.id, audioId],
      );
      if (!start?.ok)
        return {
          ok: false,
          detail: `hls/download lỗi: ${JSON.stringify(start)}`,
        };

      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (job.phase !== 'done') {
        return {
          ok: false,
          detail: `job không xong: phase=${job.phase} error=${job.error ?? '-'}`,
        };
      }
      const file = await waitDownloadedFile(page, 30_000);
      if (!file) return { ok: false, detail: 'không thấy file trên đĩa' };
      if (file.state !== 'complete') {
        return {
          ok: false,
          detail: `download ${file.state}: ${file.error ?? '?'}`,
        };
      }
      if (!existsSync(file.filename)) {
        return {
          ok: false,
          detail: `downloads báo complete nhưng file không tồn tại: ${file.filename}`,
        };
      }

      const probe = probeFile(file.filename);
      if (probe.error)
        return { ok: false, detail: `ffprobe không đọc được: ${probe.error}` };
      if (!probe.codecs.includes('video')) {
        return {
          ok: false,
          detail: `file ra KHÔNG có hình (streams: ${probe.codecs.join(',') || 'rỗng'})`,
        };
      }
      // 🔴 Lưới CHỐNG CÂM — lý do ca này tồn tại.
      if (!probe.codecs.includes('audio')) {
        return {
          ok: false,
          detail: `file ra CÂM: không có track tiếng (streams: ${probe.codecs.join(',')}) — DASH tách tiếng bị bỏ rơi`,
        };
      }
      if (srv.dashAudioHits() === 0) {
        return {
          ok: false,
          detail:
            'không fetch segment tiếng DASH nào -> tiếng không thật sự được tải',
        };
      }
      const size = statSync(file.filename).size;
      return {
        ok: true,
        detail:
          `file ${(size / 1024).toFixed(0)}KB, ${probe.duration.toFixed(2)}s, ` +
          `track: ${probe.codecs.join('+')}, đã fetch ${srv.dashSegmentHits()} segment DASH ` +
          `(tiếng: ${srv.dashAudioHits()})`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W1.4 — chỗ nối (EXT-X-DISCONTINUITY) phải ĐẾM ĐƯỢC qua đúng đường popup dùng (`hls/estimate`),
 * và phải đếm ĐÚNG HAI CHIỀU.
 *
 * Vì sao cần cả chiều "sạch -> 0": cảnh báo oan làm user bỏ một lượt tải hoàn toàn khoẻ mạnh, mà
 * ca đó KHÔNG có triệu chứng nào để ai đi tìm. ĐO THẬT (m3u8-parser@7.2.0) cho thấy cách đếm hiển
 * nhiên `discontinuityStarts.length` sai cả hai chiều — nên chiều âm ở đây không phải thủ tục.
 *
 * Popup dựng câu cảnh báo từ ĐÚNG con số này; bản thân hộp thoại confirm thì e2e không với tới
 * (dự án chưa có test component React) — khoảng hở đó ghi rõ ở PROMPT-SESSION-MOI.md.
 */
async function runDiscontinuityCounted() {
  const srv = await startFixtureServer({ gate: 'none' });
  try {
    return await withBrowser(async ({ page }) => {
      const estimate = (url) =>
        page.evaluate(
          (u) =>
            chrome.runtime.sendMessage({
              kind: 'hls/estimate',
              variantUrl: u,
              mediaType: 'hls',
              tabId: -1,
            }),
          url,
        );

      const dirty = await estimate(srv.discontinuityUrl);
      if (!dirty?.ok)
        return {
          ok: false,
          detail: `hls/estimate lỗi trên playlist có chỗ nối: ${JSON.stringify(dirty)}`,
        };
      if (dirty.discontinuityCount !== 2) {
        return {
          ok: false,
          detail:
            `playlist có 2 chỗ nối nhưng estimate trả ${JSON.stringify(dirty.discontinuityCount)} ` +
            '-> popup KHÔNG cảnh báo được, user nhận file lệch tiếng kèm dấu tích xanh',
        };
      }

      const clean = await estimate(srv.mediaUrl);
      if (!clean?.ok)
        return {
          ok: false,
          detail: `hls/estimate lỗi trên playlist sạch: ${JSON.stringify(clean)}`,
        };
      if (clean.discontinuityCount !== 0) {
        return {
          ok: false,
          detail:
            `playlist SẠCH mà estimate trả ${JSON.stringify(clean.discontinuityCount)} chỗ nối ` +
            '-> cảnh báo OAN, user bỏ một lượt tải hoàn toàn khoẻ',
        };
      }
      return {
        ok: true,
        detail: `có chỗ nối -> ${dirty.discontinuityCount}; playlist sạch -> ${clean.discontinuityCount}`,
      };
    });
  } finally {
    await srv.close();
  }
}

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
    title:
      'Cổng 403 manifest: bấm "Chất lượng" -> spoof bật TRƯỚC fetch (W2.2) -> phải qua',
    // W2.2 XONG (2026-07-17): handleVariants nay applySpoof ÔM SÁT cú fetch -> qua cổng hotlink.
    // Ratchet đã bật đúng lúc sửa xong (known-fail -> pass), giờ là lưới chống hồi quy.
    expect: 'pass',
    run: () => runVariants({ gate: 'manifest' }),
  },
  {
    id: 'segments-other-host',
    title:
      'Segment ở host KHÁC manifest + cổng 403 -> spoof MỌI host đã parse (W2.3) -> tải trọn',
    // W2.3 XONG (2026-07-17): handleHlsDownload parse playlist TRƯỚC rồi spoof mọi host của
    // segment/key/init. Ratchet đã bật đúng lúc sửa xong (known-fail -> pass), nay là lưới hồi quy.
    expect: 'pass',
    run: () => runDownload({ gate: 'segments', segmentHost: 'localhost' }),
  },
  {
    id: 'progressive-403',
    title:
      'Cổng 403 mp4: tải progressive phải qua (W2.5 định tuyến qua offscreen -> fetch mang Referer)',
    // W2.5 XONG (2026-07-18): handleDownload định tuyến fetch qua offscreen (xmlhttprequest tab-less
    // -> khớp rule DNR). Ratchet đã bật đúng lúc sửa xong (known-fail -> pass), nay là lưới hồi quy.
    // ĐO 2026-07-18: đường cũ chrome.downloads.download thẳng -> server nhận ref=NONE -> 403.
    expect: 'pass',
    pins: '§2.5/W2.5 (progressive qua offscreen)',
    run: () => runProgressive({ gate: 'progressive' }),
  },
  {
    id: 'segment-stall',
    title:
      'Server câm giữa chừng: job phải BÁO LỖI có hạn (W2.6), không kẹt fetching vĩnh viễn',
    // W2.6 (2026-07-18): fetchWithRetry nay có đồng hồ chờ-header + đồng hồ im-lặng, ghép với
    // signal huỷ của job. Trước W2.6 ca này treo hết budget vì fetch không có signal nào.
    expect: 'pass',
    pins: '§2.9/W2.6 (retry không timeout/không huỷ được)',
    run: () => runSegmentStall(),
  },
  {
    id: 'offscreen-death',
    title:
      'Giết offscreen giữa lúc tải: job phải báo lỗi có hạn (W2.7), không quay spinner vĩnh viễn',
    expect: 'pass',
    pins: '§2.14/W2.7 (offscreen chết im lặng -> job kẹt fetching mãi)',
    run: () => runOffscreenDeath(),
  },
  {
    id: 'queued-not-reaped',
    title:
      'Job xếp hàng sau một job chạy dài KHÔNG được tick W2.7 giết oan (giết oan tệ hơn treo)',
    expect: 'pass',
    pins: 'W2.7 (nhịp tim phải phủ cả lúc XẾP HÀNG, không chỉ lúc đang chạy)',
    run: () => runQueuedJobNotReaped(),
  },
  {
    id: 'progressive-offscreen-death',
    title:
      'Giết offscreen giữa lúc tải .mp4: entry phải chốt interrupted, không kẹt in_progress vĩnh viễn',
    expect: 'pass',
    pins: 'W2.7 (W2.5 khiến progressive phụ thuộc offscreen — lưới liveness phải phủ cả đường này)',
    run: () => runProgressiveOffscreenDeath(),
  },
  {
    id: 'dash-download',
    title: 'DASH tải được THẬT và file ra có ĐỦ hình + tiếng (W1.5 nửa sau)',
    // Trước W1.5 nửa sau: nút tải DASH còn không tồn tại; nạp .mpd vào parser HLS ra 0 segment
    // mà KHÔNG ném lỗi -> mọi cổng tĩnh vẫn xanh. Ca này là thứ duy nhất chứng minh đường DASH sống.
    expect: 'pass',
    pins: '§2.8/W1.5 (DASH ngõ cụt + định danh track bằng URL -> file câm)',
    run: () => runDashDownload(),
  },
  {
    id: 'discontinuity-counted',
    title:
      'Playlist chèn quảng cáo -> đếm đúng 2 chỗ nối để popup cảnh báo; playlist sạch -> 0 (không doạ oan)',
    // Trước W1.4: HlsSegmentsResult không có trường nào về discontinuity -> ffmpeg nhận DTS không
    // đơn điệu, file lệch tiếng/sai thời lượng, mà job vẫn báo "Đã tải xong ✓".
    expect: 'pass',
    pins: '§2.?/W1.4 (discontinuity ghép mù -> file hỏng im lặng)',
    run: () => runDiscontinuityCounted(),
  },
  {
    id: 'drm-refused',
    title:
      'Trang xin DRM/EME -> TỪ CHỐI tải và nói rõ lý do; tab sạch vẫn tải được (ranh giới cứng §7)',
    expect: 'pass',
    pins: 'W7.1 (§7 tuyên bố ranh giới DRM mà grep requestMediaKeySystemAccess ra 0 hit)',
    run: () => runDrmRefused(),
  },
];

// --- Chạy --------------------------------------------------------------------------------------

let failed = false;
const only = process.argv[2];

console.log(
  'W0.3 — lưới an toàn tích hợp (extension thật + fixture 403 cục bộ)\n',
);

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
      console.log(
        `  ✗ RATCHET BẬT — ca này LẼ RA phải đỏ nhưng đã ĐẠT: ${r.detail}`,
      );
      console.log(
        `     => ${s.pins} đã được sửa. Đổi expect: 'known-fail' -> 'pass' trong e2e/hls-403.mjs.\n`,
      );
    }
  }
}

console.log(failed ? '✗ W0.3 THẤT BẠI' : '✓ W0.3 XANH');
process.exit(failed ? 1 : 0);
