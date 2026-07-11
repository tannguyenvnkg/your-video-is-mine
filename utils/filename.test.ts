import { describe, expect, it } from 'vitest';
import {
  baseNameFromUrl,
  buildDownloadFilename,
  extForMedia,
  sanitizeFilename,
} from './filename';

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
