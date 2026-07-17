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
  const needsReferer = (p) =>
    gate === 'all' ||
    (gate === 'manifest' && isManifest(p)) ||
    (gate === 'segments' && isSegment(p));

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
    /** Số request bị chặn 403 -> bằng chứng cổng có bắn. */
    blocked: () => requests.filter((r) => r.status === 403),
    close: () => new Promise((r) => server.close(r)),
  };
}
