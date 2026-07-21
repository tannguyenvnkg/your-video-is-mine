import { describe, expect, it } from 'vitest';
import {
  baseNameFromUrl,
  buildDownloadFilename,
  DEFAULT_FILENAME_TEMPLATE,
  extForMedia,
  isUsableTemplate,
  renderFilenameTemplate,
  sanitizeFilename,
  truncateUtf8,
  type TemplateVars,
} from './filename';

const bytes = (s: string) => new TextEncoder().encode(s).length;

// Surrogate ĐƠN ĐỘC = dấu vết của một nhát cắt chẻ đôi emoji. Lưu ý: KHÔNG được kiểm bằng
// /[\uD800-\uDFFF]/ — mọi emoji hợp lệ đều là một CẶP surrogate nên regex đó luôn khớp.
const hasLoneSurrogate = (s: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    s,
  );

describe('sanitizeFilename', () => {
  it('thay ký tự cấm bằng _', () => {
    expect(sanitizeFilename('a/b:c*?"<>|d')).toBe('a_b_c_d');
  });
  it('bỏ khoảng trắng/dấu chấm thừa 2 đầu', () => {
    expect(sanitizeFilename('  ..Tên video..  ')).toBe('Tên video');
  });
  it('GIỮ NGUYÊN chữ hoa, chữ số, dấu cách và gạch nối', () => {
    expect(sanitizeFilename('My Video 2024 HD-1080p')).toBe(
      'My Video 2024 HD-1080p',
    );
  });
});

describe('extForMedia', () => {
  it('theo đuôi trong URL', () => {
    expect(extForMedia('https://a.com/v.webm?x=1')).toBe('.webm');
  });
  it('theo Content-Type khi URL không có đuôi video', () => {
    expect(extForMedia('https://a.com/stream', 'video/mp4')).toBe('.mp4');
    expect(extForMedia('https://a.com/stream', 'video/webm')).toBe('.webm');
  });
  it('mặc định .mp4', () => {
    expect(extForMedia('https://a.com/stream')).toBe('.mp4');
  });
});

describe('baseNameFromUrl', () => {
  it('lấy tên file không đuôi', () => {
    expect(baseNameFromUrl('https://a.com/dir/clip.mp4?t=1')).toBe('clip');
  });
  it('fallback hostname khi path rỗng', () => {
    expect(baseNameFromUrl('https://a.com/')).toBe('a.com');
  });
});

describe('buildDownloadFilename', () => {
  it('ghép tiêu đề + độ phân giải + đuôi', () => {
    expect(
      buildDownloadFilename({
        url: 'https://a.com/x.mp4',
        title: 'Phim hay',
        height: 720,
      }),
    ).toBe('Phim hay_720p.mp4');
  });

  it('làm sạch tiêu đề có ký tự cấm', () => {
    expect(
      buildDownloadFilename({ url: 'https://a.com/x.mp4', title: 'a/b:c' }),
    ).toBe('a_b_c.mp4');
  });

  it('fallback tên URL khi không có tiêu đề', () => {
    expect(buildDownloadFilename({ url: 'https://a.com/dir/movie.webm' })).toBe(
      'movie.webm',
    );
  });

  it('thêm thư mục con', () => {
    expect(
      buildDownloadFilename({
        url: 'https://a.com/x.mp4',
        title: 'clip',
        folder: 'YVIM',
      }),
    ).toBe('YVIM/clip.mp4');
  });

  it('đuôi từ Content-Type khi URL không rõ', () => {
    expect(
      buildDownloadFilename({
        url: 'https://a.com/play',
        title: 'live',
        contentType: 'video/webm',
      }),
    ).toBe('live.webm');
  });
});

// ── W4.3 ────────────────────────────────────────────────────────────────────

