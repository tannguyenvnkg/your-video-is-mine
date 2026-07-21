// W2.1 — test ĐỎ TRƯỚC cho việc bắt & phát lại header THẬT của player.
//
// 🔬 MỌI QUYẾT ĐỊNH DƯỚI ĐÂY ĐỀU ĐÃ ĐO TRONG EDGE THẬT (2026-07-19), đừng "đơn giản hoá" theo
// trực giác. Bảng đo (fetch từ SERVICE WORKER, tabId -1, tới server echo ghi lại header nhận được):
//
//   header                | fetch(url,{headers}) | DNR modifyHeaders
//   ----------------------|----------------------|------------------
//   Cookie                | ❌ RƠI, KHÔNG NÉM    | ✅ tới nơi
//   Referer               | ❌ RƠI, KHÔNG NÉM    | ✅ tới nơi
//   User-Agent            | ❌ RƠI, KHÔNG NÉM    | ✅ tới nơi
//   Origin                | ✅ tới nơi           | ✅ tới nơi
//   Authorization         | ✅ tới nơi           | ✅ tới nơi
//   X-Playback-Session-Id | ✅ tới nơi           | ✅ tới nơi
//
// HAI HỆ QUẢ THIẾT KẾ:
// 1. Cột "RƠI, KHÔNG NÉM" là loại lỗi XANH-VÀ-IM-LẶNG đã giết dự án này 3 lần. `fetch` nhận header
//    rồi vứt đi không một lời báo -> KHÔNG được phát lại bằng `fetch(headers)`.
// 2. DNR đặt được MỌI header đã đo -> phát lại TOÀN BỘ qua DNR, KHÔNG đụng vào chuỗi fetch của
//    offscreen. Nhờ vậy tránh luôn bẫy `retry.ts` (thêm key `headers` thứ hai sẽ đè mất `Range`
//    của byterange W1.3 — hỏng fMP4/CMAF trong im lặng).
//
// ⚠️ CẢNH BÁO ĐO SAI NGỮ CẢNH: lần đo đầu tiên chạy fetch từ trang options -> trang có tabId THẬT
// nên rule `tabIds:[-1]` KHÔNG khớp -> mọi header trượt, KỂ CẢ referer (thứ ta biết chắc production
// đang chạy được). Suýt kết luận ngược hoàn toàn. Đo lại từ SW mới ra bảng trên.

import { describe, it, expect } from 'vitest';
import {
  capturedFromHeaderList,
  filterCapturable,
  planHeaderReplay,
  shouldCaptureRequest,
  stripSensitive,
} from './headers';

describe('capturedFromHeaderList — chuẩn hoá danh sách header của webRequest', () => {
  it('hạ tên header về chữ thường (webRequest trả lẫn lộn "User-Agent" và "sec-ch-ua")', () => {
    expect(
      capturedFromHeaderList([
        { name: 'Referer', value: 'https://site.example/watch' },
        { name: 'X-Playback-Session-Id', value: 'abc' },
      ]),
    ).toEqual({
      referer: 'https://site.example/watch',
      'x-playback-session-id': 'abc',
    });
  });

  it('bỏ header không có value (webRequest có thể trả binaryValue thay vì value)', () => {
    expect(
      capturedFromHeaderList([
        { name: 'Referer', value: 'https://site.example/' },
        { name: 'X-Weird' },
      ]),
    ).toEqual({ referer: 'https://site.example/' });
  });

  it('danh sách rỗng -> object rỗng', () => {
    expect(capturedFromHeaderList([])).toEqual({});
  });
});

