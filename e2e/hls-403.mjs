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

import { PLAYER_TOKEN, startFixtureServer, startDemuxedServer } from './fixture-server.mjs';
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
 * W3.1 — tải trọn một stream HLS **MÃ HOÁ AES-128** rồi kiểm file ra.
 *
 * VÌ SAO CA NÀY ĐÁNG TIỀN: AES-128 là nhánh giải mã duy nhất §7 cho phép, nhưng suốt BA phiên
 * chưa lần nào có máy đo chạm vào — cả 502 unit test lẫn 17 ca e2e đều chạy stream KHÔNG mã hoá.
 * `utils/crypto.test.ts` chứng minh `decryptAes128Cbc()` giải đúng, nhưng KHÔNG thể thấy
 * `downloadTrack()` có gọi nó với đúng khoá và đúng IV hay không — đúng lớp lỗi mà cổng tĩnh mù.
 *
 * VÌ SAO 100 KHUNG LÀ CHỨNG CỨ ĐỦ MẠNH (cho KHOÁ): segment ở đây là ĐÚNG 10 segment plaintext
 * của ca `happy` đem mã hoá, nên đường đi đúng phải cho ra file trùng khít ca đó. Sai KHOÁ thì ra
 * byte ngẫu nhiên — MPEG-TS mất đồng bộ, không có đường nào ra đúng 100 khung.
 *
 * 🔴 NHƯNG KHÔNG PHẢI CHO IV — ĐÃ ĐO, đừng tin ngược lại: đột biến thay `seg.seq` bằng chỉ số mảng,
 * và đột biến bỏ qua `#EXT-X-KEY:IV=`, đều để mấy ca này VẪN XANH. CBC chỉ cho IV chi phối 16 byte
 * đầu mỗi segment: lệch đúng 10/143.444 byte, cùng 100 khung, cùng md5 luồng hình, file .mp4 ra
 * GIỐNG HỆT TỪNG BYTE. Lưới cho IV nằm ở `utils/crypto.test.ts`, KHÔNG nằm ở đây.
 *
 * ⚠️ Cố tình KHÔNG dùng chung thân với runDownload(): 17 ca đang xanh chạy qua hàm đó, và món nợ
 * đang trả là "thiếu lưới", không phải "thiếu gọn". Gộp lại thì lần sửa nào ở đây cũng thành rủi
 * ro cho cả 17 ca kia.
 */
