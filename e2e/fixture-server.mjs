// Server fixture HLS cục bộ cho harness W0.3.
//
// VÌ SAO CÓ FILE NÀY: e2e/smoke.mjs tải từ một site công khai -> phụ thuộc mạng, và **không có
// cổng 403**, nên nó không bao giờ đo được tính năng vượt hotlink có thật sự áp hay không.
// Server này phục vụ đúng stream HLS 10 segment tí hon trong e2e/fixtures/hls/ và **403 khi
// thiếu Referer** -> biến "spoof có áp không" thành thứ QUAN SÁT ĐƯỢC.
//
// ĐÃ ĐO TRÊN EDGE THẬT (probe 2026-07-17), đừng nghiên cứu lại:
// - Extension fetch http://127.0.0.1:PORT được, KHÔNG cần CORS header (host_permissions phủ),
//   và không bị chặn mixed-content (127.0.0.1/localhost là origin "potentially trustworthy").
// - fetch trần từ extension KHÔNG gửi Referer lẫn Origin -> cổng "403 nếu thiếu Referer" phân
//   biệt sạch giữa "có spoof" và "không spoof".
// - DNR requestDomains KHỚP host dạng IP ('127.0.0.1'), và '127.0.0.1' với 'localhost' là HAI
//   host RIÊNG BIỆT -> dùng làm mẹo dựng ca "segment ở CDN khác host với manifest" (§2.4).

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/hls');
const FIXTURES_DEMUXED = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/hls-demuxed',
);
const FIXTURES_PROGRESSIVE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/progressive',
);

/** File mp4 progressive (đọc một lần) — dùng cho ca W2.5. */
const PROGRESSIVE_MP4 = readFileSync(join(FIXTURES_PROGRESSIVE, 'sample.mp4'));

/** Nội dung fixture đọc một lần (nhỏ, 168KB). */
function readFixture(name) {
  return readFileSync(join(FIXTURES, name));
}

/**
 * @param {object} opts
 * @param {'none'|'manifest'|'segments'|'all'} [opts.gate] path nào đòi Referer (thiếu -> 403).
 * @param {string|null} [opts.segmentHost] nếu set, media.m3u8 trả URI segment TUYỆT ĐỐI trỏ host
 *   này (dựng ca segment khác host với manifest). Null -> URI tương đối như manifest thật.
 */