describe('shouldCaptureRequest — chỉ bắt header của PLAYER TRANG', () => {
  // 🔬 ĐO THẬT: fetch của CHÍNH extension CŨNG lọt vào onSendHeaders, mang
  // initiator='chrome-extension://<id>'. Không lọc thì ta bắt lại chính header BỊA của mình rồi
  // "phát lại" nó ở lần sau — vòng tự đầu độc, và mọi cổng vẫn XANH.
  const extId = 'eodhaphachabehmjnpdombgcpkmigkcd';

  it('BẮT request do trang phát (tabId thật, initiator là site)', () => {
    expect(
      shouldCaptureRequest(
        { tabId: 7, initiator: 'https://site.example', type: 'xmlhttprequest' },
        extId,
      ),
    ).toBe(true);
  });

  it('🔴 KHÔNG bắt request do chính extension phát (initiator chrome-extension://<id>)', () => {
    expect(
      shouldCaptureRequest(
        {
          tabId: 7,
          initiator: `chrome-extension://${extId}`,
          type: 'xmlhttprequest',
        },
        extId,
      ),
    ).toBe(false);
  });

  it('🔴 KHÔNG bắt request không gắn tab (tabId -1 = do SW/offscreen của ta phát)', () => {
    expect(
      shouldCaptureRequest(
        { tabId: -1, initiator: undefined, type: 'xmlhttprequest' },
        extId,
      ),
    ).toBe(false);
  });

  it('BẮT type "media" (thẻ <video> tải thẳng, không qua XHR)', () => {
    expect(
      shouldCaptureRequest(
        { tabId: 7, initiator: 'https://site.example', type: 'media' },
        extId,
      ),
    ).toBe(true);
  });

  it('KHÔNG bắt main_frame (điều hướng trang, không phải request của player)', () => {
    expect(
      shouldCaptureRequest(
        { tabId: 7, initiator: 'https://site.example', type: 'main_frame' },
        extId,
      ),
    ).toBe(false);
  });
});

describe('planHeaderReplay — phát lại CÙNG host (đầy đủ)', () => {
  const same = (h: Record<string, string>) =>
    planHeaderReplay(h, { sameHost: true });

  it('phát lại Referer/Origin đúng giá trị trang đã gửi', () => {
    expect(
      same({
        referer: 'https://site.example/watch?v=1',
        origin: 'https://site.example',
      }).headers,
    ).toEqual({
      referer: 'https://site.example/watch?v=1',
      origin: 'https://site.example',
    });
  });

  it('phát lại Authorization + header token lạ (đúng cơn đau 403 của §2.11)', () => {
    expect(
      same({
        authorization: 'Bearer TOKEN123',
        'x-playback-session-id': 'sess-9',
      }).headers,
    ).toEqual({
      authorization: 'Bearer TOKEN123',
      'x-playback-session-id': 'sess-9',
    });
  });

  it('🔴 KHÔNG phát lại Cookie — jar của trình duyệt đã tự gửi rồi', () => {
    // 🔬 ĐO THẬT: mọi cú fetch media của ta đều đã có credentials:'include' và TỰ MANG cookie thật
    // của site (đo được ở probe: extension fetch nhận đúng `playertoken` mà không cần làm gì).
    // Phát lại bản chụp sẽ (a) đè cookie CŨ lên cookie mới, (b) rò cookie site sang host CDN khác.
    const out = same({
      cookie: 'sid=SECRET',
      referer: 'https://site.example/',
    });
    expect(out.headers).not.toHaveProperty('cookie');
    expect(out.dropped).toContain('cookie');
  });

  it('🔴 VỨT Range — đó là header của TA (byterange W1.3), không phải của trang', () => {
    const out = same({ range: 'bytes=0-100' });
    expect(out.headers).toEqual({});
    expect(out.dropped).toContain('range');
  });

  it('VỨT header tầng vận chuyển / danh tính trình duyệt (ta cùng trình duyệt, phát lại vô nghĩa)', () => {
    expect(
      same({
        host: 'site.example',
        connection: 'keep-alive',
        'content-length': '0',
        'accept-encoding': 'gzip',
        'proxy-authorization': 'x',
        'user-agent': 'Mozilla/5.0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
      }).headers,
    ).toEqual({});
  });
});

describe('planHeaderReplay — phát lại sang host KHÁC (thu hẹp)', () => {
  // Vì sao phải phân biệt: rule DNR khớp theo HOST và ôm MỌI request tab-less tới host đó. Bắn
  // `Authorization` của site A sang CDN B là RÒ THÔNG TIN XÁC THỰC — tệ hơn hẳn cái 403 nó định
  // chữa. Referer/Origin thì ngược lại: chúng chính là danh tính TRANG, và bắn sang CDN là ĐÚNG
  // mục đích (§2.4: key/segment hay nằm host khác và chính là chỗ kiểm Referer gắt nhất).
  const cross = (h: Record<string, string>) =>
    planHeaderReplay(h, { sameHost: false });

  it('Referer/Origin VẪN phát sang host khác (đó là mục đích của W2.3)', () => {
    expect(
      cross({
        referer: 'https://site.example/watch',
        origin: 'https://site.example',
      }).headers,
    ).toEqual({
      referer: 'https://site.example/watch',
      origin: 'https://site.example',
    });
  });

  it('🔴 KHÔNG bắn Authorization sang host khác', () => {
    const out = cross({
      authorization: 'Bearer TOKEN123',
      referer: 'https://site.example/',
    });
    expect(out.headers).not.toHaveProperty('authorization');
    expect(out.headers).toEqual({ referer: 'https://site.example/' });
    expect(out.dropped).toContain('authorization');
  });

  it('🔴 KHÔNG bắn header token lạ (x-*) sang host khác', () => {
    const out = cross({ 'x-playback-session-id': 'sess-9' });
    expect(out.headers).toEqual({});
    expect(out.isEmpty).toBe(true);
  });
});

