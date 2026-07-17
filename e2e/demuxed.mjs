// Harness W1.1 — BỆNH CÂM (§2.1) đo trên fixture TÁCH TIẾNG cục bộ.
//
// ĐÂY LÀ CÂU HỎI TRUNG TÂM CỦA TOÀN DỰ ÁN: "file tải về có tiếng không?"
// Chủ dự án đã đo tay trên site thật (2026-07-17) -> CÂM. File này biến câu trả lời đó thành thứ
// máy tự đo được, tất định, offline, chạy trong 30 giây.
//
// VÌ SAO KHÔNG DÙNG e2e/real-demuxed.mjs (Apple bipbop fMP4): stream đó chết vì lỗi #30
// (fMP4/CMAF hỏng ở khâu ghép) TRƯỚC KHI ra file -> không bao giờ tới được câu hỏi câm.
// Fixture ở đây là MPEG-TS — đường đã chứng minh chạy tốt ở W0.3 -> cô lập ĐÚNG một biến: tiếng.
//
// VÌ SAO KHÔNG CẦN VLC: lộ trình ghi nghiệm thu W1.1 là "mở VLC nghe có tiếng". `ffprobe` trả lời
// đúng câu đó chắc chắn hơn tai người, nên nghiệm thu KHÔNG cần người bấm tay.
//
// 🔬 RATCHET TỰ BẬT (cùng cơ chế `it.fails` của W0.4 / `known-fail` của W0.3):
//   Hôm nay ca `mute` ĐỎ = bug §2.1 còn sống. Khi W1.1 xong nó sẽ ĐẠT -> harness ĐỎ NGƯỢC, ép đổi
//   nhãn `known-fail` -> `pass`. Không thể quên như TODO chết.
//
// Chạy: pnpm e2e:demuxed-fixture   (cần `pnpm build` trước; cần ffprobe)

import { startDemuxedServer } from './fixture-server.mjs';
import {
  requireBuild,
  withBrowser as withBrowserRaw,
  waitJob,
  waitDownloadedFile,
  probeFile,
} from './lib.mjs';
import { existsSync, statSync } from 'node:fs';

const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 120_000);
// Hình: 10 segment x 1s x 10fps. Đếm KHUNG chứ không đo thời lượng — thời lượng MÙ với lỗi mất
// segment (đã chứng minh bằng thực nghiệm ở W0.3, xem probeFile() trong lib.mjs).
const FIXTURE_FRAMES = 100;
const FIXTURE_DURATION = 10;
const DOWNLOAD_FOLDER = `yvim-demux-${process.pid}`;

requireBuild();

const withBrowser = (fn) => withBrowserRaw(DOWNLOAD_FOLDER, fn);

/**
 * Đi TRỌN đường của popup: bấm "Chất lượng" (manifest/variants) -> chọn variant -> "Tải .mp4".
 *
 * Cố ý KHÔNG hardcode URL playlist hình: harness phải đi qua đúng cửa mà popup đi, nếu không nó
 * sẽ bỏ lọt chính khâu parse master (nơi tiếng bốc hơi). URL tiếng lấy từ variant theo đúng giao
 * thức W1.1 — hôm nay trường đó chưa tồn tại -> `undefined` -> job chạy một-input -> CÂM.
 */
