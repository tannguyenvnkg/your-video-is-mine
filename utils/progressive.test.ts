import { describe, expect, it } from 'vitest';
import {
  MAX_PROGRESSIVE_BYTES,
  parseContentRangeTotal,
  planRangeChunks,
  tooLargeMessage,
} from './progressive';

// W2.5 — logic thuần cho đường tải progressive qua offscreen (fetch theo Range để bó RAM cho file
// lớn). Tách khỏi offscreen để unit-test được (offscreen không chạy trong vitest).

describe('planRangeChunks — chia [0, total-1] thành các đoạn Range đóng hai đầu', () => {
  it('chia đều khi total chia hết chunkSize', () => {
    expect(planRangeChunks(8, 4)).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
  });

  it('đoạn cuối ngắn hơn khi total KHÔNG chia hết', () => {
    expect(planRangeChunks(10, 4)).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 9 },
    ]);
  });

  it('total nhỏ hơn chunkSize -> một đoạn phủ trọn', () => {
    expect(planRangeChunks(3, 4)).toEqual([{ start: 0, end: 2 }]);
  });

  it('total = 0 -> không đoạn nào (file rỗng)', () => {
    expect(planRangeChunks(0, 4)).toEqual([]);
  });

  it('total âm/không hợp lệ -> rỗng, không ném', () => {
    expect(planRangeChunks(-5, 4)).toEqual([]);
  });

  it('chunkSize <= 0 -> coi như một đoạn duy nhất (không chia 0/vòng lặp vô hạn)', () => {
    expect(planRangeChunks(10, 0)).toEqual([{ start: 0, end: 9 }]);
  });

  it('các đoạn liền mạch, không chồng lấn, phủ trọn total', () => {
    const chunks = planRangeChunks(1000, 256);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks[chunks.length - 1]!.end).toBe(999);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.start).toBe(chunks[i - 1]!.end + 1);
    }
    const bytes = chunks.reduce((s, c) => s + (c.end - c.start + 1), 0);
    expect(bytes).toBe(1000);
  });
});

describe('parseContentRangeTotal — đọc tổng byte từ header Content-Range', () => {
  it('bytes 0-0/12345 -> 12345', () => {
    expect(parseContentRangeTotal('bytes 0-0/12345')).toBe(12345);
  });

  it('bytes 0-99/12345 -> 12345', () => {
    expect(parseContentRangeTotal('bytes 0-99/12345')).toBe(12345);
  });

  it('bytes */12345 (dạng 416) -> 12345', () => {
    expect(parseContentRangeTotal('bytes */12345')).toBe(12345);
  });

  it('tổng KHÔNG biết (dấu *) -> null', () => {
    expect(parseContentRangeTotal('bytes 0-0/*')).toBeNull();
  });

  it('thiếu/không hợp lệ -> null', () => {
    expect(parseContentRangeTotal(undefined)).toBeNull();
    expect(parseContentRangeTotal(null)).toBeNull();
    expect(parseContentRangeTotal('rác')).toBeNull();
    expect(parseContentRangeTotal('')).toBeNull();
  });
});

describe('trần progressive — file quá lớn báo lỗi rõ (không để offscreen OOM câm)', () => {
  it('trần 2 GiB', () => {
    expect(MAX_PROGRESSIVE_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });
  it('tooLargeMessage nêu cả kích thước lẫn giới hạn', () => {
    const msg = tooLargeMessage(3 * 1024 * 1024 * 1024);
    expect(msg).toContain('3.0 GB');
    expect(msg).toContain('2.0 GB');
  });
});