describe('planHeaderReplay — QUY TẮC VÀNG và đường lùi', () => {
  it('🔴 trang KHÔNG gửi Origin -> ta KHÔNG sinh Origin', () => {
    // §2.11: code cũ set Origin VÔ ĐIỀU KIỆN lên GET. Player thật thường không gửi Origin, và một
    // số CDN coi Origin lạ trên GET là vi phạm CORS -> chính rule "chống 403" GÂY RA 403.
    const out = planHeaderReplay(
      { referer: 'https://site.example/' },
      { sameHost: true },
    );
    expect(out.headers).toEqual({ referer: 'https://site.example/' });
    expect(out.headers).not.toHaveProperty('origin');
  });

  it('bản chụp rỗng -> isEmpty true (caller PHẢI lùi về spoof cũ)', () => {
    expect(planHeaderReplay({}, { sameHost: true }).isEmpty).toBe(true);
  });

  it('🔴 chỉ có header bị vứt -> isEmpty TRUE, không được coi là "đã bắt được"', () => {
    // Nếu isEmpty sai ở đây, caller tưởng đã có header thật nên BỎ đường lùi Referer bịa ->
    // mất tính năng vượt 403 ĐANG CHẠY ĐƯỢC (e2e variants-403 / segments-other-host / progressive-403).
    // Đây là ca hồi quy nguy hiểm nhất của cả gói W2.1.
    expect(
      planHeaderReplay({ 'accept-encoding': 'gzip' }, { sameHost: true })
        .isEmpty,
    ).toBe(true);
  });

  it('có ít nhất một header phát lại được -> isEmpty false', () => {
    expect(
      planHeaderReplay({ referer: 'https://a.example/' }, { sameHost: true })
        .isEmpty,
    ).toBe(false);
  });
});

// ── Sửa sau review đối kháng (2026-07-19) ────────────────────────────────────────────────────
// Ba lỗi dưới đây do 4 lăng kính ĐỘC LẬP cùng chỉ vào (2 lỗi được nêu 2 lần từ 2 lăng kính khác
// nhau). Theo bài học W1.5: **sự hội tụ của nhiều lăng kính mạnh hơn số phiếu** — đi ĐO, và cả ba
// đều đo ra là THẬT.
describe('🔴 REVIEW: header vô hại KHÔNG được giả vờ là "đã bắt được"', () => {
  it('accept + accept-language một mình -> isEmpty TRUE (không được chặn đường lùi)', () => {
    // 🔬 ĐO THẬT: bản chụp của player LUÔN có `accept` và `accept-language` (thấy trong probe).
    // Trang đặt `Referrer-Policy: no-referrer` (rất phổ biến đúng trên site chống hotlink) thì bản
    // chụp KHÔNG có referer. Trước bản vá: hai header vô hại này sống sót -> isEmpty=false ->
    // caller tưởng "đã có header thật" -> BỎ đường lùi Referer bịa -> mất luôn tính năng vượt 403
    // đang chạy được. Test cũ trượt vì chỉ thử `accept-encoding` (vốn đã nằm trong NEVER_REPLAY).
    const out = planHeaderReplay(
      { accept: '*/*', 'accept-language': 'en-US,en;q=0.9' },
      { sameHost: true },
    );
    expect(out.headers).toEqual({});
    expect(out.isEmpty).toBe(true);
  });

  it('accept vô hại + referer thật -> vẫn phát lại referer', () => {
    const out = planHeaderReplay(
      { accept: '*/*', referer: 'https://site.example/watch' },
      { sameHost: true },
    );
    expect(out.headers).toEqual({ referer: 'https://site.example/watch' });
    expect(out.isEmpty).toBe(false);
  });
});