export async function startFixtureServer({
  gate = 'none',
  segmentHost = null,
} = {}) {
  /** @type {{url:string, referer:string|undefined, status:number}[]} */
  const requests = [];

  const isSegment = (p) => /\/seg\d+\.ts$/.test(p);
  const isManifest = (p) => p.endsWith('.m3u8');
  const isProgressive = (p) => p === '/prog/sample.mp4';
  const needsReferer = (p) =>
    gate === 'all' ||
    (gate === 'manifest' && isManifest(p)) ||
    (gate === 'segments' && isSegment(p)) ||
    (gate === 'progressive' && isProgressive(p));

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const referer = req.headers.referer;

    const send = (status, body, type) => {
      requests.push({ url: path, referer, status });
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };

    // Cổng hotlink: KHÔNG có Referer -> 403, y như CDN chống hotlink thật.
    if (needsReferer(path) && !referer) {
      send(403, 'Forbidden: thiếu Referer', 'text/plain');
      return;
    }

    if (path === '/hls/master.m3u8') {
      send(200, readFixture('master.m3u8'), 'application/vnd.apple.mpegurl');
      return;
    }
    if (path === '/hls/media.m3u8') {
      let text = readFixture('media.m3u8').toString('utf8');
      if (segmentHost) {
        // Trỏ segment sang host KHÁC (cùng server, khác tên host) -> ghim §2.4.
        text = text.replace(
          /^(seg\d+\.ts)$/gm,
          (m) => `http://${segmentHost}:${server.address().port}/hls/${m}`,
        );
      }
      send(200, text, 'application/vnd.apple.mpegurl');
      return;
    }
    if (isSegment(path)) {
      // URL là .ts (đuôi HLS thật) nhưng file trên đĩa là .bin — CỐ Ý, đừng "sửa lại cho khớp":
      // đuôi .ts TRÙNG đuôi TypeScript, để nguyên thì tsc/eslint parse file video như mã nguồn và
      // cổng compile/lint ĐỎ. Tên trên đĩa là chi tiết nội bộ; thứ extension nhìn thấy là URL .ts
      // + Content-Type video/mp2t, nên độ giống thật không mất gì.
      send(200, readFixture(path.slice('/hls/'.length).replace(/\.ts$/, '.bin')), 'video/mp2t');
      return;
    }
    // W2.5 — file mp4 progressive. HỖ TRỢ Range (206) để đo đúng đường offscreen chunk theo byte;
    // thiếu Range thì trả 200 nguyên file (đường stream body). Accept-Ranges để client biết được phép.
    if (isProgressive(path)) {
      const total = PROGRESSIVE_MP4.length;
      const range = req.headers.range;
      const m = range && /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        if (start > end || start >= total) {
          requests.push({ url: path, referer, status: 416 });
          res.writeHead(416, { 'content-range': `bytes */${total}` });
          res.end();
          return;
        }
        requests.push({ url: path, referer, status: 206 });
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'content-range': `bytes ${start}-${end}/${total}`,
          'content-length': end - start + 1,
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
        });
        res.end(PROGRESSIVE_MP4.subarray(start, end + 1));
        return;
      }
      requests.push({ url: path, referer, status: 200 });
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': total,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      });
      res.end(PROGRESSIVE_MP4);
      return;
    }
    if (path === '/page.html') {
      send(200, '<!doctype html><title>fixture</title><p>fixture page', 'text/html');
      return;
    }
    send(404, 'not found', 'text/plain');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  return {
    port,
    requests,
    origin: `http://127.0.0.1:${port}`,
    pageUrl: `http://127.0.0.1:${port}/page.html`,
    masterUrl: `http://127.0.0.1:${port}/hls/master.m3u8`,
    mediaUrl: `http://127.0.0.1:${port}/hls/media.m3u8`,
    /** W2.5 — URL mp4 progressive (host 127.0.0.1). */
    progressiveUrl: `http://127.0.0.1:${port}/prog/sample.mp4`,
    /** Số request mp4 progressive server đã PHỤC VỤ (200/206) -> bằng chứng byte có tới. */
    progressiveHits: () =>
      requests.filter((r) => r.url === '/prog/sample.mp4' && r.status < 400)
        .length,
    /** Số request bị chặn 403 -> bằng chứng cổng có bắn. */
    blocked: () => requests.filter((r) => r.status === 403),
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * Server fixture HLS **TÁCH TIẾNG** (master + playlist hình + playlist tiếng RIÊNG).
 *
 * VÌ SAO TÁCH RIÊNG KHỎI startFixtureServer: fixture kia là master **MUXED** (hình+tiếng chung một
 * segment) — đúng "ca dễ" mà §1.1 cảnh báo, và là lý do 193 test xanh trong khi sản phẩm câm.
 * Fixture này có `#EXT-X-MEDIA:TYPE=AUDIO` + variant trỏ `AUDIO="aud-64000"`, tức ĐÚNG hình dạng
 * làm file tải về mất tiếng (§2.1) — dạng mà Twitter/X, Vimeo, Twitch, CMAF đều dùng.
 *
 * Sinh bằng ffmpeg (offline, tất định, KHÔNG dính lỗi #30 của fMP4 vì đây là MPEG-TS):
 *   hình: testsrc 128x96, 10fps, 10s, -an  -> 10 segment = 100 khung
 *   tiếng: sine 440Hz, 10s, aac 64k, -vn   -> 11 segment (segment tiếng LỆCH số lượng với hình —
 *          đúng như thật, và bắt lỗi bản sửa nào ngầm giả định hai bên cùng số segment).
 *
 * Master cố ý KHÔNG khai `DEFAULT` -> mọi rendition `default=false` (bẫy Twitter/X thật, đã đo ở
 * W0.4): bản sửa nào chỉ dựa vào "ưu tiên DEFAULT=YES" sẽ chọn trượt và lộ ra ngay tại đây.
 */
export async function startDemuxedServer() {
  /** @type {{url:string, status:number}[]} */
  const requests = [];

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const send = (status, body, type) => {
      requests.push({ url: path, status });
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };

    // Đuôi .ts trên URL (đuôi HLS thật) nhưng file trên đĩa là .bin — cùng lý do như fixture muxed:
    // .ts trùng đuôi TypeScript nên tsc/eslint sẽ parse file video như mã nguồn (đã trả giá ở W0.3).
    const m = /^\/hls\/((?:v|a)\d+)\.ts$/.exec(path);
    if (m) {
      send(200, readFileSync(join(FIXTURES_DEMUXED, `${m[1]}.bin`)), 'video/mp2t');
      return;
    }
    const pl = /^\/hls\/(master|video|audio)\.m3u8$/.exec(path);
    if (pl) {
      send(
        200,
        readFileSync(join(FIXTURES_DEMUXED, `${pl[1]}.m3u8`)),
        'application/vnd.apple.mpegurl',
      );
      return;
    }
    if (path === '/page.html') {
      send(200, '<!doctype html><title>fixture tách tiếng</title><p>fixture', 'text/html');
      return;
    }
    send(404, 'not found', 'text/plain');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  return {
    port,
    requests,
    origin: `http://127.0.0.1:${port}`,
    pageUrl: `http://127.0.0.1:${port}/page.html`,
    masterUrl: `http://127.0.0.1:${port}/hls/master.m3u8`,
    /** Playlist HÌNH — đây là thứ user chọn khi bấm 720p (nó KHÔNG chứa tiếng). */
    videoUrl: `http://127.0.0.1:${port}/hls/video.m3u8`,
    audioUrl: `http://127.0.0.1:${port}/hls/audio.m3u8`,
    /** Đã fetch segment tiếng lần nào chưa -> bằng chứng đường tiếng có thật sự chạy. */
    audioSegmentHits: () => requests.filter((r) => /\/a\d+\.ts$/.test(r.url)).length,
    close: () => new Promise((r) => server.close(r)),
  };
}
