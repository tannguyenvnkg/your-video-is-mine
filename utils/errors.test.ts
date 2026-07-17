import { describe, expect, it } from 'vitest';
import { describeError } from './errors';

describe('describeError', () => {
  it('lấy message từ Error', () => {
    expect(describeError(new Error('hỏng rồi'))).toBe('hỏng rồi');
  });

  it('bóc tiền tố "Error: " khi @ffmpeg/ffmpeg reject bằng string', () => {
    // worker.js:153 gửi `e.toString()` -> classes.js:54 reject nguyên chuỗi này.
    expect(describeError('Error: failed to import ffmpeg-core.js')).toBe(
      'failed to import ffmpeg-core.js',
    );
  });

  it('bóc cả tên lỗi dẫn xuất và DOMException', () => {
    expect(describeError('TypeError: x is not a function')).toBe(
      'x is not a function',
    );
    expect(describeError('DOMException: Message # 1 was aborted')).toBe(
      'Message # 1 was aborted',
    );
  });

  it('KHÔNG cắt nhầm chuỗi thường có dấu ":"', () => {
    expect(describeError('HTTP 403: forbidden')).toBe('HTTP 403: forbidden');
    expect(describeError('Tải segment lỗi sau 4 lần thử: HTTP 403')).toBe(
      'Tải segment lỗi sau 4 lần thử: HTTP 403',
    );
  });

  it('giữ nguyên chuỗi chỉ có mỗi tiền tố', () => {
    expect(describeError('Error: ')).toBe('Error: ');
  });

  it('lấy message từ object giống Error (cross-realm)', () => {
    expect(describeError({ message: 'lỗi lạ' })).toBe('lỗi lạ');
  });

  it('fallback String() cho giá trị khác', () => {
    expect(describeError(42)).toBe('42');
  });
});