describe('🔴 REVIEW: KHÔNG phát lại cache validator (biến request thành 304 rỗng)', () => {
  it('if-none-match / if-modified-since bị vứt', () => {
    // Player đã fetch manifest một lần -> lần sau trình duyệt gắn `If-None-Match: "v37"`. Phát lại
    // cái đó lên cú fetch MỚI của ta -> máy chủ trả **304 không body** -> parse playlist rỗng.
    // Live HLS refresh mỗi target-duration nên ca này không hiếm chút nào.
    const out = planHeaderReplay(
      {
        'if-none-match': '"v37"',
        'if-modified-since': 'Wed, 19 Jul 2026 00:00:00 GMT',
        referer: 'https://site.example/',
      },
      { sameHost: true },
    );
    expect(out.headers).toEqual({ referer: 'https://site.example/' });
    expect(out.dropped).toContain('if-none-match');
    expect(out.dropped).toContain('if-modified-since');
  });
});

describe('🔴 REVIEW: rule mang header nhạy cảm phải neo theo ORIGIN, không theo host', () => {
  it('có header nhạy cảm -> hasSensitive TRUE', () => {
    // DNR `requestDomains:['example.com']` khớp CẢ subdomain (api./accounts./cdn.). Nghĩa là rule
    // mang `Authorization` của media trên apex sẽ bắn token đó sang MỌI subdomain mà extension
    // fetch tới — kể cả host segment mà ta đã cố tình tước auth ở nhánh cross-host. Lá chắn
    // cross-host bị vô hiệu bởi chính ngữ nghĩa khớp subdomain của DNR.
    expect(
      planHeaderReplay(
        { authorization: 'Bearer T', referer: 'https://site.example/' },
        { sameHost: true },
      ).hasSensitive,
    ).toBe(true);
  });

  it('chỉ Referer/Origin -> hasSensitive FALSE (được phép phủ rộng theo host)', () => {
    expect(
      planHeaderReplay(
        { referer: 'https://site.example/', origin: 'https://site.example' },
        { sameHost: true },
      ).hasSensitive,
    ).toBe(false);
  });
});

describe('🔴 REVIEW: filterCapturable — không LƯU thứ không bao giờ phát lại', () => {
  it('Cookie không bao giờ chạm tới storage', () => {
    // Riêng tư: listener chạy trên `<all_urls>` nên nếu lưu nguyên bản chụp thì Cookie THÔ của mọi
    // site có video (LMS nội bộ, khoá học trả phí…) nằm trong storage.session dù user chưa hề bấm
    // tải. Ta đã quyết KHÔNG phát lại Cookie -> vậy thì đừng lưu nó ngay từ đầu.
    const out = filterCapturable({
      cookie: 'sid=SECRET',
      referer: 'https://site.example/',
      'x-playback-session-id': 'tok',
    });
    expect(out).toEqual({
      referer: 'https://site.example/',
      'x-playback-session-id': 'tok',
    });
  });

  it('bản chụp chỉ toàn rác -> object rỗng (caller bỏ qua, không ghi storage)', () => {
    expect(
      filterCapturable({ accept: '*/*', 'accept-encoding': 'gzip' }),
    ).toEqual({});
  });
});

describe('W2.1 nợ (a) — stripSensitive: hạ plan xuống chỉ referer/origin', () => {
  it('bỏ Authorization + token x-*, GIỮ referer/origin', () => {
    const plan = planHeaderReplay(
      {
        referer: 'https://site.example/',
        origin: 'https://site.example',
        authorization: 'Bearer TOKEN_A',
        'x-playback-session-id': 'sess-9',
      },
      { sameHost: true },
    );
    expect(plan.hasSensitive).toBe(true); // tiền đề: plan gốc có nhạy cảm
    const stripped = stripSensitive(plan);
    expect(stripped.headers).toEqual({
      referer: 'https://site.example/',
      origin: 'https://site.example',
    });
    expect(stripped.hasSensitive).toBe(false);
    expect(stripped.isEmpty).toBe(false);
  });

  it('plan chỉ toàn header nhạy cảm -> sau khi hạ thành RỖNG (caller lùi về Referer bịa)', () => {
    const plan = planHeaderReplay(
      { authorization: 'Bearer TOKEN_A' },
      { sameHost: true },
    );
    const stripped = stripSensitive(plan);
    expect(stripped.headers).toEqual({});
    expect(stripped.isEmpty).toBe(true);
  });
});
