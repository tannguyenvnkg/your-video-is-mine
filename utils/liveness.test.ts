import { describe, expect, it, vi } from 'vitest';
import type { DownloadEntry, HlsJob } from './storage';
import {
  DEAD_OFFSCREEN_ERROR,
  HEARTBEAT_TIMEOUT_MS,
  findDeadDownloads,
  findDeadHlsJobs,
  isActiveHlsPhase,
  singleFlight,
} from './liveness';

// W2.7 — §2.14: hôm nay offscreen chết giữa chừng thì job nằm lại ở 'fetching' VĨNH VIỄN và popup
// quay spinner không lời giải thích. Mỗi test dưới đây ĐỎ trên code trước W2.7 (chưa có file này).

/** Job tối thiểu — chỉ những field liveness đụng tới. */
function job(id: string, patch: Partial<HlsJob> = {}): HlsJob {
  return {
    id,
    mediaUrl: `https://x/${id}.m3u8`,
    variantUrl: `https://x/${id}-v.m3u8`,
    phase: 'fetching',
    segmentsTotal: 10,
    segmentsDone: 3,
    ...patch,
  };
}

describe('isActiveHlsPhase', () => {
  it('phase đang chạy = còn sống, phải có nhịp tim', () => {
    for (const p of ['queued', 'loading', 'fetching', 'muxing', 'saving'] as const)
      expect(isActiveHlsPhase(p)).toBe(true);
  });

  it('phase kết thúc = KHÔNG theo dõi nữa (job xong rồi, im là đúng)', () => {
    for (const p of ['done', 'error', 'cancelled'] as const)
      expect(isActiveHlsPhase(p)).toBe(false);
  });
});

