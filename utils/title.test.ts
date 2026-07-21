import { describe, expect, it } from 'vitest';
import {
  cleanTitle,
  isJunkTitle,
  normalizeInvisible,
  pickTitle,
  sameDocument,
  siteTokens,
} from './title';

describe('normalizeInvisible', () => {
  it('bỏ ký tự vô hình, NBSP -> khoảng trắng, gộp khoảng trắng', () => {
    expect(normalizeInvisible('A​B C﻿')).toBe('AB C');
  });
});

describe('siteTokens', () => {
  it('lấy nguyên hostname + nhãn tên site, bỏ www và đuôi TLD, bỏ gạch nối', () => {
    expect(siteTokens('https://www.abc-xyz.co.uk/a')).toEqual([
      'abcxyzcouk',
      'abcxyz',
    ]);
  });

  // 🔴 REVIEW ĐỐI KHÁNG bắt: nhãn phụ KHÔNG phải tên site.
  it('KHÔNG coi nhãn phụ (live/video/watch) là tên site', () => {
    expect(siteTokens('https://live.vtv.vn/x')).toEqual(['livevtvvn', 'vtv']);
  });
  it('không có pageUrl -> mảng rỗng (KHÔNG đoán)', () => {
    expect(siteTokens(undefined)).toEqual([]);
  });
});

describe('cleanTitle', () => {
  it('KHÔNG cắt số 4 chữ số — đó là năm, không phải bộ đếm thông báo', () => {
    expect(cleanTitle('(2019) Movie', 'https://x.com/')).toBe('(2019) Movie');
  });
});

describe('pickTitle — thứ hạng og > twitter > doc > tab > stored', () => {
  it('og thắng document.title bẩn', () => {
    expect(
      pickTitle(
        { og: 'Tên Video Thật', doc: 'Tên Video Thật - SiteName' },
        'https://sitename.com/x',
      ),
    ).toBe('Tên Video Thật');
  });

  it('twitter thắng doc', () => {
    expect(
      pickTitle({ twitter: 'T Title', doc: 'D Title' }, 'https://a.com/'),
    ).toBe('T Title');
  });

  it('cắt bộ đếm (3) và đuôi tên site khớp hostname', () => {
    expect(
      pickTitle(
        { doc: '(3) Real Name | YouTube' },
        'https://www.youtube.com/watch',
      ),
    ).toBe('Real Name');
  });

  // 🔴 GHIM CHỐNG DƯƠNG TÍNH GIẢ — cắt bừa sau dấu gạch sẽ giết số tập phim.
  it('KHÔNG cắt đuôi khi đuôi không khớp tên site', () => {
    expect(
      pickTitle({ doc: 'Real Name - Part 2' }, 'https://example.com/'),
    ).toBe('Real Name - Part 2');
  });

  it('chỉ cắt ĐÚNG MỘT đoạn đuôi cuối cùng', () => {
    expect(pickTitle({ doc: 'A – B — C' }, 'https://c.com/')).toBe('A – B');
  });

  it('tiêu đề chỉ là tên site -> rác -> rơi xuống hạng dưới', () => {
    expect(
      pickTitle({ doc: 'YouTube' }, 'https://youtube.com/'),
    ).toBeUndefined();
  });

  it('thiếu pageUrl -> BỎ QUA luật cắt đuôi, không đoán tên site', () => {
    expect(pickTitle({ doc: 'Real - Site' }, undefined)).toBe('Real - Site');
  });

  it('ứng viên chỉ có khoảng trắng bị bỏ qua', () => {
    expect(pickTitle({ og: '   ', doc: 'Real Name' }, 'https://a.com/')).toBe(
      'Real Name',
    );
  });

  // 🔴 `stored` là ỨNG VIÊN CÓ HẠNG, không phải `??` cuối chuỗi.
  it('stored là hạng chót nhưng vẫn được dùng khi không còn ai', () => {
    expect(pickTitle({ og: 'Live', stored: 'Stale' }, 'https://a.com/')).toBe(
      'Live',
    );
    expect(pickTitle({ stored: 'Stale' }, 'https://a.com/')).toBe('Stale');
  });

  it('không có ứng viên nào -> undefined', () => {
    expect(pickTitle({}, 'https://a.com/')).toBeUndefined();
  });

  // 🔴 BẪY CHO LẦN REFACTOR SAU: og/twitter do tác giả trang tự đặt -> KHÔNG được làm sạch.
  it('KHÔNG làm sạch og/twitter', () => {
    expect(
      pickTitle({ og: '(3) Real - YouTube' }, 'https://youtube.com/'),
    ).toBe('(3) Real - YouTube');
  });

  // 🔴 REVIEW ĐỐI KHÁNG (3/3 giữ, đo bằng probe): 'live.vtv.vn' sinh token 'live' -> tiêu đề thật
  // "Chung kết - Live" bị cắt cụt thành "Chung kết". Đúng loại lỗi TÊN SAI mà gói này thề tránh.
  it('KHÔNG cắt chữ trùng tên NHÃN PHỤ của hostname', () => {
    expect(
      pickTitle({ doc: 'Chung kết - Live' }, 'https://live.vtv.vn/x'),
    ).toBe('Chung kết - Live');
  });

  // 🔴 Chứa-chuỗi với token ngắn cắt bừa: token 'abc' từng khớp vào đuôi 'ABC Studio'.
  it('KHÔNG cắt đuôi chỉ vì nó CHỨA một token ngắn', () => {
    expect(
      pickTitle({ doc: 'Phim hay - ABC Studio' }, 'https://abc.vn/x'),
    ).toBe('Phim hay - ABC Studio');
  });

  it('tiêu đề <= 1 ký tự là rác', () => {
    expect(pickTitle({ doc: 'A' }, 'https://a.com/')).toBeUndefined();
  });
});

