// Harness: BỆNH CÂM (§2.1) trên stream TÁCH TIẾNG công khai — đây là câu hỏi trung tâm của dự án.
//
// VÌ SAO KHÔNG DÙNG TWITTER/X: X đòi đăng nhập -> máy không tự chạy được. Nhưng bệnh câm KHÔNG
// phải đặc sản của X: nó bắn trên MỌI master playlist mà luồng tiếng nằm ở rendition riêng
// (`#EXT-X-MEDIA:TYPE=AUDIO` + variant có `AUDIO="..."`). Stream mẫu công khai của Apple có ĐÚNG
// cấu trúc đó (ĐÃ ĐO 2026-07-17: 3 group tiếng `aud1/aud2/aud3`, mỗi group có URI riêng, cộng 1
// group phụ đề `sub1`) -> thay thế X hợp lệ, không cần tài khoản ai cả.
//
// VÌ SAO KHÔNG CẦN VLC: `ffprobe` trả lời "file ra có track tiếng không" chắc chắn hơn tai người.
// Lộ trình ghi nghiệm thu W1.1 là "mở VLC nghe có tiếng" — máy làm được việc đó, và làm chính xác hơn.
//
// 🔬 RATCHET TỰ BẬT: hôm nay ca này ĐỎ (file ra CÂM = bug §2.1 còn sống). Khi W1.1 xong, nó sẽ ĐẠT
// -> harness ĐỎ NGƯỢC đòi đổi `EXPECT_MUTE` thành false. Không thể quên như TODO chết.
//
// 🔴 TRẠNG THÁI 2026-07-17 — CHƯA TỚI ĐƯỢC CÂU HỎI CÂM: chạy thật thì job fetch trọn 100/100 segment
// rồi CHẾT ở khâu ghép với `FS error` (lỗi #30 — fMP4/CMAF hỏng + `exec` bị vứt mã lỗi, xem
// PROMPT-THUC-THI.md §2b). Nên file này hiện đo được **lỗi #30**, chưa đo được bệnh câm.
// 👉 Muốn đo bệnh câm SỚM mà không chờ sửa lỗi #30: dựng fixture demuxed **TS** cục bộ (ffmpeg sinh
//    được master + playlist hình + playlist tiếng riêng) — đường TS đã chứng minh chạy tốt ở W0.3.
//
// Chạy: pnpm e2e:demuxed   (cần `pnpm build` trước; cần ffprobe)

import {
  requireBuild,
  withBrowser,
  waitJob,
  waitDownloadedFile,
  probeFile,
} from './lib.mjs';
import { existsSync, statSync } from 'node:fs';

// Master công khai, KHÔNG cần đăng nhập, tách tiếng + có phụ đề (fMP4/CMAF).
const MASTER_URL =
  'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8';

// Hôm nay bug §2.1 còn sống -> file ra PHẢI câm. Đổi thành false khi W1.1 xong.
const EXPECT_MUTE = true;

const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 600_000);
const DOWNLOAD_FOLDER = `yvim-demuxed-${process.pid}`;

requireBuild();

console.log('Bệnh câm (§2.1) trên stream TÁCH TIẾNG công khai (Apple, fMP4)\n');

