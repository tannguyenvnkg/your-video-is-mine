import { describe, expect, it } from 'vitest';
import {
  computeFetchStats,
  formatBytes,
  formatEta,
  formatSpeed,
} from './progress';

describe('computeFetchStats', () => {
  it('tính %, tốc độ, ETA theo số segment', () => {
    // 10/40 segment, 5 MB trong 5 giây -> 1 MB/s; còn 30 segment, tốc độ 2 seg/s -> 15s
    const s = computeFetchStats({
      segmentsDone: 10,
      segmentsTotal: 40,
      bytesDownloaded: 5 * 1024 * 1024,
      startedAt: 1_000,
      now: 6_000,
    });
    expect(s.pct).toBe(25);
    expect(Math.round(s.speedBytesPerSec)).toBe(1024 * 1024);
    expect(s.etaSec).toBe(15);
  });

  it('done=0 -> ETA null, pct 0, speed 0', () => {
    const s = computeFetchStats({
      segmentsDone: 0,
      segmentsTotal: 40,
      bytesDownloaded: 0,
      startedAt: 1_000,
      now: 3_000,
    });
    expect(s.pct).toBe(0);
    expect(s.etaSec).toBeNull();
    expect(s.speedBytesPerSec).toBe(0);
  });

  it('done=total -> pct 100, ETA 0', () => {
    const s = computeFetchStats({
      segmentsDone: 40,
      segmentsTotal: 40,
      bytesDownloaded: 100,
      startedAt: 1_000,
      now: 5_000,
    });
    expect(s.pct).toBe(100);
    expect(s.etaSec).toBe(0);
  });

  it('elapsed=0 -> ETA null (tránh chia 0), speed 0', () => {
    const s = computeFetchStats({
      segmentsDone: 3,
      segmentsTotal: 40,
      bytesDownloaded: 10,
      startedAt: 5_000,
      now: 5_000,
    });
    expect(s.etaSec).toBeNull();
    expect(s.speedBytesPerSec).toBe(0);
  });

  it('segmentsTotal=0 -> pct 0, ETA null (không crash)', () => {
    const s = computeFetchStats({
      segmentsDone: 0,
      segmentsTotal: 0,
      bytesDownloaded: 0,
      startedAt: 1_000,
      now: 2_000,
    });
    expect(s.pct).toBe(0);
    expect(s.etaSec).toBeNull();
  });
});

describe('formatEta', () => {
  it('null -> chuỗi ước lượng', () => {
    expect(formatEta(null)).toBe('đang ước lượng…');
  });
  it('giây < 60', () => {
    expect(formatEta(45)).toBe('~45 giây');
  });
  it('phút + giây', () => {
    expect(formatEta(80)).toBe('~1 phút 20 giây');
  });
  it('tròn phút', () => {
    expect(formatEta(120)).toBe('~2 phút');
  });
  it('0 giây -> sắp xong', () => {
    expect(formatEta(0)).toBe('sắp xong');
  });
});

describe('formatSpeed', () => {
  it('MB/s', () => {
    expect(formatSpeed(1024 * 1024)).toBe('1.0 MB/s');
  });
  it('0 -> chuỗi rỗng-ish', () => {
    expect(formatSpeed(0)).toBe('0 B/s');
  });
});

describe('formatBytes', () => {
  it('MB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
  });
});
