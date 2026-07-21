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
import { createCipheriv } from 'node:crypto';
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
 * GÓI A — byte fMP4/CMAF mượn từ fixture DASH (đã commit, sinh bằng ffmpeg -f dash).
 * Dùng lại thay vì sinh fixture mới: đây là fMP4 THẬT do ffmpeg đóng gói, và track hình của nó
 * cho đúng 100 khung — trùng khít hằng số FIXTURE_FRAMES mà bộ e2e đã hiệu chuẩn từ trước.
 */
const FIXTURES_DASH_SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/dash',
);

/**
 * W2.1 — token phiên do "player" của trang sinh ra. KHÔNG suy được từ URL/pageUrl/host, nên
 * extension chỉ có thể có nó bằng cách QUAN SÁT request thật của player (`onSendHeaders`).
 */
export const PLAYER_TOKEN = 'e2e-player-session-4f2a91';

/**
 * W2.1 debt (a) — a SECOND, distinct player token. Two HLS assets on the SAME host can each sit
 * behind their own token; this is the value the second asset's gate demands in the different-token
 * scenario. It must never be derivable from the first — the whole point is that mixing the two up
 * (one job clobbering the other's DNR header rule) is observable as a 403, not a silent wrong file.
 */
export const PLAYER_TOKEN_B = 'e2e-player-session-b-8c31d7';

/** File mp4 progressive (đọc một lần) — dùng cho ca W2.5. */
const PROGRESSIVE_MP4 = readFileSync(join(FIXTURES_PROGRESSIVE, 'sample.mp4'));

/** Nội dung fixture đọc một lần (nhỏ, 168KB). */
function readFixture(name) {
  return readFileSync(join(FIXTURES, name));
}

// --- W3.1 — HLS MÃ HOÁ AES-128 -----------------------------------------------------------------
//
// VÌ SAO CÓ: AES-128 là nhánh giải mã DUY NHẤT dự án được phép có (§7 — khoá phát công khai, không
// vượt kiểm soát truy cập nào), nhưng nó CHƯA HỀ được e2e chạm tới qua ba phiên. Đường ống mới
// (libav.js + OPFS) giải mã TRƯỚC khi ghi đĩa, nên nếu nhánh này hỏng thì file ra là rác —
// và rác thì `av_write_trailer` vẫn trả 0, y hệt bài học "moov thiếu mà ffprobe thoát mã 0".
//
// CÁCH CHỨNG MINH: segment ở đây là ĐÚNG 10 segment plaintext của /hls/ đem mã hoá tại chỗ. Nên
// kỳ vọng hoàn toàn trùng ca `happy` đã hiệu chuẩn: **100 khung hình**. Sai KHOÁ thì ra byte ngẫu
// nhiên, MPEG-TS mất đồng bộ, không có đường nào ra đúng 100 khung.
//
// Mã hoá bằng `node:crypto` (OpenSSL) trong khi extension giải bằng WebCrypto -> HAI cài đặt độc
// lập, nên không có kiểu "cùng sai một cách" làm ca này xanh giả.
//
// 🔴 GIỚI HẠN ĐÃ ĐO CỦA CHÍNH BỘ CA NÀY — ĐỌC TRƯỚC KHI TIN NÓ PHỦ NHIỀU HƠN THỰC TẾ:
// Mấy ca tải ở đây ghim được đường LẤY KHOÁ + phép giải CBC, **KHÔNG ghim được phép dẫn IV**.
// Đo bằng đột biến trên build thật (2026-07-19): thay `seg.seq` bằng chỉ số mảng -> ca VẪN XANH;
// bỏ qua `#EXT-X-KEY:IV=` -> ca VẪN XANH. Lý do là tính chất của CBC: IV chỉ chi phối khối 16 byte
// ĐẦU mỗi segment. Đo trên chính fixture này: IV sai làm lệch ĐÚNG 10/143.444 byte, vẫn 100 khung,
// md5 luồng hình GIỐNG HỆT, stderr ffmpeg RỖNG, và file .mp4 ra GIỐNG HỆT TỪNG BYTE (đã `cmp`).
// => KHÔNG assertion nào dựa trên nội dung file bắt được lỗi IV với MPEG-TS. Lưới cho IV nằm ở
// unit test `utils/crypto.test.ts` (mục "vector IV lấy từ chính fixture e2e"), không nằm ở đây. Đừng thêm ca
// e2e mới với hy vọng bắt lỗi IV — đã thử, không được.
//
// 🔴 ĐÃ ĐO (2026-07-19, đừng đo lại) — utils/hls.ts + m3u8-parser@7.2.0:
//   - Không khai IV  -> `iv` VẮNG; IV = `seq` (media sequence TUYỆT ĐỐI) dạng 128-bit big-endian.
//   - `#EXT-X-MEDIA-SEQUENCE:7` -> segment đầu có `seq = 7`, KHÔNG phải 0.
//   - Khai `IV=0x...` -> parser trả Uint32Array, utils đổi ra đúng 16 byte.
//   - Hai `#EXT-X-KEY` -> mỗi segment mang đúng `keyUri` của cụm nó thuộc về.
//   - node aes-128-cbc + PKCS7 <-> `decryptAes128Cbc` khớp TỪNG BYTE (thử cỡ 18612 B, không bội 16).