describe('truncateUtf8 + sanitizeFilename cắt theo BYTE', () => {
  it('cắt emoji KHÔNG chẻ đôi surrogate', () => {
    const out = sanitizeFilename('🎬'.repeat(200));
    expect(bytes(out)).toBeLessThanOrEqual(200);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it('tiếng Việt có dấu vẫn nằm trong trần byte', () => {
    expect(
      bytes(sanitizeFilename('Tên video '.repeat(40))),
    ).toBeLessThanOrEqual(200);
  });

  // 🔴 GHIM THỨ TỰ: cắt TRƯỚC rồi mới tỉa 2 đầu. Làm ngược lại thì nhát cắt để lộ dấu '.' cuối.
  it('không để lộ dấu chấm/gạch dưới cuối tên sau khi cắt', () => {
    const out = sanitizeFilename('a'.repeat(199) + '.xyz');
    expect(out.endsWith('.')).toBe(false);
    expect(out.endsWith('_')).toBe(false);
    expect(out.endsWith(' ')).toBe(false);
  });

  it('ASCII dài 150 vẫn giữ nguyên (nới hơn trần 120 cũ)', () => {
    expect(sanitizeFilename('a'.repeat(150))).toBe('a'.repeat(150));
  });

  it('bỏ ký tự vô hình lọt vào tên file', () => {
    expect(sanitizeFilename('A\u200BB')).toBe('AB');
  });

  // NBSP hay lọt ra từ tiêu đề trang. Phải thành khoảng trắng THƯỜNG, không giữ nguyên.
  it('NBSP -> khoảng trắng thường', () => {
    const out = sanitizeFilename('Tên\u00A0video\u202Fhay');
    expect(out).toBe('Tên video hay');
    expect(/[\u00A0\u2007\u202F]/.test(out)).toBe(false);
  });

  it('truncateUtf8 đếm theo byte chứ không theo ký tự', () => {
    expect(bytes(truncateUtf8('é'.repeat(100), 10))).toBeLessThanOrEqual(10);
  });

  // 🔴 Trần LẺ so với bề rộng emoji (5 byte / emoji 4 byte) -> nhát cắt rơi ĐÚNG giữa cặp
  // surrogate nếu lặp theo UTF-16 unit. Trần chẵn như 200 thì lỗi này lọt do ăn may số học.
  it('trần lẻ vẫn không chẻ đôi emoji', () => {
    const out = truncateUtf8('🎬🎬🎬', 5);
    expect(bytes(out)).toBeLessThanOrEqual(5);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).toBe('🎬');
  });
});

describe('renderFilenameTemplate', () => {
  const vars: TemplateVars = {
    title: 'A',
    basename: 'x',
    res: '_720p',
    site: 's.com',
    date: '2026-07-19',
    time: '143500',
  };

  it('thay token', () => {
    expect(renderFilenameTemplate('{title}{res}', vars)).toBe('A_720p');
  });

  // 🔴 Dấu gạch nằm TRONG token {res} -> không có video nào ra tên 'A_'.
  it('res rỗng thì KHÔNG để lại dấu gạch thừa', () => {
    expect(renderFilenameTemplate('{title}{res}', { ...vars, res: '' })).toBe(
      'A',
    );
  });

  // 🔴 '{' và '}' KHÔNG nằm trong danh sách ký tự cấm -> token lạ mà giữ nguyên là nó ra tới đĩa.
  it('token lạ -> rỗng, KHÔNG để dấu ngoặc lọt ra tên file', () => {
    expect(renderFilenameTemplate('{title}_{nope}', vars)).toBe('A_');
  });
});

describe('isUsableTemplate', () => {
  it('mẫu phải sinh được tên PHÂN BIỆT giữa các video', () => {
    expect(isUsableTemplate('{title}{res}')).toBe(true);
    expect(isUsableTemplate('{basename}')).toBe(true);
    expect(isUsableTemplate('{date}')).toBe(false);
    expect(isUsableTemplate('   ')).toBe(false);
  });
});

describe('buildDownloadFilename + mẫu tên', () => {
  it('mẫu mặc định cho ra ĐÚNG kết quả như trước W4.3', () => {
    expect(DEFAULT_FILENAME_TEMPLATE).toBe('{title}{res}');
  });

  it('mẫu có {site} và {date}', () => {
    // 🔴 W4.3 nợ — {date} lấy theo giờ MÁY (new Date(now) getters local), nên kỳ vọng PHẢI dựng từ
    // chính new Date(now), KHÔNG hardcode chuỗi. Bản cũ hardcode '2026-07-19' + Date.UTC làm máy ở
    // UTC+13/+14 ĐỎ OAN (12:00Z ngày 19 rơi sang ngày 20 giờ địa phương). Đây là test đo múi giờ
    // của máy chạy test, không phải đo hành vi -> phải tự-nhất-quán với môi trường.
    const now = Date.UTC(2026, 6, 19, 12, 0, 0);
    const d = new Date(now);
    const p2 = (n: number) => String(n).padStart(2, '0');
    const expectDate = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    expect(
      buildDownloadFilename({
        url: 'https://a.com/x.mp4',
        title: 'A',
        template: '{site}_{title}_{date}',
        pageUrl: 'https://www.site.com/w',
        now,
      }),
    ).toBe(`site.com_A_${expectDate}.mp4`);
  });

  // 🔴 W4.3 nợ — {time} và hàm two() (pad 2 chữ số) là token ĐÃ SHIP mà chưa có một assertion nào.
  // Dùng new Date(local components) rồi đọc lại local components -> ĐỘC LẬP MÚI GIỜ (không như
  // Date.UTC). Chọn giờ/phút/giây MỘT CHỮ SỐ để ghim đúng two(): thiếu pad thì '305' thay vì '030509'.
  it('{time} = HHMMSS theo giờ máy, có pad 2 chữ số (ghim two())', () => {
    const now = new Date(2026, 0, 2, 3, 5, 9).getTime(); // 03:05:09 giờ địa phương
    expect(
      buildDownloadFilename({
        url: 'https://a.com/x.mp4',
        title: 'A',
        template: '{title}_{time}',
        now,
      }),
    ).toBe('A_030509.mp4');
  });

  it('{time} pad cả ca hai chữ số (không cắt cụt số lớn)', () => {
    const now = new Date(2026, 0, 2, 23, 47, 58).getTime();
    expect(
      buildDownloadFilename({
        url: 'https://a.com/x.mp4',
        title: 'A',
        template: '{title}_{time}',
        now,
      }),
    ).toBe('A_234758.mp4');
  });

  it('{title} rỗng -> lùi về tên từ URL', () => {
    expect(
      buildDownloadFilename({
        url: 'https://a.com/dir/movie.webm',
        title: '',
        template: '{title}',
      }),
    ).toBe('movie.webm');
  });

  // 🔴 Đường lùi TẦNG HAI, chạy SAU sanitize: mẫu toàn token lạ sẽ ra chuỗi rỗng.
  it('mẫu vô nghĩa -> vẫn ra tên dùng được, không bao giờ rỗng', () => {
    expect(
      buildDownloadFilename({
        url: 'https://a.com/dir/movie.webm',
        template: '{nope}',
      }),
    ).toBe('movie.webm');
    expect(
      buildDownloadFilename({ url: 'https://a.com/', template: '{nope}' }),
    ).toBe('a.com.mp4');
  });

  // 🔴 GHIM THỨ TỰ: mẫu '...' render ra CHUỖI KHÁC RỖNG, chỉ sau khi sanitize mới thành rỗng.
  // Kiểm đường lùi TRƯỚC sanitize là lọt ca này -> ra file tên '.mp4' (file ẩn, không đuôi).
  it('mẫu chỉ toàn ký tự bị sanitize ăn sạch -> vẫn lùi được', () => {
    expect(
      buildDownloadFilename({
        url: 'https://a.com/dir/movie.webm',
        template: '...',
      }),
    ).toBe('movie.webm');
  });

  // 🔴 Mẫu do user gõ KHÔNG được đẻ ra thư mục: '/' duy nhất hợp lệ là dấu ngăn folder.
  it('mẫu KHÔNG chèn được dấu ngăn thư mục', () => {
    expect(
      buildDownloadFilename({
        url: 'https://a.com/x.mp4',
        title: 'A',
        template: '{title}/{title}',
        folder: 'YVIM',
      }),
    ).toBe('YVIM/A_A.mp4');
  });
});
