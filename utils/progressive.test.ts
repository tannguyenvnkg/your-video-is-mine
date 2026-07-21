import { describe, expect, it } from 'vitest';
import {
  MAX_PROGRESSIVE_BYTES,
  parseContentRangeTotal,
  planRangeChunks,
  tooLargeMessage,
} from './progressive';

// W2.5 — pure logic for the progressive download path via offscreen (fetch by Range to cap RAM
// for large files). Split out of offscreen so it's unit-testable (offscreen doesn't run in vitest).

describe('planRangeChunks — splits [0, total-1] into closed-interval Range chunks', () => {
  it('splits evenly when total is a multiple of chunkSize', () => {
    expect(planRangeChunks(8, 4)).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
  });

  it('the last chunk is shorter when total is NOT a multiple', () => {
    expect(planRangeChunks(10, 4)).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 9 },
    ]);
  });

  it('total smaller than chunkSize -> a single chunk covering it all', () => {
    expect(planRangeChunks(3, 4)).toEqual([{ start: 0, end: 2 }]);
  });

  it('total = 0 -> no chunks (empty file)', () => {
    expect(planRangeChunks(0, 4)).toEqual([]);
  });

  it('negative/invalid total -> empty, does not throw', () => {
    expect(planRangeChunks(-5, 4)).toEqual([]);
  });

  it('chunkSize <= 0 -> treated as a single chunk (no divide-by-zero/infinite loop)', () => {
    expect(planRangeChunks(10, 0)).toEqual([{ start: 0, end: 9 }]);
  });

  it('chunks are contiguous, non-overlapping, and cover the whole total', () => {
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

describe('parseContentRangeTotal — reads the total byte count from a Content-Range header', () => {
  it('bytes 0-0/12345 -> 12345', () => {
    expect(parseContentRangeTotal('bytes 0-0/12345')).toBe(12345);
  });

  it('bytes 0-99/12345 -> 12345', () => {
    expect(parseContentRangeTotal('bytes 0-99/12345')).toBe(12345);
  });

  it('bytes */12345 (the 416 form) -> 12345', () => {
    expect(parseContentRangeTotal('bytes */12345')).toBe(12345);
  });

  it('UNKNOWN total (a * marker) -> null', () => {
    expect(parseContentRangeTotal('bytes 0-0/*')).toBeNull();
  });

  it('missing/invalid -> null', () => {
    expect(parseContentRangeTotal(undefined)).toBeNull();
    expect(parseContentRangeTotal(null)).toBeNull();
    expect(parseContentRangeTotal('rác')).toBeNull();
    expect(parseContentRangeTotal('')).toBeNull();
  });
});

describe('progressive size cap — a too-large file gets a clear error (no silent offscreen OOM)', () => {
  it('the 2 GiB cap', () => {
    expect(MAX_PROGRESSIVE_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });
  it('tooLargeMessage states both the size and the limit', () => {
    const msg = tooLargeMessage(3 * 1024 * 1024 * 1024);
    expect(msg).toContain('3.0 GB');
    expect(msg).toContain('2.0 GB');
  });
});