async function runAesDownload({
  variant,
  gate = 'none',
  wantKeyFetches = 1,
  keyHost = null,
}) {
  const srv = await startFixtureServer({ gate, keyHost });
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
        [srv.aesUrl(variant), srv.masterUrl],
      );
      if (!start?.ok) {
        return {
          ok: false,
          detail: `hls/download bị từ chối: ${JSON.stringify(start)}`,
        };
      }
      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (!job) return { ok: false, detail: 'job TREO (không done/error)' };
      if (job.phase !== 'done') {
        const b = srv.blocked().length;
        return {
          ok: false,
          detail:
            `job ${job.phase}: ${job.error ?? '?'}` +
            `${b ? ` — server đã chặn ${b} request vì thiếu Referer` : ''}`,
        };
      }
      const file = await waitDownloadedFile(page, 30_000);
      if (!file)
        return { ok: false, detail: 'job done nhưng KHÔNG có file trên đĩa' };
      if (file.state !== 'complete')
        return {
          ok: false,
          detail: `download ${file.state}: ${file.error ?? '?'}`,
        };
      if (!existsSync(file.filename))
        return {
          ok: false,
          detail: `downloads báo complete nhưng file không tồn tại: ${file.filename}`,
        };

      // Cổng SỐ MỘT: khoá có được kéo về ĐÚNG số lần không.
      //   THIẾU  -> playlist không được nhận là mã hoá, hoặc cụm khoá thứ hai bị bôi bằng khoá đầu.
      //   THỪA   -> cache khoá thủng, mỗi segment lại đi xin khoá một lần (CDN hay giới hạn nhịp
      //             đúng endpoint này, nên request thừa là rủi ro thật, không phải chuyện thẩm mỹ).
      // Ghim BẰNG ĐÚNG chứ không phải >=: con số này TẤT ĐỊNH sau bản vá cache-promise (đã đo —
      // trước bản vá nó chạy 3-5 và đổi theo từng lượt chạy, đúng dấu hiệu của cache thủng).
      const keyHits = srv.aesKeyHits();
      if (keyHits !== wantKeyFetches) {
        return {
          ok: false,
          detail:
            `${keyHits} lượt fetch khoá AES, mong đợi ĐÚNG ${wantKeyFetches} ` +
            (keyHits < wantKeyFetches
              ? '-> thiếu khoá: nhánh giải mã không chạy, hoặc khoá đầu bị bôi ra cả stream'
              : '-> cache khoá thủng: mỗi segment lại đi xin khoá một lần'),
        };
      }

      const size = statSync(file.filename).size;
      const probe = probeFile(file.filename);
      if (probe.error) {
        return {
          ok: false,
          detail:
            `ffprobe không đọc được file ra: ${probe.error} ` +
            '-> nhiều khả năng giải mã SAI (byte rác vẫn ghi ra file được)',
        };
      }
      if (!probe.codecs.includes('video')) {
        return {
          ok: false,
          detail:
            `file ra KHÔNG có track hình (streams: ${probe.codecs.join(',') || 'rỗng'}) ` +
            '-> giải mã sai làm mất đồng bộ MPEG-TS',
        };
      }
      if (Math.abs(probe.videoFrames - FIXTURE_FRAMES) > 2) {
        return {
          ok: false,
          detail:
            `thiếu khung hình: đọc được ${probe.videoFrames}, mong đợi ${FIXTURE_FRAMES} ` +
            '-> giải mã sai ở MỘT SỐ segment (sai IV/sai khoá cụm sau), phần còn lại vẫn đúng ' +
            'nên file vẫn mở được — đây chính là dạng hỏng ÂM THẦM',
        };
      }
      return {
        ok: true,
        detail:
          `file ${(size / 1024).toFixed(0)}KB, ${probe.duration.toFixed(2)}s, ` +
          `${probe.videoFrames} khung, ${keyHits} lượt fetch khoá, track: ${probe.codecs.join('+')}`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W3.1 — KHOÁ AES HỎNG thì lỗi phải NÓI ĐƯỢC THÀNH LỜI.
 *
 * 🔴 ĐÃ ĐO (2026-07-19) trên chính bản đang chạy: cho khoá sai -> job kết thúc `phase: 'error'`
 * với **`error: ""`** — chuỗi RỖNG. Popup hiện một dòng đỏ TRỐNG KHÔNG. Nguyên nhân: WebCrypto
 * ném `DOMException(OperationError)` mà `message` của nó rỗng trong Chromium, và đường lỗi chỉ
 * chuyển tiếp `e.message`.
 *
 * Đây đúng dạng lỗi dự án cấm: hỏng mà KHÔNG NÓI GÌ. Người dùng không thể phân biệt "sai khoá"
 * với "mất mạng" với "hết đĩa". Ca này đòi thông báo phải NHẮC TỚI khoá/giải mã.
 *
 * Hai biến thể vì hai đường ném KHÁC NHAU, đừng gộp:
 *   `bad`    khoá đúng 16 byte nhưng SAI giá trị -> ném ở bước bỏ padding (decrypt).
 *   `badlen` server trả trang HTML thay khoá     -> ném ở GUARD ĐỘ DÀI trong `decryptSegment`,
 *            TRƯỚC khi `importKey` được gọi. Guard đó không thừa: thiếu nó thì user nhận câu
 *            tiếng Anh "AES key data must be 128 or 256 bits" thay vì lời đọc được.
 */
async function runAesBadKey({ variant, wantMessage }) {
  const srv = await startFixtureServer({ gate: 'none' });
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
        [srv.aesUrl(variant), srv.masterUrl],
      );
      if (!start?.ok) {
        return {
          ok: false,
          detail: `hls/download bị từ chối: ${JSON.stringify(start)}`,
        };
      }
      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (!job) return { ok: false, detail: 'job TREO (không done/error)' };

      // Giao file ra khi khoá sai còn TỆ HƠN báo lỗi: user nhận .mp4 rác kèm dấu tích xanh.
      if (job.phase !== 'error') {
        return {
          ok: false,
          detail:
            `khoá SAI mà job kết thúc '${job.phase}' — lẽ ra phải 'error'. ` +
            'Giao file rác kèm dấu tích xanh là hỏng nặng hơn báo lỗi.',
        };
      }
      const msg = String(job.error ?? '');
      if (!msg.trim()) {
        return {
          ok: false,
          detail:
            'job error nhưng THÔNG BÁO RỖNG — popup hiện dòng đỏ trống không, user không thể ' +
            'phân biệt sai khoá / mất mạng / hết đĩa (WebCrypto OperationError có message rỗng)',
        };
      }
      if (!/khoá|giải mã/i.test(msg)) {
        return {
          ok: false,
          detail: `thông báo không nhắc tới khoá/giải mã nên vô nghĩa với user: "${msg}"`,
        };
      }
      // Assertion RIÊNG mỗi biến thể. Nếu cả hai chỉ đòi /khoá|giải mã/ thì câu bọc lỗi chung đã
      // thoả sẵn, và guard "khoá phải đúng 16 byte" xoá đi lúc nào cũng không ai biết (đã đo:
      // gỡ guard -> ca vẫn xanh vì lỗi importKey rơi vào đúng câu bọc đó).
      if (wantMessage && !wantMessage.test(msg)) {
        return {
          ok: false,
          detail:
            `thông báo không nói đúng NGUYÊN NHÂN của ca này (${wantMessage}): "${msg}"`,
        };
      }
      // Chống giao file rác: báo lỗi rồi mà vẫn thả file xuống đĩa thì user vẫn nhận .mp4 hỏng.
      const file = await waitDownloadedFile(page, 3_000);
      if (file) {
        return {
          ok: false,
          detail: `báo lỗi ĐÚNG nhưng vẫn giao file xuống đĩa: ${file.filename}`,
        };
      }
      return { ok: true, detail: `báo lỗi rõ ràng: "${msg}"` };
    });
  } finally {
    await srv.close();
  }
}

/**
 * GÓI A — HLS **fMP4/CMAF** (`#EXT-X-MAP`), có/không mã hoá AES-128.
 *
 * VÌ SAO CA NÀY TỒN TẠI: phiên 2026-07-20 vá chỗ "init segment không được giải mã" theo RFC 8216
 * §4.3.2.5, nhưng **chưa có máy đo nào chạy bản vá đó** — mọi ca AES đang có đều là MPEG-TS, mà TS
 * không có `#EXT-X-MAP` nên nhánh init không bao giờ được đụng tới. Nợ này là món rõ nhất còn lại
 * của W3.1.
 *
 * 🔬 VÌ SAO fMP4 CÓ RĂNG TRONG KHI TS THÌ KHÔNG — đây là điểm cốt lõi, đã đo bằng node:
 * 16 byte đầu của init (sau giải mã) là `0000001c 66747970 69736f35 00000200`, tức box `ftyp`.
 * AES-CBC cho IV chi phối ĐÚNG khối 16 byte đầu — trên TS thì 16 byte đó chỉ là một gói TS và
 * ffmpeg tự đồng bộ lại (đo được: lệch 10/143.444 byte, file .mp4 ra GIỐNG HỆT TỪNG BYTE). Trên
 * fMP4 thì 16 byte đó là magic + kích thước box, hỏng là libav không nhận ra định dạng.
 * => ĐÂY là chỗ duy nhất trong bộ e2e mà lỗi tầng init/IV trở nên QUAN SÁT ĐƯỢC.
 *
 * `wantKeyHits` là cổng độc lập với nội dung file: 0 cho biến thể không mã hoá (chống "giải mã
 * oan"), đúng 1 mỗi track cho biến thể mã hoá (chống cache khoá thủng).
 */