describe('isJunkTitle', () => {
  it('rỗng và tên chung chung là rác', () => {
    expect(isJunkTitle('', 'https://a.com/')).toBe(true);
    expect(isJunkTitle('video', 'https://a.com/')).toBe(true);
    expect(isJunkTitle('Tên video thật', 'https://a.com/')).toBe(false);
  });
});

describe('sameDocument', () => {
  it('bỏ qua hash — đổi #t=90 KHÔNG phải điều hướng', () => {
    expect(sameDocument('https://a.com/w?v=1#t=9', 'https://a.com/w?v=1')).toBe(
      true,
    );
  });
  it('khác query -> khác trang', () => {
    expect(sameDocument('https://a.com/w?v=1', 'https://a.com/w?v=2')).toBe(
      false,
    );
  });
  it('thiếu một vế -> false (không đoán)', () => {
    expect(sameDocument(undefined, 'https://a.com/')).toBe(false);
  });

  // 🔴 REVIEW ĐỐI KHÁNG (3/3 giữ): SPA hash-router thì hash CHÍNH LÀ trang.
  it('hash-router: #/xem/1 và #/xem/2 là HAI trang khác nhau', () => {
    expect(sameDocument('https://a.com/#/xem/1', 'https://a.com/#/xem/2')).toBe(
      false,
    );
    expect(sameDocument('https://a.com/#!/v/1', 'https://a.com/#!/v/2')).toBe(
      false,
    );
  });

  // Ghim origin: bản cài đặt bỏ qua origin sẽ lọt hết mấy ca trên.
  it('khác origin -> khác trang', () => {
    expect(sameDocument('https://a.com/w', 'https://b.com/w')).toBe(false);
    expect(sameDocument('https://a.com/w', 'http://a.com/w')).toBe(false);
  });

  // 🔴 W4.3 nợ — tham số RÁC (tracking + tua) tự thêm vào không được đóng cổng đặt tên.
  it('bỏ qua tham số rác đã biết (utm_*, fbclid, t) -> vẫn CÙNG trang', () => {
    expect(
      sameDocument('https://a.com/w?v=1&utm_source=fb', 'https://a.com/w?v=1'),
    ).toBe(true);
    expect(
      sameDocument(
        'https://a.com/w?v=1&fbclid=xyz&t=90',
        'https://a.com/w?v=1',
      ),
    ).toBe(true);
  });

  it('thứ tự tham số KHÔNG đổi kết quả (trang có thể sắp lại)', () => {
    expect(
      sameDocument('https://a.com/w?a=1&b=2', 'https://a.com/w?b=2&a=1'),
    ).toBe(true);
  });

  // 🔴 CHỐNG NỚI OAN: tham số ĐỊNH DANH (?v=) khác nhau vẫn phải là HAI trang, nếu không cổng
  // chống-đặt-nhầm-tên coi hai video là một -> đặt tên video A cho video B.
  it('tham số LẠ (không thuộc danh sách rác) khác nhau -> KHÁC trang', () => {
    expect(sameDocument('https://a.com/w?v=1', 'https://a.com/w?v=2')).toBe(
      false,
    );
    expect(
      sameDocument('https://a.com/w?id=abc', 'https://a.com/w?id=def'),
    ).toBe(false);
  });
});