describe('findDeadHlsJobs', () => {
  const NOW = 1_000_000;

  it('job đang chạy mà im quá ngưỡng -> CHẾT (đây là lỗi §2.14 cần bắt)', () => {
    const jobs = {
      a: job('a', { lastSeenAt: NOW - HEARTBEAT_TIMEOUT_MS - 1 }),
    };
    expect(findDeadHlsJobs(jobs, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual(['a']);
  });

  it('job vừa báo nhịp tim -> còn sống, KHÔNG giết oan', () => {
    const jobs = { a: job('a', { lastSeenAt: NOW - 1_000 }) };
    expect(findDeadHlsJobs(jobs, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual([]);
  });

  it('job ĐÃ kết thúc thì im bao lâu cũng mặc kệ', () => {
    const jobs = {
      d: job('d', { phase: 'done', lastSeenAt: NOW - 10 * HEARTBEAT_TIMEOUT_MS }),
      e: job('e', { phase: 'error', lastSeenAt: NOW - 10 * HEARTBEAT_TIMEOUT_MS }),
      c: job('c', {
        phase: 'cancelled',
        lastSeenAt: NOW - 10 * HEARTBEAT_TIMEOUT_MS,
      }),
    };
    expect(findDeadHlsJobs(jobs, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual([]);
  });

  it('ĐÚNG ngưỡng thì CHƯA chết — chỉ vượt hẳn mới tính (tránh giết oan lúc giật nhẹ)', () => {
    const jobs = { a: job('a', { lastSeenAt: NOW - HEARTBEAT_TIMEOUT_MS }) };
    expect(findDeadHlsJobs(jobs, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual([]);
  });

  it('job KHÔNG có lastSeenAt (tạo trước bản nâng cấp) -> KHÔNG giết oan', () => {
    const jobs = { a: job('a', { lastSeenAt: undefined }) };
    expect(findDeadHlsJobs(jobs, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual([]);
  });

  it('lọc đúng job chết trong đám đông, giữ nguyên job khoẻ', () => {
    const jobs = {
      alive: job('alive', { lastSeenAt: NOW - 5_000 }),
      dead1: job('dead1', { lastSeenAt: NOW - HEARTBEAT_TIMEOUT_MS - 5_000 }),
      finished: job('finished', { phase: 'done', lastSeenAt: NOW - 999_999 }),
      dead2: job('dead2', {
        phase: 'muxing',
        lastSeenAt: NOW - HEARTBEAT_TIMEOUT_MS - 1,
      }),
    };
    expect(findDeadHlsJobs(jobs, NOW, HEARTBEAT_TIMEOUT_MS).sort()).toEqual([
      'dead1',
      'dead2',
    ]);
  });

  it('thông báo chết phải NÓI RÕ LÝ DO cho người dùng, không phải mã lỗi trần', () => {
    // Spinner đứng im không lời giải thích là kết cục tệ nhất của một app tải.
    expect(DEAD_OFFSCREEN_ERROR.length).toBeGreaterThan(20);
    expect(DEAD_OFFSCREEN_ERROR).toMatch(/dừng|chết|thoát/i);
  });
});

describe('findDeadDownloads (W2.5 khiến progressive cũng phụ thuộc offscreen)', () => {
  const NOW = 1_000_000;

  function entry(key: string, patch: Partial<DownloadEntry> = {}): DownloadEntry {
    return {
      key,
      mediaUrl: `https://x/${key}.mp4`,
      state: 'in_progress',
      ...patch,
    };
  }

  it('đang FETCH trong offscreen mà im quá ngưỡng -> CHẾT', () => {
    const d = { a: entry('a', { lastSeenAt: NOW - HEARTBEAT_TIMEOUT_MS - 1 }) };
    expect(findDeadDownloads(d, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual(['a']);
  });

  it('ĐÃ có chromeDownloadId -> chrome.downloads cầm lái, im là BÌNH THƯỜNG, không giết oan', () => {
    // Đây là nửa dễ sai nhất: lượt LƯU không còn phụ thuộc offscreen nữa.
    const d = {
      a: entry('a', {
        chromeDownloadId: 42,
        lastSeenAt: NOW - 10 * HEARTBEAT_TIMEOUT_MS,
      }),
    };
    expect(findDeadDownloads(d, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual([]);
  });

  it('state đã kết thúc -> mặc kệ', () => {
    const d = {
      c: entry('c', { state: 'complete', lastSeenAt: NOW - 999_999 }),
      i: entry('i', { state: 'interrupted', lastSeenAt: NOW - 999_999 }),
    };
    expect(findDeadDownloads(d, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual([]);
  });

  it('vừa báo nhịp tim -> còn sống', () => {
    const d = { a: entry('a', { lastSeenAt: NOW - 1_000 }) };
    expect(findDeadDownloads(d, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual([]);
  });

  it('thiếu lastSeenAt (entry cũ) -> KHÔNG giết oan', () => {
    const d = { a: entry('a', { lastSeenAt: undefined }) };
    expect(findDeadDownloads(d, NOW, HEARTBEAT_TIMEOUT_MS)).toEqual([]);
  });
});

describe('singleFlight', () => {
  it('hai lời gọi CÙNG LÚC chỉ chạy hàm MỘT lần (diệt race tạo 2 offscreen)', async () => {
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 'ok';
    });
    const wrapped = singleFlight(fn);
    const [a, b] = await Promise.all([wrapped(), wrapped()]);
    expect(a).toBe('ok');
    expect(b).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gọi lại SAU khi xong thì chạy lại — offscreen có thể đã chết từ lần trước', async () => {
    const fn = vi.fn(async () => 'ok');
    const wrapped = singleFlight(fn);
    await wrapped();
    await wrapped();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('hàm ném -> mọi caller cùng lượt đều nhận lỗi (KHÔNG ai tưởng thành công)', async () => {
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('tạo hỏng');
    });
    const wrapped = singleFlight(fn);
    const results = await Promise.allSettled([wrapped(), wrapped()]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('sau khi ném thì lượt SAU được thử lại (không kẹt promise hỏng vĩnh viễn)', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error('hỏng lần đầu');
      return 'ok';
    });
    const wrapped = singleFlight(fn);
    await expect(wrapped()).rejects.toThrow('hỏng lần đầu');
    await expect(wrapped()).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