/** Khoá 16 byte CỐ ĐỊNH (tất định để ca e2e lặp lại được). Hai khoá khác nhau -> ca xoay khoá. */
const AES_KEY_0 = Buffer.from('59564956494d2d6b65792d302d616573', 'hex');
const AES_KEY_1 = Buffer.from('59564956494d2d6b65792d312d616573', 'hex');

/**
 * IV tường minh — CỐ Ý không phải toàn số 0 và không trùng IV nào dẫn được từ `seq`.
 * ⚠️ Giá trị này được UNIT TEST dùng lại làm vector kỳ vọng; e2e KHÔNG phân biệt được IV đúng/sai
 * (xem "GIỚI HẠN ĐÃ ĐO" ở đầu mục). Đổi số ở đây thì phải đổi cả trong `utils/crypto.test.ts`.
 */
const AES_EXPLICIT_IV = Buffer.from('a1b2c3d4e5f60718293a4b5c6d7e8f90', 'hex');

/**
 * MEDIA-SEQUENCE khác 0 để `seq` KHÔNG trùng chỉ số mảng — nhờ vậy unit test phân biệt được bản
 * dùng `seg.seq` với bản dùng nhầm chỉ số vòng lặp.
 * ⚠️ Đừng "dọn về 0 cho gọn", và cũng đừng tin là e2e bắt được chuyện này: ĐO RỒI, e2e KHÔNG bắt
 * (xem "GIỚI HẠN ĐÃ ĐO" ở đầu mục). Thứ bắt được là `utils/crypto.test.ts`.
 */
const AES_MEDIA_SEQUENCE = 7;

/** MEDIA-SEQUENCE của playlist IV-tường-minh: khác 0 để phân biệt được với IV dẫn từ seq. */
const AES_IV_MEDIA_SEQUENCE = 3;

/** Segment nào bắt đầu dùng khoá thứ hai (ca xoay khoá). */
const AES_ROTATE_AT = 5;

/** IV mặc định của HLS: media sequence dạng 128-bit big-endian (12 byte 0 + uint32). */
function seqIv(seq) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(seq >>> 0, 12);
  return iv;
}

/** AES-128-CBC + PKCS7 — đúng chuẩn HLS (RFC 8216 §5.2). */
function aesEncrypt(plain, key, iv) {
  const c = createCipheriv('aes-128-cbc', key, iv);
  c.setAutoPadding(true);
  return Buffer.concat([c.update(plain), c.final()]);
}

/**
 * Ba biến thể playlist mã hoá, mỗi biến thể có KHÔNG GIAN TÊN segment riêng (`seq`/`iv`/`rot`) vì
 * cùng một segment plaintext được mã hoá bằng IV/khoá khác nhau ở mỗi biến thể.
 */
const AES_VARIANTS = {
  // IV mặc định (dẫn từ seq) + MEDIA-SEQUENCE=7 -> ghim luật "IV theo seq tuyệt đối".
  seq: { mediaSequence: AES_MEDIA_SEQUENCE, explicitIv: false, rotate: false },
  // IV tường minh -> ghim rằng `#EXT-X-KEY:IV=` thật sự được dùng.
  iv: { mediaSequence: AES_IV_MEDIA_SEQUENCE, explicitIv: true, rotate: false },
  // Hai khoá trong một playlist -> ghim rằng cache khoá KHÔNG bôi khoá đầu ra cả stream.
  rot: { mediaSequence: 0, explicitIv: false, rotate: true },
  // Segment mã hoá BÌNH THƯỜNG nhưng server phát KHOÁ SAI (16 byte khác) -> giải mã ném lỗi.
  // Có thật ngoài đời: CDN xoay khoá mà quên cập nhật, hoặc URI khoá trỏ nhầm bản cũ.
  bad: { mediaSequence: 0, explicitIv: false, rotate: false, badKey: 'wrong' },
  // Server phát TRANG HTML thay cho khoá (403/redirect về trang đăng nhập — dạng RẤT hay gặp).
  // Đây là ca khoá KHÔNG PHẢI 16 byte -> `importKey` ném, không phải lỗi padding.
  badlen: { mediaSequence: 0, explicitIv: false, rotate: false, badKey: 'html' },
};

