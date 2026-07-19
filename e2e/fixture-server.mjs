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

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/hls',
);
const FIXTURES_DEMUXED = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/hls-demuxed',
);
const FIXTURES_PROGRESSIVE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/progressive',
);

/**
 * W2.1 — token phiên do "player" của trang sinh ra. KHÔNG suy được từ URL/pageUrl/host, nên
 * extension chỉ có thể có nó bằng cách QUAN SÁT request thật của player (`onSendHeaders`).
 */
export const PLAYER_TOKEN = 'e2e-player-session-4f2a91';

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
 * @param {boolean} [opts.stallSegments] W2.6 — segment KHÔNG BAO GIỜ trả lời (giữ socket mở, câm
 *   tuyệt đối). Mô phỏng "mất mạng giữa chừng"/server treo: đây là ca mà trước W2.6 làm job kẹt
 *   'fetching' VĨNH VIỄN, không lỗi, không huỷ nổi, và jobChain tắc kéo mọi job sau chết theo.
 */
export async function startFixtureServer({
  gate = 'none',
  segmentHost = null,
  stallSegments = false,
  tokenGate = false,
} = {}) {
  /** @type {{url:string, referer:string|undefined, token:string|undefined, status:number}[]} */
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
    const token = req.headers['x-playback-session-id'];

    const send = (status, body, type) => {
      requests.push({ url: path, referer, token, status });
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
      });
      res.end(body);
    };

    // Cổng hotlink: KHÔNG có Referer -> 403, y như CDN chống hotlink thật.
    if (needsReferer(path) && !referer) {
      send(403, 'Forbidden: thiếu Referer', 'text/plain');
      return;
    }

    // W2.1 — CỔNG TOKEN: đòi một header mà extension KHÔNG THỂ BỊA RA.
    //
    // Vì sao cổng này chứng minh được điều Referer không chứng minh nổi: Referer suy được từ
    // pageUrl (bản BỊA cũ làm đúng thế và vẫn qua cổng). `X-Playback-Session-Id: <giá trị ngẫu
    // nhiên do trang sinh>` thì KHÔNG suy ra được từ bất cứ đâu — chỉ có thể QUAN SÁT ĐƯỢC từ
    // request thật của player. Qua cổng này = đã bắt & phát lại header thật. Không qua = chưa.
    if (tokenGate && (isManifest(path) || isSegment(path))) {
      if (token !== PLAYER_TOKEN) {
        send(403, `Forbidden: token sai/thiếu (${token ?? 'NONE'})`, 'text/plain');
        return;
      }
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
    // W1.4 — CÙNG 10 segment như media.m3u8 nhưng chèn tag #EXT-X-DISCONTINUITY (đúng hình dạng
    // stream cắm quảng cáo giữa chừng). Giữ nguyên số segment là CỐ Ý: hai playlist chỉ khác nhau
    // đúng ở chỗ có/không tag, nên chênh lệch quan sát được KHÔNG thể đến từ thứ gì khác.
    //
    // 🔴 Cụm thứ hai cố ý là HAI TAG LIỀN NHAU (splicer phát ra khi pod quảng cáo rỗng — dạng có
    // thật). Nhờ vậy ca e2e ghim được CẢ LUẬT ĐẾM chứ không chỉ đường ống: 3 tag / 2 chỗ nối, nên
    // bản đếm ngây thơ `discontinuityStarts.length` (ĐO THẬT: trả [4,7,7]) ra 3 và bị bắt tại chỗ.
    if (path === '/hls/media-disc.m3u8') {
      send(200, readFixture('media-disc.m3u8'), 'application/vnd.apple.mpegurl');
      return;
    }
    // W2.6 — treo tuyệt đối: nhận request rồi im, không header, không byte, không đóng socket.
    if (stallSegments && isSegment(path)) {
      requests.push({ url: path, referer, status: 0 });
      req.socket.setKeepAlive(true);
      return; // KHÔNG res.end() -> client phải tự có đồng hồ mới thoát được
    }
    if (isSegment(path)) {
      // URL là .ts (đuôi HLS thật) nhưng file trên đĩa là .bin — CỐ Ý, đừng "sửa lại cho khớp":
      // đuôi .ts TRÙNG đuôi TypeScript, để nguyên thì tsc/eslint parse file video như mã nguồn và
      // cổng compile/lint ĐỎ. Tên trên đĩa là chi tiết nội bộ; thứ extension nhìn thấy là URL .ts
      // + Content-Type video/mp2t, nên độ giống thật không mất gì.
      send(
        200,
        readFixture(path.slice('/hls/'.length).replace(/\.ts$/, '.bin')),
        'video/mp2t',
      );
      return;
    }
    // W2.7 — .mp4 CÂM TUYỆT ĐỐI: nhận request rồi im (không header, không byte, không đóng socket).
    // Dùng để giữ lượt tải progressive đứng yên đủ lâu mà giết offscreen giữa chừng.
    if (path === '/prog/stall.mp4') {
      requests.push({ url: path, referer, status: 0 });
      req.socket.setKeepAlive(true);
      return; // KHÔNG res.end()
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
    // W7.1 — trang GIẢ LẬP DRM: xin EME y như Netflix/Disney+ làm. KHÔNG có nội dung bảo vệ thật
    // nào ở đây — chỉ một lời gọi API để chứng minh extension NHẬN RA và TỪ CHỐI.
    if (path === '/drm.html') {
      send(
        200,
        `<!doctype html><title>drm fixture</title><p>drm page<script>
          navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
            initDataTypes: ['cenc'],
            videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }]
          }]).then(() => { window.__drmOk = true; }, () => { window.__drmOk = false; });
        </script>`,
        'text/html',
      );
      return;
    }
    // W2.1 — trang có "player" thật: nó fetch manifest KÈM header token riêng. Extension phải
    // nghe được cú fetch này thì mới có gì để phát lại.
    if (path === '/player.html') {
      send(
        200,
        `<!doctype html><title>player fixture</title><p>player page<script>
          window.__played = fetch('/hls/master.m3u8', {
            headers: { 'X-Playback-Session-Id': '${PLAYER_TOKEN}' },
          }).then((r) => r.text()).then(() => fetch('/hls/media.m3u8', {
            headers: { 'X-Playback-Session-Id': '${PLAYER_TOKEN}' },
          })).then((r) => r.ok);
        </script>`,
        'text/html',
      );
      return;
    }
    if (path === '/page.html') {
      send(
        200,
        '<!doctype html><title>fixture</title><p>fixture page',
        'text/html',
      );
      return;
    }
    // W4.3 — khung con của /og.html. Tiêu đề và og:title ở đây đều SAI CỐ Ý: nếu extension đọc
    // tiêu đề mà không ghim `frameIds: [0]` thì nó sẽ vớ phải mấy chuỗi này.
    if (path === '/og-frame.html') {
      send(
        200,
        '<!doctype html><title>JW Player</title>' +
          '<meta property="og:title" content="TIÊU ĐỀ IFRAME SAI">',
        'text/html; charset=utf-8',
      );
      return;
    }
    // W4.3 — trang có og:title ĐÚNG trong khi <title> thì BẨN (bộ đếm + tên site).
    if (path === '/og.html') {
      send(
        200,
        '<!doctype html><title>(3) Tên Video Thật - Fixture Site</title>' +
          '<meta property="og:title" content="Tên Video Thật">' +
          '<meta name="twitter:title" content="TWITTER KHONG DUOC THANG OG">' +
          '<iframe src="/og-frame.html"></iframe>' +
          '<script>window.__m = fetch("/hls/master.m3u8").then(r => r.ok);</script>',
        'text/html; charset=utf-8',
      );
      return;
    }
    // W4.3 — KHÔNG có thẻ meta nào: buộc phải làm sạch <title> mới ra đúng tên.
    if (path === '/doc.html') {
      send(
        200,
        '<!doctype html><title>(3) Tên Video Thật - 127.0.0.1</title>' +
          '<script>window.__m = fetch("/hls/master.m3u8").then(r => r.ok);</script>',
        'text/html; charset=utf-8',
      );
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
    /** W2.1 — trang có player gửi header token riêng. */
    playerPageUrl: `http://127.0.0.1:${port}/player.html`,
    /** W7.1 — trang gọi requestMediaKeySystemAccess (giả lập site DRM). */
    drmPageUrl: `http://127.0.0.1:${port}/drm.html`,
    /** W4.3 — og:title đúng + <title> bẩn + iframe có tiêu đề sai. */
    ogPageUrl: `http://127.0.0.1:${port}/og.html`,
    /** W4.3 — chỉ có <title> bẩn, không thẻ meta. */
    docPageUrl: `http://127.0.0.1:${port}/doc.html`,
    masterUrl: `http://127.0.0.1:${port}/hls/master.m3u8`,
    mediaUrl: `http://127.0.0.1:${port}/hls/media.m3u8`,
    /** W1.4 — playlist y hệt mediaUrl nhưng có 2 chỗ nối (stream chèn quảng cáo). */
    discontinuityUrl: `http://127.0.0.1:${port}/hls/media-disc.m3u8`,
    /** W2.5 — URL mp4 progressive (host 127.0.0.1). */
    progressiveUrl: `http://127.0.0.1:${port}/prog/sample.mp4`,
    /** W2.7 — URL mp4 CÂM (server nhận rồi im) để giữ lượt tải đứng yên mà giết offscreen. */
    stallProgressiveUrl: `http://127.0.0.1:${port}/prog/stall.mp4`,
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
  const FIXTURES_DASH = join(FIXTURES_DEMUXED, '..', 'dash');
  /** @type {{url:string, status:number}[]} */
  const requests = [];

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const send = (status, body, type) => {
      requests.push({ url: path, status });
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
      });
      res.end(body);
    };

    // Đuôi .ts trên URL (đuôi HLS thật) nhưng file trên đĩa là .bin — cùng lý do như fixture muxed:
    // .ts trùng đuôi TypeScript nên tsc/eslint sẽ parse file video như mã nguồn (đã trả giá ở W0.3).
    const m = /^\/hls\/((?:v|a)\d+)\.ts$/.exec(path);
    if (m) {
      send(
        200,
        readFileSync(join(FIXTURES_DEMUXED, `${m[1]}.bin`)),
        'video/mp2t',
      );
      return;
    }
    // W1.5 — fixture DASH THẬT (ffmpeg -f dash): tách tiếng, fMP4, SegmentTemplate — đúng dạng
    // phổ biến nhất ngoài đời. Representation hình id="0", tiếng id="1".
    const d = /^\/dash\/([\w.-]+\.(?:mpd|m4s|mp4))$/.exec(path);
    if (d) {
      const type = d[1].endsWith('.mpd')
        ? 'application/dash+xml'
        : d[1].endsWith('.m4s')
          ? 'video/iso.segment'
          : 'video/mp4';
      send(200, readFileSync(join(FIXTURES_DASH, d[1])), type);
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
    // W7.1 — trang GIẢ LẬP DRM: xin EME y như Netflix/Disney+ làm. KHÔNG có nội dung bảo vệ thật
    // nào ở đây — chỉ một lời gọi API để chứng minh extension NHẬN RA và TỪ CHỐI.
    if (path === '/drm.html') {
      send(
        200,
        `<!doctype html><title>drm fixture</title><p>drm page<script>
          navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
            initDataTypes: ['cenc'],
            videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }]
          }]).then(() => { window.__drmOk = true; }, () => { window.__drmOk = false; });
        </script>`,
        'text/html',
      );
      return;
    }
    if (path === '/page.html') {
      send(
        200,
        '<!doctype html><title>fixture tách tiếng</title><p>fixture',
        'text/html',
      );
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
    /** W7.1 — trang gọi requestMediaKeySystemAccess (giả lập site DRM). */
    drmPageUrl: `http://127.0.0.1:${port}/drm.html`,
    /** W1.5 — manifest DASH (hình + tiếng nằm CHUNG file này, phân biệt bằng Representation@id). */
    mpdUrl: `http://127.0.0.1:${port}/dash/stream.mpd`,
    /** Đã fetch segment DASH lần nào chưa -> bằng chứng đường DASH có thật sự chạy. */
    dashSegmentHits: () =>
      requests.filter((r) => /\/chunk-\d+-\d+\.m4s$/.test(r.url)).length,
    dashAudioHits: () =>
      requests.filter((r) => /\/chunk-1-\d+\.m4s$/.test(r.url)).length,
    masterUrl: `http://127.0.0.1:${port}/hls/master.m3u8`,
    /** Playlist HÌNH — đây là thứ user chọn khi bấm 720p (nó KHÔNG chứa tiếng). */
    videoUrl: `http://127.0.0.1:${port}/hls/video.m3u8`,
    audioUrl: `http://127.0.0.1:${port}/hls/audio.m3u8`,
    /** Đã fetch segment tiếng lần nào chưa -> bằng chứng đường tiếng có thật sự chạy. */
    audioSegmentHits: () =>
      requests.filter((r) => /\/a\d+\.ts$/.test(r.url)).length,
    close: () => new Promise((r) => server.close(r)),
  };
}