async function runDemuxedDownload() {
  const srv = await startDemuxedServer();
  try {
    return await withBrowser(async ({ page, logs }) => {
      const vres = await page.evaluate(
        (url) =>
          chrome.runtime.sendMessage({ kind: 'manifest/variants', url, mediaType: 'hls' }),
        srv.masterUrl,
      );
      if (!vres?.ok) {
        return { ok: false, detail: `manifest/variants hỏng: ${JSON.stringify(vres)}` };
      }
      const variant = vres.variants[0];
      if (!variant) return { ok: false, detail: 'master không ra variant nào' };
      if (variant.uri !== srv.videoUrl) {
        return { ok: false, detail: `variant trỏ sai playlist: ${variant.uri}` };
      }

      const start = await page.evaluate(
        ([v, mediaUrl]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl: v.uri,
            // Giao thức W1.1: URL luồng tiếng mà variant THẬT SỰ dùng. Hôm nay parser chưa điền
            // -> undefined -> đây chính là chỗ bệnh câm sinh ra.
            audioUrl: v.audioRenditions?.find((r) => r.selected)?.uri,
            mediaUrl,
            tabId: -1,
            height: v.height,
          }),
        [variant, srv.masterUrl],
      );
      if (!start?.ok) {
        return { ok: false, detail: `hls/download bị từ chối: ${JSON.stringify(start)}` };
      }

      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (!job) {
        return { ok: false, detail: `job TREO sau ${JOB_TIMEOUT_MS / 1000}s (không done/error)` };
      }
      if (job.phase !== 'done') {
        return { ok: false, detail: `job ${job.phase}: ${job.error ?? '?'}` };
      }
      const file = await waitDownloadedFile(page, 30_000);
      if (!file) return { ok: false, detail: 'job done nhưng KHÔNG có file nào rơi xuống đĩa' };
      if (!existsSync(file.filename)) {
        return { ok: false, detail: `downloads báo complete nhưng file không tồn tại` };
      }

      const size = statSync(file.filename).size;
      const probe = probeFile(file.filename);
      if (probe.error) return { ok: false, detail: `ffprobe không đọc được file ra: ${probe.error}` };

      const has = (t) => probe.codecs.includes(t);
      const tracks = probe.codecs.join('+') || 'rỗng';
      const hits = srv.audioSegmentHits();
      const errLog = logs.filter((l) => l.includes('error:')).slice(-3);
      const suffix =
        `— file ${(size / 1024).toFixed(0)}KB, ${probe.duration.toFixed(2)}s, ` +
        `${probe.videoFrames} khung, track: ${tracks}, đã fetch ${hits} segment tiếng` +
        `${errLog.length ? ` (log lỗi: ${errLog.join(' | ')})` : ''}`;

      if (!has('video')) return { ok: false, detail: `file ra KHÔNG có track hình ${suffix}` };
      // ĐÂY LÀ CÂU HỎI. Hôm nay: không có audio -> CÂM -> ca đỏ như dự kiến.
      if (!has('audio')) return { ok: false, detail: `CÂM: file ra KHÔNG có track tiếng ${suffix}` };
      // Ghép hai nguồn mà lệch thời lượng = tiếng không khớp hình -> tệ ngang câm, phải bắt.
      if (Math.abs(probe.duration - FIXTURE_DURATION) > 0.5) {
        return { ok: false, detail: `thời lượng lệch ${probe.duration.toFixed(2)}s ${suffix}` };
      }
      if (Math.abs(probe.videoFrames - FIXTURE_FRAMES) > 2) {
        return { ok: false, detail: `thiếu khung hình ${suffix}` };
      }
      return { ok: true, detail: `có ĐỦ hình + tiếng ${suffix}` };
    });
  } finally {
    await srv.close();
  }
}

const SCENARIOS = [
  {
    id: 'mute',
    title: 'Master tách tiếng -> file tải về phải có ĐỦ hình + tiếng',
    // ✅ W1.1 (2026-07-17): 'known-fail' -> 'pass'. Ratchet đã TỰ BẬT đúng như thiết kế: ngay khi
    // bản sửa chạy được, ca này ĐẠT và harness ĐỎ NGƯỢC đòi đổi nhãn — không cần ai nhớ.
    // Trước bản sửa: "CÂM: file ra KHÔNG có track tiếng — 81KB, track: video, đã fetch 0 segment
    // tiếng". Sau: "164KB, track: video+audio, đã fetch 11 segment tiếng".
    // Từ đây ca này là LƯỚI CHỐNG TÁI PHÁT: bệnh câm quay lại -> đỏ ngay.
    expect: 'pass',
    run: runDemuxedDownload,
  },
];

let failed = false;
console.log('W1.1 — bệnh câm trên fixture tách tiếng cục bộ (extension thật)\n');

for (const s of SCENARIOS) {
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
      failed = true;
      console.log(`  ✗ RATCHET BẬT — ca này LẼ RA phải đỏ nhưng đã ĐẠT: ${r.detail}`);
      console.log(`     => ${s.pins} đã sửa xong. Đổi expect: 'known-fail' -> 'pass' trong e2e/demuxed.mjs.\n`);
    }
  }
}

console.log(failed ? '✗ W1.1 harness THẤT BẠI' : '✓ W1.1 harness XANH (bug ghim vẫn đỏ đúng dự kiến)');
process.exit(failed ? 1 : 0);