/** Khoá SAI 16 byte (ca `bad`) — đúng độ dài nên qua được importKey, chết ở bước bỏ padding. */
const AES_KEY_DECOY = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

// --- W7.1/§7 — PLAYLIST DRM (ranh giới cứng: phải TỪ CHỐI, không được tải) -----------------------
//
// 🔴 LỖ HỔNG THẬT ĐÃ ĐO 2026-07-19: ba hệ DRM phổ biến nhất đi LỌT ranh giới §7. m3u8-parser đẩy
// khoá có KEYFORMAT lạ sang `manifest.contentProtection` và KHÔNG gán `segment.key`, nên
// `parseHlsSegments` thấy playlist DRM là "không mã hoá" -> isProtected=FALSE -> extension tải
// trọn nội dung được bảo vệ. SAMPLE-AES chỉ mã hoá payload NAL nên khung TS còn nguyên và libav
// remux THÀNH CÔNG -> user nhận .mp4 nhiễu KÈM DẤU TÍCH XANH.
//
// Segment ở đây dùng lại đúng segment thường: ca này đo QUYẾT ĐỊNH TỪ CHỐI, không đo giải mã.
// Nếu guard thủng thì job sẽ chạy tới cùng và ra file -> ca ĐỎ. Đó chính là điều cần ghim.
const DRM_VARIANTS = {
  fairplay:
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-id",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"',
  playready:
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,AAAA",KEYFORMAT="com.microsoft.playready"',
  widevine:
    '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"',
};