async function runFmp4Download({
  variant,
  demuxed = false,
  wantKeyHits = 0,
  wantAudio = false,
}) {
  const srv = await startFixtureServer({ gate: 'none' });
  try {
    return await withBrowser(async ({ page }) => {
      // Biến thể tách tiếng đi TRỌN đường popup (master -> variant -> audioUrl), vì chính khâu
      // parse master là nơi luồng tiếng hay bốc hơi (bài học W1.1).
      let variantUrl = srv.fmp4Url(variant, 'v');
      let audioUrl;
      const mediaUrl = demuxed
        ? srv.fmp4MasterUrl(variant)
        : srv.fmp4Url(variant, 'v');
      if (demuxed) {
        const vres = await page.evaluate(
          (url) =>
            chrome.runtime.sendMessage({
              kind: 'manifest/variants',
              url,
              mediaType: 'hls',
            }),
          mediaUrl,
        );
        if (!vres?.ok) {
          return {
            ok: false,
            detail: `manifest/variants hỏng: ${JSON.stringify(vres)}`,
          };
        }
        const v = vres.variants?.[0];
        if (!v) return { ok: false, detail: 'master fMP4 không ra variant nào' };
        variantUrl = v.uri;
        audioUrl = v.audioRenditions?.find((r) => r.selected)?.uri;
        if (!audioUrl) {
          return {
            ok: false,
            detail:
              'master khai #EXT-X-MEDIA:TYPE=AUDIO nhưng variant không mang rendition tiếng nào ' +
              '-> job sẽ chạy một-input và file ra CÂM',
          };
        }
      }

      const start = await page.evaluate(
        ([vUrl, aUrl, mUrl]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl: vUrl,
            ...(aUrl ? { audioUrl: aUrl } : {}),
            mediaUrl: mUrl,
            tabId: -1,
          }),
        [variantUrl, audioUrl ?? null, mediaUrl],
      );
      if (!start?.ok) {
        return {
          ok: false,
          detail: `hls/download bị từ chối: ${JSON.stringify(start)}`,
        };
      }
      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (!job) return { ok: false, detail: 'job TREO (không done/error)' };
      if (job.phase !== 'done') {
        // Lời chẩn đoán phải ĐÚNG với biến thể đang chạy. Câu "init không được giải mã" mà dán
        // lên cả biến thể KHÔNG mã hoá thì chính nó là một khẳng định sai — đúng thứ luật dự án
        // gọi là lỗi (đã đo: đột biến bỏ #EXT-X-MAP làm ca `plain` đỏ kèm câu chẩn đoán sai này).
        const hint = wantKeyHits
          ? 'init (#EXT-X-MAP) nhiều khả năng KHÔNG được giải mã: ciphertext nằm đúng chỗ ' +
            'ftyp/moov nên libav không nhận ra định dạng'
          : 'stream KHÔNG mã hoá mà vẫn hỏng -> nhiều khả năng init (#EXT-X-MAP) bị bỏ qua ' +
            'hoặc ghi sai vị trí (init phải nằm TRƯỚC segment đầu)';
        return {
          ok: false,
          detail: `job ${job.phase}: ${job.error ?? '?'} -> ${hint}`,
        };
      }

      // Cổng 1: init có thật sự được kéo về không. Bản nào bỏ qua #EXT-X-MAP sẽ ra file thiếu
      // header — và với fMP4 thì thiếu header là mất TOÀN BỘ mô tả track, không phải lỗi mép.
      const initHits = srv.fmp4InitHits();
      if (initHits < (demuxed ? 2 : 1)) {
        return {
          ok: false,
          detail: `chỉ ${initHits} lượt fetch init (#EXT-X-MAP) — nhánh init không chạy`,
        };
      }
      // Cổng 2: số lượt lấy khoá. 0 = không giải mã oan trên stream sạch; đúng N = cache khoá lành.
      const keyHits = srv.fmp4KeyHits();
      if (keyHits !== wantKeyHits) {
        return {
          ok: false,
          detail:
            `${keyHits} lượt fetch khoá AES, mong đợi ĐÚNG ${wantKeyHits}` +
            (wantKeyHits === 0
              ? ' -> stream KHÔNG mã hoá mà vẫn đi xin khoá: giải mã oan'
              : keyHits < wantKeyHits
                ? ' -> thiếu khoá: track nào đó không được giải mã (hoặc bị bôi khoá của track kia)'
                : ' -> cache khoá thủng'),
        };
      }
      if (demuxed) {
        // Ghim nhánh "mỗi track một #EXT-X-KEY RIÊNG": hai khoá KHÁC NHAU, mỗi bên đúng 1 lượt.
        const kv = srv.fmp4KeyHits('v');
        const ka = srv.fmp4KeyHits('a');
        if (kv !== 1 || ka !== 1) {
          return {
            ok: false,
            detail: `khoá hình ${kv} lượt / khoá tiếng ${ka} lượt — mỗi bên phải ĐÚNG 1`,
          };
        }
      }

      const file = await waitDownloadedFile(page, 30_000);
      if (!file)
        return { ok: false, detail: 'job done nhưng KHÔNG có file trên đĩa' };
      if (file.state !== 'complete')
        return {
          ok: false,
          detail: `download ${file.state}: ${file.error ?? '?'}`,
        };
      if (!existsSync(file.filename))
        return {
          ok: false,
          detail: `downloads báo complete nhưng file không tồn tại: ${file.filename}`,
        };
      const size = statSync(file.filename).size;
      const probe = probeFile(file.filename);
      if (probe.error) {
        return {
          ok: false,
          detail:
            `ffprobe không đọc được file ra: ${probe.error} ` +
            '-> init hỏng thì mọi mô tả track biến mất, file chỉ còn là đống byte',
        };
      }
      if (!probe.codecs.includes('video')) {
        return {
          ok: false,
          detail: `file ra KHÔNG có track hình (streams: ${probe.codecs.join(',') || 'rỗng'})`,
        };
      }
      if (wantAudio && !probe.codecs.includes('audio')) {
        return {
          ok: false,
          detail:
            `file ra KHÔNG có track tiếng (streams: ${probe.codecs.join(',')}) ` +
            '-> luồng tiếng có khoá RIÊNG bị rơi',
        };
      }
      if (Math.abs(probe.videoFrames - FIXTURE_FRAMES) > 2) {
        return {
          ok: false,
          detail:
            `thiếu khung hình: đọc được ${probe.videoFrames}, mong đợi ${FIXTURE_FRAMES} ` +
            '-> mất segment .m4s, hoặc một phần giải mã sai',
        };
      }
      return {
        ok: true,
        detail:
          `file ${(size / 1024).toFixed(0)}KB, ${probe.duration.toFixed(2)}s, ` +
          `${probe.videoFrames} khung, ${initHits} lượt init, ${keyHits} lượt khoá, ` +
          `track: ${probe.codecs.join('+')}`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * §7 — PLAYLIST KHAI DRM PHẢI BỊ TỪ CHỐI, VÀ KHÔNG ĐƯỢC TẢI LẤY MỘT SEGMENT.
 *
 * 🔴 LỖ HỔNG THẬT ĐÃ ĐO 2026-07-19 (trước bản vá): FairPlay/PlayReady/Widevine đều cho
 * `isProtected=false` vì m3u8-parser nuốt `segment.key` khi KEYFORMAT không phải identity. Ranh
 * giới cứng §7 — thứ CLAUDE.md gọi là "KHÔNG VƯỢT" — khi đó thủng với đúng ba hệ phổ biến nhất.
 *
 * Ca này ghim HAI thứ, và thứ hai mới là thứ khó:
 *   1. job phải kết thúc `error` với thông báo NÊU TÊN HÃNG (user cần biết vì sao, không phải một
 *      câu "không hỗ trợ" trống không).
 *   2. server phải KHÔNG phục vụ một segment nào. Nếu chỉ kiểm thông báo thì bản nào tải xong rồi
 *      mới từ chối vẫn xanh — mà tải nội dung được bảo vệ về máy CHÍNH LÀ điều §7 cấm.
 */
async function runDrmPlaylistRefused({ system, wantName }) {
  const srv = await startFixtureServer({ gate: 'none' });
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
        [srv.drmUrl(system), srv.masterUrl],
      );
      // Từ chối ngay ở cửa cũng hợp lệ — miễn là có lý do rõ.
      if (!start?.ok) {
        const msg = String(start?.error ?? '');
        if (!/bảo vệ|DRM/i.test(msg)) {
          return {
            ok: false,
            detail: `bị từ chối nhưng không nói lý do DRM: ${JSON.stringify(start)}`,
          };
        }
        return { ok: true, detail: `từ chối ngay ở cửa: "${msg}"` };
      }
      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (!job) return { ok: false, detail: 'job TREO (không done/error)' };
      if (job.phase !== 'error') {
        return {
          ok: false,
          detail:
            `RANH GIỚI §7 THỦNG: job kết thúc '${job.phase}' trên playlist ${system}. ` +
            'Extension vừa tải nội dung được bảo vệ và giao file kèm dấu tích xanh.',
        };
      }
      const msg = String(job.error ?? '');
      if (!/bảo vệ|DRM/i.test(msg)) {
        return {
          ok: false,
          detail: `job lỗi nhưng không nói là nội dung được bảo vệ: "${msg}"`,
        };
      }
      if (wantName && !msg.includes(wantName)) {
        return {
          ok: false,
          detail: `thông báo không nêu tên hãng "${wantName}": "${msg}"`,
        };
      }
      // Cổng THẬT SỰ khó: có byte nội dung nào bị kéo về không.
      const hits = srv.plainSegmentHits();
      if (hits > 0) {
        return {
          ok: false,
          detail:
            `báo lỗi ĐÚNG nhưng đã kịp tải ${hits} segment nội dung được bảo vệ ` +
            '-> vẫn là vượt ranh giới §7, chỉ là vượt xong mới xin lỗi',
        };
      }
      return { ok: true, detail: `từ chối đúng, 0 segment bị tải: "${msg}"` };
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

/**
 * W2.1 — BẮT & PHÁT LẠI header THẬT của player, thay vì BỊA Referer/Origin (§2.11).
 *
 * VÌ SAO CA NÀY LÀ THỨ DUY NHẤT CHỨNG MINH ĐƯỢC W2.1: cổng `Referer` mà các ca trước dùng thì bản
 * BỊA cũng qua được — Referer suy ra từ `pageUrl` là xong. Ở đây server đòi
 * `X-Playback-Session-Id: <token ngẫu nhiên do trang sinh>`. Token đó KHÔNG suy được từ URL, host,
 * hay pageUrl; con đường DUY NHẤT để extension có nó là nghe `onSendHeaders` lúc player của trang
 * fetch manifest, rồi phát lại qua DNR. Bản BỊA trượt cổng này 100%.
 *
 * Trình tự: mở trang player (player tự fetch manifest kèm token) -> extension bắt được header ->
 * user bấm tải -> mọi request của extension phải mang token thì mới qua nổi 403.
 */
async function runRealHeaderReplay() {
  const srv = await startFixtureServer({ tokenGate: true });
  try {
    return await withBrowser(async ({ page }) => {
      // Bước 1: trang player chạy thật trong TAB RIÊNG (không đụng `page` — đó là trang extension,
      // nơi duy nhất đọc được chrome.storage), phát request có token -> extension quan sát được.
      const playerTab = await page.context().newPage();
      await playerTab.goto(srv.playerPageUrl);
      const played = await playerTab.evaluate(() => window.__played);
      if (!played) {
        return {
          ok: false,
          detail: 'harness hỏng: player của trang không fetch được manifest',
        };
      }
      // Bước 2: chờ background ghi xong bản chụp header vào storage.session. Khoá `media:<tabId>`
      // cho luôn tabId của tab player -> khỏi phải đoán bằng chrome.tabs.query.
      const found = await page.evaluate(async (masterUrl) => {
        for (let i = 0; i < 40; i++) {
          const all = await chrome.storage.session.get(null);
          for (const [k, v] of Object.entries(all)) {
            if (!k.startsWith('media:')) continue;
            const hit = (v?.items ?? []).find((m) => m.url === masterUrl);
            if (hit?.sentHeaders) {
              return { headers: hit.sentHeaders, tabId: Number(k.slice(6)) };
            }
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        return null;
      }, srv.masterUrl);
      const captured = found?.headers;
      if (!captured) {
        return {
          ok: false,
          detail:
            'KHÔNG bắt được header nào của player (onSendHeaders không chạy, ' +
            'hoặc bản chụp bị nuốt ở merge upsertMedia)',
        };
      }
      if (captured['x-playback-session-id'] !== PLAYER_TOKEN) {
        return {
          ok: false,
          detail: `bắt được header nhưng thiếu/sai token: ${JSON.stringify(captured)}`,
        };
      }

      // Bước 3: tải thật — mọi request phải mang token mới qua được cổng 403.
      const tabId = found.tabId;
      const start = await page.evaluate(
        ([variantUrl, mediaUrl, tid]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl,
            mediaUrl,
            tabId: tid,
          }),
        [srv.mediaUrl, srv.masterUrl, tabId],
      );
      if (!start?.ok) {
        return {
          ok: false,
          detail: `hls/download bị từ chối: ${JSON.stringify(start)}`,
        };
      }
      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (!job) {
        return { ok: false, detail: `job TREO sau ${JOB_TIMEOUT_MS / 1000}s` };
      }
      if (job.phase !== 'done') {
        const bad = srv.requests.filter((r) => r.status === 403).length;
        return {
          ok: false,
          detail:
            `job ${job.phase}: ${job.error ?? '?'} — server đã 403 ${bad} request ` +
            'vì thiếu token (header thật KHÔNG được phát lại)',
        };
      }
      // Bằng chứng dương: có request của extension mang đúng token tới server.
      const withToken = srv.requests.filter(
        (r) => r.token === PLAYER_TOKEN && r.status === 200,
      ).length;
      const blocked = srv.requests.filter((r) => r.status === 403).length;
      return {
        ok: true,
        detail: `${withToken} request mang token thật qua cổng, ${blocked} bị chặn`,
      };
    });
  } finally {
    await srv.close();
  }
}

/**
 * W2.1 debt (a) — two HLS downloads on the SAME host, each behind its own player token.
 *
 * This is the measurement debt (a) was missing. Conflict-based DNR suppression must behave so:
 *   - 'same' token (the common case: one site, one session token shared by every asset): NOT
 *     suppress -> both downloads finish. An existence-only check would wrongly 403 the second.
 *   - 'different' token: the first (already-running) job keeps its token and finishes; the second
 *     is suppressed and FAILS LOUDLY (its segments 403) instead of silently receiving the wrong
 *     token and shipping a mislabeled file.
 *
 * Mechanism: each player tab fetches only its slot's media playlist carrying its token, so the
 * extension captures the real header per URL. We start download A and wait for its start ack (its
 * DNR rule is now live), then start B so B's applySpoof observes A's rule and makes the decision.
 */
async function runDualHostToken(mode) {
  const srv = await startFixtureServer({ dualToken: mode });
  try {
    return await withBrowser(async ({ page }) => {
      // Bước 1: hai tab player, mỗi tab fetch manifest của slot mình KÈM token của slot đó.
      const tabA = await page.context().newPage();
      await tabA.goto(srv.dualPlayerAUrl);
      const tabB = await page.context().newPage();
      await tabB.goto(srv.dualPlayerBUrl);
      const okA = await tabA.evaluate(() => window.__played);
      const okB = await tabB.evaluate(() => window.__played);
      if (!okA || !okB) {
        return {
          ok: false,
          detail: `harness hỏng: player không fetch được manifest (a=${okA}, b=${okB})`,
        };
      }

      // Bước 2: chờ extension ghi bản chụp header (kèm token) cho CẢ HAI media URL + học tabId.
      const found = await page.evaluate(
        async ([urlA, urlB]) => {
          const findFor = (all, url) => {
            for (const [k, v] of Object.entries(all)) {
              if (!k.startsWith('media:')) continue;
              const hit = (v?.items ?? []).find((m) => m.url === url);
              if (hit?.sentHeaders?.['x-playback-session-id']) {
                return { headers: hit.sentHeaders, tabId: Number(k.slice(6)) };
              }
            }
            return null;
          };
          for (let i = 0; i < 40; i++) {
            const all = await chrome.storage.session.get(null);
            const a = findFor(all, urlA);
            const b = findFor(all, urlB);
            if (a && b) return { a, b };
            await new Promise((r) => setTimeout(r, 250));
          }
          return null;
        },
        [srv.dualMediaAUrl, srv.dualMediaBUrl],
      );
      if (!found) {
        return {
          ok: false,
          detail: 'KHÔNG bắt được header token của cả hai player',
        };
      }

      // Bước 3: tải A trước, chờ start ack (rule DNR của A đã sống), RỒI tải B để applySpoof của B
      // quan sát được rule của A và ra quyết định suppress.
      const startDl = (mediaUrl, tabId) =>
        page.evaluate(
          ([m, t]) =>
            chrome.runtime.sendMessage({
              kind: 'hls/download',
              variantUrl: m,
              mediaUrl: m,
              tabId: t,
            }),
          [mediaUrl, tabId],
        );
      const startA = await startDl(srv.dualMediaAUrl, found.a.tabId);
      if (!startA?.ok) {
        return { ok: false, detail: `job A bị từ chối: ${JSON.stringify(startA)}` };
      }
      const startB = await startDl(srv.dualMediaBUrl, found.b.tabId);
      if (!startB?.ok) {
        return { ok: false, detail: `job B bị từ chối: ${JSON.stringify(startB)}` };
      }

      const jobA = await waitJob(page, startA.jobId, JOB_TIMEOUT_MS);
      const jobB = await waitJob(page, startB.jobId, JOB_TIMEOUT_MS);
      if (!jobA || !jobB) {
        return {
          ok: false,
          detail: `job TREO (a=${jobA?.phase}, b=${jobB?.phase})`,
        };
      }

      // Bằng chứng từ server: slot nào được phục vụ 200, slot nào bị 403.
      const seg = (slot, status) =>
        srv.requests.filter(
          (r) => r.url.startsWith(`/hls-dual/${slot}/seg`) && r.status === status,
        ).length;

      if (mode === 'same') {
        // Cả hai PHẢI 'done'; bộ suppress theo-tồn-tại sẽ 403 B ở đây.
        if (jobA.phase !== 'done' || jobB.phase !== 'done') {
          return {
            ok: false,
            detail:
              `same-token: cả hai phải 'done' nhưng a=${jobA.phase}/${jobA.error ?? ''} ` +
              `b=${jobB.phase}/${jobB.error ?? ''} (seg200 a=${seg('a', 200)} b=${seg('b', 200)}, seg403 b=${seg('b', 403)})`,
          };
        }
        return {
          ok: true,
          detail: `same-token: cả hai tải xong (seg200 a=${seg('a', 200)}, b=${seg('b', 200)})`,
        };
      }

      // mode === 'different': job đầu giữ token & xong; job sau thất bại RÕ.
      if (jobA.phase !== 'done') {
        return {
          ok: false,
          detail:
            `different-token: job ĐẦU (A) phải giữ token và 'done' nhưng a=${jobA.phase}/${jobA.error ?? ''} ` +
            `— token bị job sau giật (seg403 a=${seg('a', 403)})`,
        };
      }
      if (jobB.phase === 'done') {
        return {
          ok: false,
          detail: `different-token: job SAU (B) phải THẤT BẠI RÕ, không được lặng lẽ 'done' (seg200 b=${seg('b', 200)})`,
        };
      }
      if (seg('b', 200) > 0) {
        return {
          ok: false,
          detail: `different-token: B KHÔNG được nhận segment 200 nào (đã nhận ${seg('b', 200)} — nội dung sai lọt xuống)`,
        };
      }
      return {
        ok: true,
        detail: `different-token: A giữ token & 'done' (seg200 a=${seg('a', 200)}), B thất bại rõ (${jobB.phase}, seg403 b=${seg('b', 403)})`,
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

/**
 * W4.3 — tên file phải theo TÊN VIDEO của trang, không phải theo path URL.
 *
 * Ghim ba thứ mà unit test KHÔNG với tới, vì chúng nằm ở phần đấu dây trong background:
 *  1. background thật sự CÓ gọi resolveTitle (thay vì `media?.title` cũ, gần như luôn trống);
 *  2. `frameIds: [0]` — trang có iframe player mang tiêu đề sai, đọc nhầm khung là lộ ngay;
 *  3. tiêu đề unicode đi trọn đường tới tên file mà không bị cắt/hỏng.
 */
async function runTitleFromPage({ page: pagePath, want, template, spaNavigate }) {
  const srv = await startFixtureServer({ gate: 'none' });
  try {
    return await withBrowser(async ({ page }) => {
      const pageUrl =
        pagePath === 'og'
          ? srv.ogPageUrl
          : pagePath === 'twitter'
            ? srv.twitterPageUrl
            : srv.docPageUrl;
      // Ghim đường đấu dây của cài đặt: mẫu chỉ có tác dụng nếu CẢ HAI chỗ gọi
      // buildDownloadFilename cùng đọc getFilenameTemplate. Quên một chỗ là cài đặt câm.
      if (template) {
        await page.evaluate(
          (tpl) => chrome.storage.local.set({ 'settings:filenameTemplate': tpl }),
          template,
        );
      }
      // Tab THẬT: resolveTitle đọc DOM qua scripting.executeScript nên tabId phải là tab thật.
      const tabId = await page.evaluate(async (url) => {
        const t = await chrome.tabs.create({ url, active: false });
        return t.id;
      }, pageUrl);
      if (typeof tabId !== 'number') {
        return { ok: false, detail: 'không mở được tab fixture' };
      }
      // Chờ trang dựng xong DOM — đọc tiêu đề trước khi parse xong là đọc hụt.
      for (let i = 0; i < 40; i++) {
        const ready = await page.evaluate(async (id) => {
          const [r] = await chrome.scripting.executeScript({
            target: { tabId: id, frameIds: [0] },
            func: () => document.readyState,
          });
          return r?.result;
        }, tabId);
        if (ready === 'complete') break;
        await new Promise((r) => setTimeout(r, 250));
      }

      // Chờ extension PHÁT HIỆN master qua webRequest -> sinh MediaItem thật, có đóng dấu
      // detectPageUrl. Không có bước này thì `media` là undefined và cổng chống đặt nhầm tên
      // không hề được kiểm — đúng lỗ hổng review đối kháng chỉ ra.
      let stamped;
      for (let i = 0; i < 40; i++) {
        stamped = await page.evaluate(
          async ([id, url]) => {
            const all = await chrome.storage.session.get(`media:${id}`);
            const it = (all[`media:${id}`]?.items ?? []).find((m) => m.url === url);
            return it ? { detectPageUrl: it.detectPageUrl } : null;
          },
          [tabId, srv.masterUrl],
        );
        if (stamped) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!stamped) {
        return { ok: false, detail: 'extension KHÔNG phát hiện được master trên tab fixture' };
      }
      if (!stamped.detectPageUrl) {
        return {
          ok: false,
          detail: 'media KHÔNG được đóng dấu trang lúc phát hiện (detectPageUrl trống)',
        };
      }

      // Ca SPA: đổi route KHÔNG tải lại trang. Dòng media cũ nay thuộc trang cũ -> cổng phải ĐÓNG
      // và tên file lùi về tên từ URL, TUYỆT ĐỐI không được mượn tiêu đề trang mới.
      if (spaNavigate) {
        await page.evaluate(async (id) => {
          await chrome.scripting.executeScript({
            target: { tabId: id, frameIds: [0] },
            func: () => history.pushState({}, '', '/og.html?v=2'),
          });
        }, tabId);
        for (let i = 0; i < 40; i++) {
          const nav = await page.evaluate(async (id) => {
            const all = await chrome.storage.session.get(`media:${id}`);
            return all[`media:${id}`]?.navUrl;
          }, tabId);
          if (nav && nav.includes('v=2')) break;
          await new Promise((r) => setTimeout(r, 250));
        }
      }

      const start = await page.evaluate(
        ([variantUrl, mediaUrl, id]) =>
          chrome.runtime.sendMessage({
            kind: 'hls/download',
            variantUrl,
            mediaUrl,
            tabId: id,
          }),
        [srv.mediaUrl, srv.masterUrl, tabId],
      );
      if (!start?.ok) {
        return {
          ok: false,
          detail: `hls/download bị từ chối: ${JSON.stringify(start)}`,
        };
      }
      const job = await waitJob(page, start.jobId, JOB_TIMEOUT_MS);
      if (!job) return { ok: false, detail: 'job TREO' };
      const wantName = `${DOWNLOAD_FOLDER}/${want}.mp4`;
      if (job.filename !== wantName) {
        return {
          ok: false,
          detail: `tên file sai: "${job.filename}", mong đợi "${wantName}"`,
        };
      }
      return { ok: true, detail: `tên file đúng: "${job.filename}"` };
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
    id: 'real-header-replay',
    title:
      'Server đòi token riêng của player -> extension phải BẮT & PHÁT LẠI header thật (bịa là trượt)',
    expect: 'pass',
    pins: '§2.11/W2.1 (ta bịa Referer/Origin, chưa từng quan sát một request header nào)',
    run: () => runRealHeaderReplay(),
  },
  {
    id: 'dual-host-same-token',
    title:
      'Hai tải cùng host, CÙNG token phiên -> KHÔNG suppress oan, cả hai tải xong',
    // 🔴 Ca phổ biến nhất và là ca mà bộ suppress theo-tồn-tại làm hỏng: một site một token, mọi
    // asset dùng chung. Suppress theo tồn tại sẽ hạ token job sau -> segment 403. Conflict-based
    // phải cho cả hai qua.
    expect: 'pass',
    pins: 'W2.1 nợ (a) — same-token bị suppress oan (bug của existence-check)',
    run: () => runDualHostToken('same'),
  },
  {
    id: 'dual-host-different-token',
    title:
      'Hai tải cùng host, token KHÁC nhau -> job đầu giữ token & xong, job sau thất bại RÕ (không nội dung sai)',
    // Job đầu (đang chạy) phải giữ nguyên token của nó; job sau bị hạ cấp và 403 LỘ RÕ thay vì âm
    // thầm nhận token sai rồi giao file nhầm. Đây là ranh giới an toàn của nợ (a).
    expect: 'pass',
    pins: 'W2.1 nợ (a) — job sau giật token job đầu (bug khi KHÔNG suppress)',
    run: () => runDualHostToken('different'),
  },
  {
    id: 'title-og',
    title:
      'Trang có og:title -> tên file theo TÊN VIDEO (og thắng <title> bẩn; unicode giữ nguyên)',
    expect: 'pass',
    pins: 'W4.3 (media phát hiện qua mạng không mang title -> đa số file ra master/media.mp4)',
    run: () => runTitleFromPage({ page: 'og', want: 'Tên Video Thật' }),
  },
  {
    id: 'title-doc',
    title:
      'Trang chỉ có <title> bẩn -> phải cắt bộ đếm "(3)" và đuôi tên site, ra đúng tên video',
    expect: 'pass',
    pins: 'W4.3 (chuỗi làm sạch tiêu đề phải chạy trong đường đấu dây thật, không chỉ trong vitest)',
    run: () => runTitleFromPage({ page: 'doc', want: 'Tên Video Thật' }),
  },
  {
    id: 'title-template',
    title:
      'Mẫu tên do user đặt ({site}_{title}) phải tới được tên file thật, không chỉ nằm trong storage',
    expect: 'pass',
    pins: 'W4.3 (cài đặt mẫu tên chỉ có unit test; đường từ storage tới tên file chưa ai canh)',
    run: () =>
      runTitleFromPage({
        page: 'og',
        want: '127.0.0.1_Tên Video Thật',
        template: '{site}_{title}',
      }),
  },
  {
    id: 'title-twitter',
    title:
      'Trang CHỈ có twitter:title (og vắng) -> tên file theo twitter (nhánh đọc twitter chưa từng chạy e2e)',
    // 🔴 W4.3 nợ — og:title LUÔN thắng nên câu `read('meta[name="twitter:title"]')` trong
    // scripting.executeScript chưa bao giờ chạy trong máy đo. Trang này là chỗ duy nhất ép nó chạy;
    // <title> bẩn để chứng minh twitter thắng doc chứ không phải doc lọt.
    expect: 'pass',
    pins: 'W4.3 (nhánh đọc twitter:title từ DOM chưa có máy nào chạm)',
    run: () => runTitleFromPage({ page: 'twitter', want: 'Tên Video Thật' }),
  },
  {
    id: 'title-spa-stale',
    title:
      'Chuyển video kiểu SPA rồi tải dòng CŨ -> phải lùi về tên từ URL, KHÔNG mượn tên trang mới',
    expect: 'pass',
    pins: 'W4.3 (cổng chống đặt nhầm tên: thà thiếu tên còn hơn SAI tên)',
    run: () =>
      runTitleFromPage({ page: 'og', want: 'media', spaNavigate: true }),
  },
  // --- §7 — playlist DRM phải bị TỪ CHỐI (ba hệ phổ biến nhất từng đi lọt, đã đo) ---
  {
    id: 'drm-fairplay-refused',
    title:
      'Playlist FairPlay (KEYFORMAT com.apple.streamingkeydelivery) -> TỪ CHỐI, 0 segment bị tải',
    expect: 'pass',
    run: () => runDrmPlaylistRefused({ system: 'fairplay', wantName: 'FairPlay' }),
  },
  {
    id: 'drm-playready-refused',
    title: 'Playlist PlayReady -> TỪ CHỐI, 0 segment bị tải',
    expect: 'pass',
    run: () => runDrmPlaylistRefused({ system: 'playready', wantName: 'PlayReady' }),
  },
  {
    id: 'drm-widevine-refused',
    title: 'Playlist Widevine (KEYFORMAT urn:uuid) -> TỪ CHỐI, 0 segment bị tải',
    expect: 'pass',
    run: () => runDrmPlaylistRefused({ system: 'widevine', wantName: 'Widevine' }),
  },

  // --- W3.1 — HLS mã hoá AES-128 (nhánh giải mã chưa từng được máy đo chạm tới) ---
  {
    id: 'aes128-download',
    title:
      'HLS mã hoá AES-128, IV dẫn từ media sequence (MEDIA-SEQUENCE=7) -> file ra đủ 100 khung',
    expect: 'pass',
    run: () => runAesDownload({ variant: 'seq' }),
  },
  {
    id: 'aes128-explicit-iv',
    title: 'HLS mã hoá AES-128 với IV khai TƯỜNG MINH trong #EXT-X-KEY -> đủ 100 khung',
    expect: 'pass',
    run: () => runAesDownload({ variant: 'iv' }),
  },
  {
    id: 'aes128-key-rotation',
    title:
      'HLS mã hoá AES-128 XOAY KHOÁ giữa playlist (đổi ở segment 5) -> đủ 100 khung, 2 khoá',
    expect: 'pass',
    // >= 2 lượt fetch khoá: cache theo URI phải lấy CẢ HAI khoá. Bản nào cache "một khoá cho cả
    // stream" sẽ chỉ fetch 1 lần và nửa sau ra rác -> đỏ ở đây chứ không trôi im lặng.
    run: () => runAesDownload({ variant: 'rot', wantKeyFetches: 2 }),
  },
  {
    id: 'aes128-bad-key',
    title:
      'Khoá AES SAI GIÁ TRỊ -> job phải lỗi kèm thông báo NÓI RÕ là chuyện khoá/giải mã',
    expect: 'pass',
    run: () => runAesBadKey({ variant: 'bad', wantMessage: /không khớp/ }),
  },
  {
    id: 'aes128-key-not-key',
    title:
      'Server trả TRANG HTML thay cho khoá AES (redirect đăng nhập) -> lỗi phải nói được thành lời',
    expect: 'pass',
    run: () =>
      runAesBadKey({ variant: 'badlen', wantMessage: /16 byte|thay vì 16|đăng nhập/ }),
  },
  {
    id: 'aes128-key-403',
    title:
      'Khoá AES ở HOST KHÁC + cổng 403 riêng đường khoá -> spoof phải phủ CẢ host khoá',
    // 🔴 keyHost là thứ làm ca này có răng. ĐÃ ĐO: để khoá cùng host với segment thì rule DNR sinh
    // từ URL segment đã phủ luôn khoá -> xoá `add(s.keyUri)` khỏi spoofTargetsFromSegments mà ca
    // vẫn XANH, tức nó chẳng ghim gì. Ngoài đời khoá gần như LUÔN ở host khác.
    expect: 'pass',
    run: () =>
      runAesDownload({ variant: 'seq', gate: 'key', keyHost: 'localhost' }),
  },

  // --- GÓI A — HLS fMP4/CMAF: nhánh #EXT-X-MAP + giải mã init (chưa máy nào chạy) ---
  {
    id: 'fmp4-plain',
    title:
      'fMP4/CMAF KHÔNG mã hoá (#EXT-X-MAP) -> tải bình thường, KHÔNG đi xin khoá (chống chặn oan)',
    // Ca CHIỀU NGƯỢC LẠI của gói A. Bản vá nào "cứ thấy #EXT-X-MAP là giải mã" sẽ đỏ ở đây.
    expect: 'pass',
    pins: 'GÓI A (fMP4 sạch phải đi lọt: chặn/giải mã oan tệ hơn bỏ sót)',
    run: () => runFmp4Download({ variant: 'plain', wantKeyHits: 0 }),
  },
  {
    id: 'fmp4-aes-init',
    title:
      'fMP4/CMAF MÃ HOÁ AES-128 phủ CẢ init (#EXT-X-MAP) + IV tường minh -> đủ 100 khung',
    // 🔴 Ca CHÍNH của gói A. Trước bản vá RFC 8216 §4.3.2.5, init được ghi thẳng KHÔNG giải mã ->
    // ciphertext nằm đúng chỗ ftyp/moov -> libav chết với lỗi đổ tội khâu GHÉP. Đây là ca đầu tiên
    // trong dự án chạm được nhánh đó.
    expect: 'pass',
    pins: 'GÓI A (bản vá giải mã init chưa có máy đo nào chạy)',
    run: () => runFmp4Download({ variant: 'enc', wantKeyHits: 1 }),
  },
  {
    id: 'fmp4-clear-init',
    title:
      '#EXT-X-MAP TRƯỚC #EXT-X-KEY (init TRONG SÁNG, segment mã hoá) -> phải tải được, KHÔNG giải mã oan init',
    // 🔴 LỖI THẬT DO REVIEW ĐỐI KHÁNG BẮT ĐƯỢC, và là HỒI QUY do chính bản vá giải mã init gây ra.
    // RFC 8216 §4.3.2.5 phân phạm vi khoá theo VỊ TRÍ TAG; MAP đứng trước KEY = init để trần —
    // hình dạng hợp lệ và phổ biến (init trong sáng cho player đọc codec trước khi xin khoá).
    // Bản cũ suy khoá init từ `segment.key` nên đem giải mã một init vốn đã trong sáng -> WebCrypto
    // ném lỗi padding -> job chết kèm câu ĐỔ TỘI MÁY CHỦ. Giết oan một lượt tải khoẻ là hạng lỗi
    // dự án xếp nặng hơn treo. ĐÃ ĐO: m3u8-parser mô hình đúng phạm vi qua `segment.map.key`.
    expect: 'pass',
    pins: 'GÓI A (phạm vi khoá của #EXT-X-MAP — bản vá init từng giết oan hình dạng này)',
    run: () => runFmp4Download({ variant: 'clear-init', wantKeyHits: 1 }),
  },
  {
    id: 'fmp4-aes-demuxed',
    title:
      'fMP4 tách tiếng, mỗi track có #EXT-X-KEY + #EXT-X-MAP RIÊNG -> file ra đủ hình + tiếng',
    // ĐO ĐƯỢC nó ghim gì (đừng ghi quá lời — phản biện đã bác bản mô tả đầu):
    //   CÓ ghim: init THỨ HAI (của track tiếng) được fetch VÀ giải mã bằng khoá RIÊNG của nó;
    //            track tiếng thật sự có mặt trong file ra.
    //   KHÔNG ghim: phạm vi per-track của `keyCache`. Hai track dùng hai keyUri KHÁC NHAU, mà cache
    //            đánh chỉ mục theo URI, nên cache dùng chung (vẫn theo URI) vẫn cho kết quả ĐÚNG.
    //            Đột biến M-A3 làm ca này đỏ là nhờ nửa "đánh chỉ mục bằng hằng số", và nửa đó thì
    //            `aes128-key-rotation` đã ghim sẵn từ trước.
    expect: 'pass',
    pins: 'GÓI A (init thứ hai + khoá riêng của track tiếng — chưa từng được đo)',
    run: () =>
      runFmp4Download({
        variant: 'aud',
        demuxed: true,
        wantKeyHits: 2,
        wantAudio: true,
      }),
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
