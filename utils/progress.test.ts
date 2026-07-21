import { describe, expect, it } from 'vitest';
import {
  computeFetchStats,
  formatBytes,
  formatEta,
  formatSpeed,
} from './progress';

describe('computeFetchStats', () => {
  it('computes %, speed, ETA from segment count', () => {
    // 10/40 segments, 5 MB in 5 seconds -> 1 MB/s; 30 segments remaining, 2 seg/s -> 15s
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

  it('elapsed=0 -> ETA null (avoids divide by 0), speed 0', () => {
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

  it('segmentsTotal=0 -> pct 0, ETA null (no crash)', () => {
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
  it('null -> estimating string', () => {
    expect(formatEta(null)).toBe('đang ước lượng…');
  });
  it('seconds < 60', () => {
    expect(formatEta(45)).toBe('~45 giây');
  });
  it('minutes + seconds', () => {
    expect(formatEta(80)).toBe('~1 phút 20 giây');
  });
  it('exact minutes', () => {
    expect(formatEta(120)).toBe('~2 phút');
  });
  it('0 seconds -> almost done', () => {
    expect(formatEta(0)).toBe('sắp xong');
  });
});

describe('formatSpeed', () => {
  it('MB/s', () => {
    expect(formatSpeed(1024 * 1024)).toBe('1.0 MB/s');
  });
  it('0 -> empty-ish string', () => {
    expect(formatSpeed(0)).toBe('0 B/s');
  });
});

describe('formatBytes', () => {
  it('MB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
  });
});