const result = await withBrowser(DOWNLOAD_FOLDER, async ({ page, logs }) => {
  const bail = (msg) => ({
    fatal: msg,
    logs: logs.filter((l) => /error|ffmpeg|FS|Error/i.test(l)).slice(-25),
  });
  // --- Bước 1: bấm "Chất lượng" y như popup làm ---
  const vres = await page.evaluate(
    (url) => chrome.runtime.sendMessage({ kind: 'manifest/variants', url, mediaType: 'hls' }),
    MASTER_URL,
  );
  if (!vres?.ok) return bail(`manifest/variants hỏng: ${vres?.error ?? JSON.stringify(vres)}`);
  console.log(`  ✓ Ra ${vres.variants.length} chất lượng`);

  // Chọn variant NHỎ NHẤT cho nhanh — bệnh câm không phụ thuộc bitrate.
  const variant = [...vres.variants].sort(
    (a, b) => (a.height ?? 1e9) - (b.height ?? 1e9) || (a.bandwidth ?? 0) - (b.bandwidth ?? 0),
  )[0];
  console.log(`  → tải variant ${variant.height ?? '?'}p (${variant.bandwidth ?? '?'} bps)`);

  // --- Bước 2: tải thật ---
  const start = await page.evaluate(
    ([variantUrl, mediaUrl, height]) =>
      chrome.runtime.sendMessage({ kind: 'hls/download', variantUrl, mediaUrl, tabId: -1, height }),
    [variant.uri, MASTER_URL, variant.height],
  );
  if (!start?.ok) return bail(`hls/download bị từ chối: ${JSON.stringify(start)}`);

  const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
  if (!job) return bail(`job TREO sau ${JOB_TIMEOUT_MS / 1000}s`);
  if (job.phase !== 'done') return bail(`job ${job.phase}: ${job.error ?? '?'}`);

  // --- Bước 3: soi file ra — CÓ TIẾNG KHÔNG? ---
  const file = await waitDownloadedFile(page, 60_000);
  if (!file) return bail('job done nhưng KHÔNG có file nào rơi xuống đĩa');
  if (file.state !== 'complete') return bail(`download ${file.state}: ${file.error ?? '?'}`);
  if (!existsSync(file.filename)) return bail(`file không tồn tại: ${file.filename}`);

  // countFrames: false — stream này dài, đếm khung tốn thời gian mà câu hỏi ở đây là track tiếng.
  const probe = probeFile(file.filename, { countFrames: false });
  if (probe.error) return bail(`ffprobe không đọc được: ${probe.error}`);

  return {
    sizeMB: statSync(file.filename).size / 1024 / 1024,
    segments: job.segmentsTotal,
    probe,
  };
});

if (result.fatal) {
  console.log(`\n✗ Không kết luận được: ${result.fatal}`);
  if (result.logs?.length) {
    console.log('\n--- log các ngữ cảnh (kể cả offscreen) ---');
    for (const l of result.logs) console.log(`  ${l}`);
  }
  process.exit(1);
}

const { probe, sizeMB, segments } = result;
console.log(
  `\n  File ra: ${sizeMB.toFixed(1)}MB, ${probe.duration.toFixed(1)}s, ${segments} segment\n` +
    `  Track:   ${probe.codecs.join(' + ') || '(rỗng)'}  [${probe.codecNames.join(', ')}]\n` +
    `  CÓ TIẾNG? ${probe.hasAudio ? 'CÓ' : 'KHÔNG — CÂM'}\n`,
);

if (EXPECT_MUTE) {
  if (!probe.hasAudio) {
    console.log('⊘ ĐỎ NHƯ DỰ KIẾN — file ra CÂM. Bug §2.1 CÒN SỐNG, nay đã đo được trên stream thật.');
    console.log('   ghim: §2.1 -> gói W1.1 (ghép luồng tiếng tách rời)');
    console.log('\n✓ Kết luận thu được (bug đã được xác nhận bằng chạy thật)');
    process.exit(0);
  }
  console.log('✗ RATCHET BẬT — file ra CÓ TIẾNG, tức §2.1 đã được sửa.');
  console.log('   => Đổi EXPECT_MUTE thành false trong e2e/real-demuxed.mjs.');
  process.exit(1);
}

if (probe.hasAudio) {
  console.log('✓ ĐẠT — file ra CÓ TIẾNG. W1.1 hoạt động trên stream tách tiếng thật.');
  process.exit(0);
}
console.log('✗ HỎNG — file ra vẫn CÂM dù W1.1 lẽ ra đã xong.');
process.exit(1);