/** Media playlist khai DRM, trỏ về ĐÚNG 10 segment thường của /hls/. */
function drmPlaylist(system) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:5',
    '#EXT-X-TARGETDURATION:1',
    '#EXT-X-MEDIA-SEQUENCE:0',
    DRM_VARIANTS[system],
  ];
  for (let i = 0; i < 10; i++) {
    lines.push('#EXTINF:1.0,', `http://127.0.0.1:__PORT__/hls/seg${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

/** Khoá + IV của segment thứ `i` trong biến thể `name`. Một nguồn sự thật cho cả playlist lẫn byte. */
function aesParamsFor(name, i) {
  const v = AES_VARIANTS[name];
  const seq = v.mediaSequence + i;
  return {
    key: v.rotate && i >= AES_ROTATE_AT ? AES_KEY_1 : AES_KEY_0,
    iv: v.explicitIv ? AES_EXPLICIT_IV : seqIv(seq),
  };
}

/** Sinh media playlist mã hoá cho biến thể `name` (10 segment, khớp đúng /hls/media.m3u8). */
function aesPlaylist(name, keyHost, port) {
  const v = AES_VARIANTS[name];
  // `keyHost` cho khoá ra host KHÁC manifest/segment. Cần thiết vì rule DNR gom THEO HOST:
  // khoá cùng host với segment thì rule sinh từ URL segment đã phủ luôn khoá, nên ca "cổng 403
  // riêng đường khoá" không phân biệt nổi có/không có `add(s.keyUri)` trong spoofTargets.
  // ĐÃ ĐO: '127.0.0.1' và 'localhost' là HAI host riêng với DNR (xem đầu file).
  const keyBase = keyHost ? `http://${keyHost}:${port}/hls-aes/${name}/` : '';
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:1',
    `#EXT-X-MEDIA-SEQUENCE:${v.mediaSequence}`,
  ];
  for (let i = 0; i < 10; i++) {
    // #EXT-X-KEY phát lại ở đúng chỗ đổi khoá; ngoài ra chỉ khai một lần ở đầu (như CDN thật).
    if (i === 0 || (v.rotate && i === AES_ROTATE_AT)) {
      const keyFile =
        keyBase +
        (v.rotate && i >= AES_ROTATE_AT ? 'key1.bin' : 'key0.bin');
      const ivAttr = v.explicitIv
        ? `,IV=0x${AES_EXPLICIT_IV.toString('hex')}`
        : '';
      lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="${keyFile}"${ivAttr}`);
    }
    lines.push('#EXTINF:1.0,', `seg${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

// --- GÓI A — HLS fMP4/CMAF MÃ HOÁ (#EXT-X-MAP + AES-128 áp CẢ init) ----------------------------
//
// VÌ SAO CÓ: phiên 2026-07-20 vá chỗ "init segment (#EXT-X-MAP) không được giải mã" theo
// RFC 8216 §4.3.2.5 — nhưng bản vá đó CHƯA CÓ MÁY ĐO NÀO CHẠY vì dự án không có fixture fMP4 mã
// hoá. Mọi ca AES-128 đang có đều chạy MPEG-TS, mà TS thì KHÔNG có #EXT-X-MAP nên nhánh giải mã
// init không bao giờ được đụng tới.
//
// 🔴 VÌ SAO FIXTURE NÀY CÓ RĂNG TRONG KHI FIXTURE TS THÌ KHÔNG (khác biệt cốt lõi, đã đo ở mục
// AES-128 phía trên): với MPEG-TS, IV chỉ chi phối 16 byte ĐẦU mỗi segment và 16 byte đó chỉ là
// một gói TS — ffmpeg tự đồng bộ lại, file ra GIỐNG HỆT TỪNG BYTE. Với fMP4 thì 16 byte đầu của
// init là header `ftyp` (kích thước + magic) và ngay sau đó là `moov` chứa toàn bộ mô tả track.
// Hỏng ở đó thì KHÔNG có gì để đồng bộ lại: libav không nhận ra định dạng và job chết hẳn.
// => đây là chỗ DUY NHẤT trong bộ e2e mà lỗi tầng init/IV trở nên QUAN SÁT ĐƯỢC.
//
// Byte mượn từ e2e/fixtures/dash/ (sinh bằng ffmpeg -f dash, đã commit): track 0 là hình h264,
// init-0.mp4 + chunk-0-00001..5.m4s = ĐÚNG 100 khung / 10,0s — trùng khít kỳ vọng của ca `happy`,
// nên dùng lại được hằng số FIXTURE_FRAMES mà không phải hiệu chuẩn lại. Track 1 là tiếng aac.

/** Khoá của luồng HÌNH fMP4. Khác mọi khoá TS ở trên để không có đường lẫn khoá giữa hai bộ ca. */
const FMP4_KEY_V = Buffer.from('59564956494d2d666d7034762d6b6579', 'hex');
/** Khoá RIÊNG của luồng TIẾNG — ghim nhánh "mỗi track một #EXT-X-KEY" chưa chạy lần nào. */
const FMP4_KEY_A = Buffer.from('59564956494d2d666d7034612d6b6579', 'hex');

/**
 * IV TƯỜNG MINH — RFC 8216 §4.3.2.5 BẮT BUỘC khai IV khi khoá áp cho Media Initialization Section,
 * vì init không có số thứ tự nào để dẫn IV ra.
 * ⚠️ CỐ Ý khác mọi IV dẫn được từ `seq` (xem FMP4_MEDIA_SEQUENCE): nhờ vậy đột biến "bỏ qua IV
 * tường minh" làm hỏng ĐÚNG 16 byte đầu init = header `ftyp` -> ca ĐỎ. Trên TS thì đột biến y hệt
 * để ca XANH (đã đo). Đừng đổi giá trị này về 0 hay về thứ trùng seq.
 */
const FMP4_EXPLICIT_IV = Buffer.from('7f3e1c0b9a8d6f4e2c1a0b9d8e7f6a5b', 'hex');

/**
 * MEDIA-SEQUENCE khác 0 để IV-dẫn-từ-seq KHÔNG trùng IV tường minh -> đột biến phân biệt được.
 * (Với TS thì chi tiết này vô nghĩa vì e2e mù với IV; với fMP4 thì nó chính là thứ tạo ra răng.)
 */
const FMP4_MEDIA_SEQUENCE = 11;

/** Số segment .m4s của mỗi track fMP4 (khớp số file chunk-N-* trong e2e/fixtures/dash). */
const FMP4_SEGMENTS = { v: 5, a: 6 };

/**
 * Biến thể fMP4:
 *   `plain` KHÔNG mã hoá  -> ca CHIỀU NGƯỢC LẠI: chống giải mã oan / chặn oan.
 *   `enc`   AES-128 áp CẢ init lẫn .m4s, IV tường minh -> ca chính của gói A.
 *   `aud`   TÁCH TIẾNG, mỗi track một khoá RIÊNG -> nhánh keyCache per-track chưa chạy lần nào.
 */
const FMP4_VARIANTS = {
  plain: { encrypted: false },
  enc: { encrypted: true },
  aud: { encrypted: true, demuxed: true },
  // 🔴 INIT TRONG SÁNG, SEGMENT MÃ HOÁ — `#EXT-X-MAP` đứng TRƯỚC `#EXT-X-KEY`.
  //
  // RFC 8216 §4.3.2.5 phân phạm vi khoá theo VỊ TRÍ TAG: một `#EXT-X-KEY` phủ các Media
  // Initialization Section do `#EXT-X-MAP` khai giữa nó và `#EXT-X-KEY` kế tiếp. Nên MAP đứng
  // TRƯỚC key nghĩa là "init để trần, segment mã hoá" — playlist HỢP LỆ và phổ biến: init trong
  // sáng cho phép player đọc codec/khởi tạo decoder TRƯỚC khi xin khoá.
  //
  // 🔴 ĐÃ ĐO (2026-07-20) — m3u8-parser@7.2.0 mô hình ĐÚNG phạm vi này, code ta mới là bên sai:
  //     key TRƯỚC map -> segment.map.key = {method:'AES-128',...}
  //     map TRƯỚC key -> segment.map = {uri} và KHÔNG có .key
  // Bản trước bản vá suy khoá init từ `segment.key` (khoá của SEGMENT) nên nó giải mã một init
  // vốn đã trong sáng -> WebCrypto ném lỗi padding -> job chết kèm câu đổ tội máy chủ
  // "khoá không khớp / máy chủ phát nhầm khoá". Một stream KHOẺ bị giết oan — đúng hạng lỗi dự án
  // xếp nặng hơn cả treo. Và đó là HỒI QUY: trước bản vá giải mã init, hình dạng này tải được.
  'clear-init': { encrypted: true, keyAfterMap: true },
};

/** Đọc byte fMP4 gốc từ fixture DASH. `track` là 'v' (0) hoặc 'a' (1). */
function readFmp4(track, name) {
  const t = track === 'a' ? 1 : 0;
  const file =
    name === 'init'
      ? `init-${t}.mp4`
      : `chunk-${t}-${String(Number(name) + 1).padStart(5, '0')}.m4s`;
  return readFileSync(join(FIXTURES_DASH_SRC, file));
}

/** Khoá của một track trong biến thể fMP4 (tách tiếng -> hai khoá khác nhau). */
function fmp4Key(variant, track) {
  return FMP4_VARIANTS[variant].demuxed && track === 'a'
    ? FMP4_KEY_A
    : FMP4_KEY_V;
}

/**
 * Media playlist fMP4: `#EXT-X-MAP:URI="init.mp4"` + N segment `.m4s`.
 * Khi mã hoá, `#EXT-X-KEY` đặt TRƯỚC `#EXT-X-MAP` — đúng thứ tự RFC đòi để khoá phủ được init.
 */
function fmp4Playlist(variant, track) {
  const v = FMP4_VARIANTS[variant];
  const n = FMP4_SEGMENTS[track];
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:2',
    `#EXT-X-MEDIA-SEQUENCE:${FMP4_MEDIA_SEQUENCE}`,
  ];
  // THỨ TỰ TAG LÀ NGỮ NGHĨA, KHÔNG PHẢI THẨM MỸ (RFC 8216 §4.3.2.5):
  //   KEY trước MAP -> khoá phủ CẢ init  (biến thể `enc`, `aud`)
  //   MAP trước KEY -> init TRONG SÁNG   (biến thể `clear-init`)
  // Cả hai đều hợp lệ và đều gặp ngoài đời. Đừng "dọn" hai nhánh này về một.
  const keyLine = `#EXT-X-KEY:METHOD=AES-128,URI="key-${track}.bin",IV=0x${FMP4_EXPLICIT_IV.toString('hex')}`;
  if (v.encrypted && !v.keyAfterMap) lines.push(keyLine);
  lines.push(`#EXT-X-MAP:URI="init-${track}.mp4"`);
  if (v.encrypted && v.keyAfterMap) lines.push(keyLine);
  for (let i = 0; i < n; i++) {
    lines.push('#EXTINF:2.0,', `seg-${track}${i}.m4s`);
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

/** Master của biến thể TÁCH TIẾNG: hình một playlist, tiếng một playlist, mỗi bên khoá riêng. */
function fmp4Master() {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="vi",LANGUAGE="vi",URI="media-a.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=128x96,CODECS="avc1.42c00d,mp4a.40.2",AUDIO="aud"',
    'media-v.m3u8',
    '',
  ].join('\n');
}

/**
 * @param {object} opts
 * @param {'none'|'manifest'|'segments'|'all'} [opts.gate] path nào đòi Referer (thiếu -> 403).
 * @param {string|null} [opts.segmentHost] nếu set, media.m3u8 trả URI segment TUYỆT ĐỐI trỏ host
 *   này (dựng ca segment khác host với manifest). Null -> URI tương đối như manifest thật.
 * @param {string|null} [opts.keyHost] W3.1 — nếu set, URI khoá AES là TUYỆT ĐỐI trỏ host này
 *   (dựng ca "khoá nằm ở CDN khác host với segment" — hình dạng gần như luôn đúng ngoài đời).
 * @param {boolean} [opts.stallSegments] W2.6 — segment KHÔNG BAO GIỜ trả lời (giữ socket mở, câm
 *   tuyệt đối). Mô phỏng "mất mạng giữa chừng"/server treo: đây là ca mà trước W2.6 làm job kẹt
 *   'fetching' VĨNH VIỄN, không lỗi, không huỷ nổi, và jobChain tắc kéo mọi job sau chết theo.
 */
export async function startFixtureServer({
  gate = 'none',
  segmentHost = null,
  stallSegments = false,
  tokenGate = false,
  keyHost = null,
  // W2.1 debt (a) — two same-host HLS assets, each behind its own token. false = off; 'same' = both
  // slots demand PLAYER_TOKEN; 'different' = slot a demands PLAYER_TOKEN, slot b demands PLAYER_TOKEN_B.
  dualToken = false,
} = {}) {
  /** @type {{url:string, referer:string|undefined, token:string|undefined, status:number}[]} */
  const requests = [];

  const isSegment = (p) => /\/seg\d+\.ts$/.test(p);
  const isManifest = (p) => p.endsWith('.m3u8');
  const isProgressive = (p) => p === '/prog/sample.mp4';
  /**
   * W3.1 — khoá AES là một đường FETCH RIÊNG (fetchWithRetry với label khác), không đi chung
   * đường segment. Cổng `key` cô lập đúng đường đó: nó chứng minh cú fetch khoá CŨNG được
   * phát lại header, chứ không phải "segment qua được thì khoá đương nhiên qua".
   */
  const isAesKey = (p) => /^\/hls-aes\/\w+\/key\d\.bin$/.test(p);
  const needsReferer = (p) =>
    gate === 'all' ||
    (gate === 'manifest' && isManifest(p)) ||
    (gate === 'segments' && isSegment(p)) ||
    (gate === 'key' && isAesKey(p)) ||
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

    // W2.1 debt (a) — PER-ASSET token gate. /hls-dual/<slot>/ demands the token registered for that
    // slot: slot a always wants PLAYER_TOKEN; slot b wants PLAYER_TOKEN_B only in 'different' mode.
    // A request arriving with the OTHER slot's token (one same-host job's DNR rule clobbered by the
    // other's) is a loud 403 here — never a silently wrong file.
    const dualSlot = /^\/hls-dual\/([ab])\//.exec(path);
    if (dualToken && dualSlot) {
      const want =
        dualSlot[1] === 'b' && dualToken === 'different'
          ? PLAYER_TOKEN_B
          : PLAYER_TOKEN;
      if (token !== want) {
        send(
          403,
          `Forbidden: token sai cho slot ${dualSlot[1]} (${token ?? 'NONE'})`,
          'text/plain',
        );
        return;
      }
    }

    // W3.1 — HLS MÃ HOÁ AES-128. Đặt TRƯỚC nhánh isSegment() chung: `/hls-aes/seq/seg0.ts` cũng
    // khớp regex segment, để rơi xuống dưới là đi đọc nhầm file plaintext trong e2e/fixtures/hls.
    const aesKey = /^\/hls-aes\/(\w+)\/key(\d)\.bin$/.exec(path);
    if (aesKey) {
      if (!AES_VARIANTS[aesKey[1]]) {
        send(404, 'biến thể AES không có', 'text/plain');
        return;
      }
      // Khoá HLS phát công khai qua HTTP — đúng như CDN thật, và đúng chỗ §7 vạch ranh giới:
      // không có kiểm soát truy cập nào để mà vượt.
      const badKey = AES_VARIANTS[aesKey[1]].badKey;
      if (badKey === 'wrong') {
        send(200, AES_KEY_DECOY, 'application/octet-stream');
        return;
      }
      if (badKey === 'html') {
        // 200 kèm HTML: CDN chuyển hướng về trang đăng nhập. Trả 200 là CỐ Ý — lỗi này KHÔNG bị
        // tầng fetch bắt, nó chỉ lộ ra ở bước dựng khoá, nên nó ghim đúng chỗ ta cần ghim.
        send(200, '<!doctype html><title>login</title>Vui lòng đăng nhập', 'text/html');
        return;
      }
      send(
        200,
        aesKey[2] === '1' ? AES_KEY_1 : AES_KEY_0,
        'application/octet-stream',
      );
      return;
    }
    const aesSeg = /^\/hls-aes\/(\w+)\/seg(\d+)\.ts$/.exec(path);
    if (aesSeg) {
      const [, variant, idx] = aesSeg;
      const i = Number(idx);
      if (!AES_VARIANTS[variant] || i < 0 || i > 9) {
        send(404, 'segment AES không có', 'text/plain');
        return;
      }
      const { key, iv } = aesParamsFor(variant, i);
      // Plaintext là ĐÚNG segment của ca `happy` -> kỳ vọng ra file trùng khít: 100 khung.
      send(200, aesEncrypt(readFixture(`seg${i}.bin`), key, iv), 'video/mp2t');
      return;
    }
    const drmPl = /^\/hls-drm\/(\w+)\/media\.m3u8$/.exec(path);
    if (drmPl) {
      if (!DRM_VARIANTS[drmPl[1]]) {
        send(404, 'hệ DRM không có', 'text/plain');
        return;
      }
      send(
        200,
        drmPlaylist(drmPl[1]).replaceAll('__PORT__', String(server.address().port)),
        'application/vnd.apple.mpegurl',
      );
      return;
    }

    const aesPl = /^\/hls-aes\/(\w+)\/media\.m3u8$/.exec(path);
    if (aesPl) {
      if (!AES_VARIANTS[aesPl[1]]) {
        send(404, 'biến thể AES không có', 'text/plain');
        return;
      }
      send(
        200,
        aesPlaylist(aesPl[1], keyHost, server.address().port),
        'application/vnd.apple.mpegurl',
      );
      return;
    }

    // --- GÓI A — HLS fMP4/CMAF (#EXT-X-MAP), có/không mã hoá AES-128 ---
    //
    // Đặt TRƯỚC mọi nhánh /hls/ chung: mấy path này dùng tiền tố riêng nên không đụng, nhưng để
    // gần nhau cho dễ đọc và tránh lặp lại bài học "isSegment nuốt path AES" ở trên.
    // Tên biến thể CÓ THỂ chứa gạch nối (`clear-init`) -> `[\w-]+`, đừng thu về `\w+`: sai chỗ này
    // thì route trả 404 và ca e2e đỏ vì lý do HOÀN TOÀN KHÁC với thứ nó định ghim (đã dính một lần).
    const fmp4 = /^\/hls-fmp4\/([\w-]+)\/([\w-]+)\.(m3u8|mp4|m4s|bin)$/.exec(path);
    if (fmp4) {
      const [, variant, name, ext] = fmp4;
      const v = FMP4_VARIANTS[variant];
      if (!v) {
        send(404, 'biến thể fMP4 không có', 'text/plain');
        return;
      }
      // Khoá AES của track (tách tiếng -> hai khoá khác nhau, đó là điểm ghim của biến thể `aud`).
      const keyM = /^key-([va])$/.exec(name);
      if (keyM && ext === 'bin') {
        send(200, fmp4Key(variant, keyM[1]), 'application/octet-stream');
        return;
      }
      if (name === 'master' && ext === 'm3u8') {
        send(200, fmp4Master(), 'application/vnd.apple.mpegurl');
        return;
      }
      const plM = /^media-([va])$/.exec(name);
      if (plM && ext === 'm3u8') {
        send(
          200,
          fmp4Playlist(variant, plM[1]),
          'application/vnd.apple.mpegurl',
        );
        return;
      }
      // init + segment: mã hoá TẠI CHỖ nếu biến thể khai mã hoá. IV là IV TƯỜNG MINH cho CẢ HAI —
      // đúng RFC 8216 §4.3.2.5 (khoá phủ init thì phải khai IV, vì init không có seq để dẫn IV).
      const initM = /^init-([va])$/.exec(name);
      const segM = /^seg-([va])(\d+)$/.exec(name);
      if ((initM && ext === 'mp4') || (segM && ext === 'm4s')) {
        const track = initM ? initM[1] : segM[1];
        if (segM && Number(segM[2]) >= FMP4_SEGMENTS[track]) {
          send(404, 'segment fMP4 không có', 'text/plain');
          return;
        }
        const plain = readFmp4(track, initM ? 'init' : segM[2]);
        // `keyAfterMap` -> init nằm NGOÀI phạm vi khoá nên phục vụ TRONG SÁNG, segment vẫn mã hoá.
        // Đây là điểm mấu chốt của biến thể `clear-init`: server nói sự thật theo đúng RFC, phía
        // nào giải mã init ở đây là phía đó sai.
        const encryptThis = v.encrypted && !(initM && v.keyAfterMap);
        const body = encryptThis
          ? aesEncrypt(plain, fmp4Key(variant, track), FMP4_EXPLICIT_IV)
          : plain;
        send(200, body, initM ? 'video/mp4' : 'video/iso.segment');
        return;
      }
      send(404, 'tài nguyên fMP4 không có', 'text/plain');
      return;
    }

    // W2.1 debt (a) — two HLS assets on the SAME host (slot a / slot b). Same muxable bytes as the
    // /hls/ set, just under a slot-scoped path so each carries its own token gate (checked above).
    // Placed BEFORE the generic isSegment() route, which slices a fixed '/hls/' prefix and would
    // read the wrong file for these paths. The relative `segN.ts` in media.m3u8 resolves under the
    // slot dir, so no rewrite is needed.
    const dual = /^\/hls-dual\/[ab]\/(media\.m3u8|seg(\d+)\.ts)$/.exec(path);
    if (dual) {
      if (dual[1] === 'media.m3u8') {
        send(200, readFixture('media.m3u8'), 'application/vnd.apple.mpegurl');
      } else {
        send(200, readFixture(`seg${dual[2]}.bin`), 'video/mp2t');
      }
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
    // W2.1 debt (a) — player for one slot. It fetches ONLY that slot's media playlist, carrying the
    // token its gate demands, so the extension observes and stores the real header for that URL.
    // Slot b sends PLAYER_TOKEN_B only in 'different' mode (matching the gate above); otherwise the
    // same PLAYER_TOKEN as slot a.
    const dualPlayer = /^\/player-dual-([ab])\.html$/.exec(path);
    if (dualPlayer) {
      const slot = dualPlayer[1];
      const tok =
        slot === 'b' && dualToken === 'different'
          ? PLAYER_TOKEN_B
          : PLAYER_TOKEN;
      send(
        200,
        `<!doctype html><title>player dual ${slot}</title><p>player ${slot}<script>
          window.__played = fetch('/hls-dual/${slot}/media.m3u8', {
            headers: { 'X-Playback-Session-Id': '${tok}' },
          }).then((r) => r.ok);
        </script>`,
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
    /** W2.1 debt (a) — per-slot player pages + media URLs for the two same-host download scenario. */
    dualPlayerAUrl: `http://127.0.0.1:${port}/player-dual-a.html`,
    dualPlayerBUrl: `http://127.0.0.1:${port}/player-dual-b.html`,
    dualMediaAUrl: `http://127.0.0.1:${port}/hls-dual/a/media.m3u8`,
    dualMediaBUrl: `http://127.0.0.1:${port}/hls-dual/b/media.m3u8`,
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
    /**
     * W3.1 — playlist MÃ HOÁ AES-128, cùng 10 segment plaintext với mediaUrl nên kỳ vọng ra file
     * TRÙNG KHÍT ca `happy` (100 khung). Ba biến thể ghim ba luật khác nhau:
     *   `seq` IV dẫn từ media sequence (MEDIA-SEQUENCE=7, lệch chỉ số mảng);
     *   `iv`  IV khai tường minh trong #EXT-X-KEY;
     *   `rot` hai khoá trong một playlist (đổi ở segment 5).
     */
    aesUrl: (variant) =>
      `http://127.0.0.1:${port}/hls-aes/${variant}/media.m3u8`,
    /** §7 — playlist khai DRM (fairplay/playready/widevine). Extension PHẢI từ chối, không tải. */
    drmUrl: (system) => `http://127.0.0.1:${port}/hls-drm/${system}/media.m3u8`,
    /**
     * GÓI A — playlist HLS **fMP4/CMAF** (có `#EXT-X-MAP`). `track` mặc định 'v' (hình).
     *   `plain` không mã hoá  -> ca chiều ngược lại;
     *   `enc`   AES-128 phủ CẢ init lẫn .m4s, IV tường minh -> ca chính;
     *   `aud`   tách tiếng, mỗi track một khoá riêng.
     */
    fmp4Url: (variant, track = 'v') =>
      `http://127.0.0.1:${port}/hls-fmp4/${variant}/media-${track}.m3u8`,
    /** GÓI A — master của biến thể tách tiếng (hình + tiếng, hai khoá khác nhau). */
    fmp4MasterUrl: (variant) =>
      `http://127.0.0.1:${port}/hls-fmp4/${variant}/master.m3u8`,
    /**
     * Số lần init segment fMP4 được phục vụ -> bằng chứng nhánh `#EXT-X-MAP` có chạy.
     * ⚠️ `[\w-]+` chứ KHÔNG phải `\w+`: tên biến thể có gạch nối (`clear-init`). Dùng `\w+` thì bộ
     * đếm luôn trả 0 và ca đỏ vì lý do hoàn toàn khác thứ nó định ghim (đã dính đúng một lần).
     */
    fmp4InitHits: () =>
      requests.filter((r) =>
        /^\/hls-fmp4\/[\w-]+\/init-[va]\.mp4$/.test(r.url),
      ).length,
    /** Số lượt fetch khoá fMP4, tách theo track -> ghim "mỗi track lấy đúng khoá của mình". */
    fmp4KeyHits: (track) =>
      requests.filter((r) =>
        new RegExp(`^/hls-fmp4/[\\w-]+/key-${track ?? '[va]'}\\.bin$`).test(
          r.url,
        ),
      ).length,
    /** Số segment /hls/ đã phục vụ -> nếu > 0 ở ca DRM nghĩa là guard THỦNG, đã tải thật. */
    plainSegmentHits: () =>
      requests.filter((r) => /^\/hls\/seg\d+\.ts$/.test(r.url) && r.status < 400)
        .length,
    /** Số lần khoá AES thật sự được phục vụ -> bằng chứng đường fetch khoá có chạy. */
    aesKeyHits: () =>
      requests.filter((r) => /^\/hls-aes\/\w+\/key\d\.bin$/.test(r.url)).length,
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
