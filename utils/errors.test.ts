import { describe, expect, it } from 'vitest';
import { describeError } from './errors';

describe('describeError', () => {
  it('gets the message from an Error', () => {
    expect(describeError(new Error('hỏng rồi'))).toBe('hỏng rồi');
  });

  it('strips the "Error: " prefix when @ffmpeg/ffmpeg rejects with a string', () => {
    // worker.js:153 sends `e.toString()` -> classes.js:54 rejects with this exact string.
    expect(describeError('Error: failed to import ffmpeg-core.js')).toBe(
      'failed to import ffmpeg-core.js',
    );
  });

  it('also strips derived error names and DOMException', () => {
    expect(describeError('TypeError: x is not a function')).toBe(
      'x is not a function',
    );
    expect(describeError('DOMException: Message # 1 was aborted')).toBe(
      'Message # 1 was aborted',
    );
  });

  it('does NOT wrongly cut an ordinary string containing ":"', () => {
    expect(describeError('HTTP 403: forbidden')).toBe('HTTP 403: forbidden');
    expect(describeError('Tải segment lỗi sau 4 lần thử: HTTP 403')).toBe(
      'Tải segment lỗi sau 4 lần thử: HTTP 403',
    );
  });

  it('keeps a string that is just the prefix unchanged', () => {
    expect(describeError('Error: ')).toBe('Error: ');
  });

  it('gets the message from an Error-like object (cross-realm)', () => {
    expect(describeError({ message: 'lỗi lạ' })).toBe('lỗi lạ');
  });

  it('falls back to String() for other value types', () => {
    expect(describeError(42)).toBe('42');
  });
});
