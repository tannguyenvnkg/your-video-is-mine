import { describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_MAX_MS,
  CancelledError,
  FatalFetchError,
  backoffDelayMs,
  fetchWithRetry,
  isFatalHttpStatus,
  linkSignals,
} from './retry';

// W2.6 — 4 thuộc tính mà §2.9 nói vòng retry cũ KHÔNG có. Mỗi describe dưới đây ĐỎ trên code
// trước W2.6 (đã đo bằng cách chạy chính bộ test này với vòng lặp cũ — xem §2b).

/** Response giả tối thiểu — chỉ những field fetchWithRetry đụng tới. */
function res(status: number, body = new ArrayBuffer(8)): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: () => Promise.resolve(body),
  } as unknown as Response;
}

/** fetch giả TREO — nhưng tôn trọng signal y như fetch thật (reject khi bị abort). */
function hangingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const s = init?.signal;
      if (!s) return; // không có signal -> treo VĨNH VIỄN, đúng hành vi code cũ
      if (s.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      s.addEventListener(
        'abort',
        () =>
          reject(
            (s as AbortSignal).reason ??
              new DOMException('aborted', 'AbortError'),
          ),
        { once: true },
      );
    })) as unknown as typeof fetch;
}

describe('W2.6 (1) timeout mỗi lượt thử', () => {
  it('server treo -> ném lỗi, KHÔNG treo vĩnh viễn', async () => {
    // Code cũ: fetch không có signal -> promise này không bao giờ settle -> job kẹt 'fetching'
    // mãi mãi, không lỗi, không huỷ nổi (§2.9 hậu quả 1).
    await expect(
      fetchWithRetry('http://x/seg.ts', {
        fetchFn: hangingFetch(),
        timeoutMs: 20,
        retries: 1,
        sleepFn: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/lần thử/);
  }, 2_000);

  it('thông báo lỗi nói rõ là quá hạn, không phải chuỗi rỗng', async () => {
    const err = await fetchWithRetry('http://x/seg.ts', {
      fetchFn: hangingFetch(),
      timeoutMs: 20,
      retries: 0,
      sleepFn: () => Promise.resolve(),
    }).catch((e: unknown) => e);
    expect(String((err as Error).message)).toMatch(/quá hạn|không phản hồi/);
  }, 2_000);
});

/**
 * Response giả có body chảy theo nhịp: `gaps` là khoảng im lặng (ms) TRƯỚC mỗi mảnh byte.
 * Tôn trọng signal — bị abort thì reader ném, y như fetch thật.
 */
function streamingFetch(gaps: number[]): typeof fetch {
  return ((_url: string, init?: RequestInit) => {
    const s = init?.signal;
    let i = 0;
    const body = {
      getReader: () => ({
        read: () =>
          new Promise<{ done: boolean; value?: Uint8Array }>(
            (resolve, reject) => {
              if (i >= gaps.length) {
                resolve({ done: true });
                return;
              }
              const gap = gaps[i]!;
              i++;
              const t = setTimeout(
                () => resolve({ done: false, value: new Uint8Array(4) }),
                gap,
              );
              s?.addEventListener(
                'abort',
                () => {
                  clearTimeout(t);
                  reject(s.reason ?? new DOMException('aborted', 'AbortError'));
                },
                { once: true },
              );
            },
          ),
      }),
    };
    return Promise.resolve({
      ok: true,
      status: 200,
      body,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

describe('W2.6 (1b) timeout theo IM LẶNG, không theo tổng thời gian', () => {
  it('server trả header rồi câm giữa chừng -> ngắt, không treo', async () => {
    // 3 mảnh về nhanh rồi im lặng vĩnh viễn (gap 10_000 > stallMs).
    await expect(
      fetchWithRetry('http://x/seg.ts', {
        fetchFn: streamingFetch([1, 1, 1, 10_000]),
        stallMs: 30,
        retries: 1,
        sleepFn: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/lần thử/);
  }, 3_000);

  it('🔴 KHÔNG cắt oan tải CHẬM mà đang chảy đều', async () => {
    // Bài học W2.5: trần theo TỔNG thời gian giết đúng người dùng mạng yếu. Ở đây tổng thời gian
    // (10 mảnh x 20ms = 200ms) VƯỢT XA stallMs (50ms) — nhưng không mảnh nào im quá 50ms nên
    // request phải sống. Bản sửa nào dùng AbortSignal.timeout thuần sẽ ĐỎ ở đây.
    const out = await fetchWithRetry('http://x/seg.ts', {
      fetchFn: streamingFetch(Array.from({ length: 10 }, () => 20)),
      stallMs: 50,
      timeoutMs: 50,
      retries: 0,
    });
    expect(out.byteLength).toBe(40);
  }, 3_000);
});

describe('W2.6 (2) huỷ giật request đang bay ra NGAY', () => {
  it('abort giữa lúc fetch đang treo -> reject CancelledError, không chờ hết retry', async () => {
    const ac = new AbortController();
    const p = fetchWithRetry('http://x/seg.ts', {
      fetchFn: hangingFetch(),
      signal: ac.signal,
      timeoutMs: 60_000, // timeout dài: nếu không nghe signal thì test sẽ hết giờ
      retries: 3,
    });
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
  }, 2_000);

  it('signal đã abort từ trước -> không gọi fetch lần nào', async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchFn = vi.fn(() => Promise.resolve(res(200)));
    await expect(
      fetchWithRetry('http://x/seg.ts', {
        signal: ac.signal,
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('huỷ trong lúc đang backoff -> dừng ngay, không ngồi hết 8 giây', async () => {
    const ac = new AbortController();
    const fetchFn = vi.fn(() => Promise.resolve(res(500)));
    const p = fetchWithRetry('http://x/seg.ts', {
      fetchFn: fetchFn as unknown as typeof fetch,
      signal: ac.signal,
      retries: 5,
    });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    // Chưa kịp đốt hết 6 lượt: backoff thật (500ms+) chặn lại.
    expect(fetchFn.mock.calls.length).toBeLessThan(4);
  }, 3_000);
});

describe('W2.6 (3) fail-fast mã HTTP không cứu được', () => {
  it.each([401, 403, 404, 410, 416])(
    'HTTP %i -> thử ĐÚNG 1 lần rồi bỏ (URL ký hết hạn không bao giờ hồi phục)',
    async (status) => {
      const fetchFn = vi.fn(() => Promise.resolve(res(status)));
      await expect(
        fetchWithRetry('http://x/seg.ts', {
          fetchFn: fetchFn as unknown as typeof fetch,
          sleepFn: () => Promise.resolve(),
        }),
      ).rejects.toBeInstanceOf(FatalFetchError);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it('HTTP 500/429 thì VẪN thử lại (lỗi tạm thời)', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(res(503)));
    await expect(
      fetchWithRetry('http://x/seg.ts', {
        fetchFn: fetchFn as unknown as typeof fetch,
        retries: 2,
        sleepFn: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/3 lần thử/);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('W1.3 không hồi quy: server phớt lờ Range (200 thay vì 206) -> fatal, không thử lại', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(res(200)));
    await expect(
      fetchWithRetry('http://x/main.mp4', {
        range: { offset: 719, length: 274201 },
        fetchFn: fetchFn as unknown as typeof fetch,
        sleepFn: () => Promise.resolve(),
      }),
    ).rejects.toBeInstanceOf(FatalFetchError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('vá review W2.6', () => {
  it('206 NGẮN hơn dải đã xin -> ném lỗi, KHÔNG ghép byte cụt (đối xứng W2.5)', async () => {
    // RFC 7233 cho phép server/proxy trả ít hơn. Nhận bừa = segment thiếu byte, file ghép ra hỏng
    // mà job vẫn báo 'done' — đúng lớp lỗi câm W2.5 vừa phải vá ở đường progressive.
    const short = new ArrayBuffer(100);
    const fetchFn = vi.fn(() => Promise.resolve(res(206, short)));
    await expect(
      fetchWithRetry('http://x/main.mp4', {
        range: { offset: 0, length: 999 },
        fetchFn: fetchFn as unknown as typeof fetch,
        retries: 0,
        sleepFn: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/thiếu byte/);
  });

  it('linkSignals: signal ĐÃ abort từ trước vẫn phải abort ngay (huỷ không được mất tác dụng)', () => {
    const done = new AbortController();
    done.abort();
    const fresh = new AbortController();
    // Nhánh dự phòng cũ dùng addEventListener -> sự kiện đã qua, không bao giờ bắn.
    expect(linkSignals(fresh.signal, done.signal).signal.aborted).toBe(true);
    expect(linkSignals(done.signal, fresh.signal).signal.aborted).toBe(true);
  });

  it('onRetry báo mỗi lần thử lại (để popup không đứng hình câm)', async () => {
    const seen: number[] = [];
    const fetchFn = vi.fn(() => Promise.resolve(res(503)));
    await fetchWithRetry('http://x/seg.ts', {
      fetchFn: fetchFn as unknown as typeof fetch,
      retries: 2,
      sleepFn: () => Promise.resolve(),
      onRetry: (i) => seen.push(i.attempt),
    }).catch(() => undefined);
    expect(seen).toEqual([1, 2]);
  });

  it('403 nay có thông báo NÓI ĐƯỢC cái gì hỏng, không phải "HTTP 403" trơ trọi', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(res(403)));
    const err = await fetchWithRetry('http://x/seg.ts', {
      fetchFn: fetchFn as unknown as typeof fetch,
      label: 'segment #3/10',
      sleepFn: () => Promise.resolve(),
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('segment #3/10');
    expect((err as Error).message).toMatch(/từ chối|hết hạn|chặn/);
  });
});

describe('W2.6 (4) backoff mũ giữa các lượt thử', () => {
  it('chờ 500ms, 1s, 2s — KHÔNG bắn 4 lượt trong vài micro giây', async () => {
    const delays: number[] = [];
    const fetchFn = vi.fn(() => Promise.resolve(res(503)));
    await fetchWithRetry('http://x/seg.ts', {
      fetchFn: fetchFn as unknown as typeof fetch,
      retries: 3,
      sleepFn: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    }).catch(() => undefined);
    // Bắn liên tiếp không nghỉ = trông như tấn công -> CDN nâng từ throttle mềm lên ban IP (§2.9).
    expect(delays).toEqual([500, 1000, 2000]);
  });

  it('backoffDelayMs: lượt đầu không chờ, có TRẦN', () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(1)).toBe(500);
    expect(backoffDelayMs(2)).toBe(1000);
    expect(backoffDelayMs(99)).toBe(BACKOFF_MAX_MS);
  });
});

describe('đường thành công vẫn nguyên vẹn', () => {
  it('200 -> trả bytes, gọi fetch đúng 1 lần', async () => {
    const body = new ArrayBuffer(16);
    const fetchFn = vi.fn(() => Promise.resolve(res(200, body)));
    const out = await fetchWithRetry('http://x/seg.ts', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(out.byteLength).toBe(16);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('lỗi mạng thoáng qua rồi thành công -> trả bytes', async () => {
    let n = 0;
    const fetchFn = vi.fn(() => {
      n++;
      return n === 1
        ? Promise.reject(new TypeError('network error'))
        : Promise.resolve(res(200));
    });
    const out = await fetchWithRetry('http://x/seg.ts', {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: () => Promise.resolve(),
    });
    expect(out.byteLength).toBe(8);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('gửi header Range đúng dạng đóng hai đầu + cache reload', async () => {
    // Body PHẢI đúng độ dài dải đã xin — guard 206-ngắn (vá review) sẽ ném nếu thiếu byte.
    const full = new ArrayBuffer(274201);
    const fetchFn = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(res(206, full)),
    );
    await fetchWithRetry('http://x/main.mp4', {
      range: { offset: 719, length: 274201 },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const init = fetchFn.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).Range).toBe(
      'bytes=719-274919',
    );
    // Một 403 bị cache giữ lại sẽ phát lại y nguyên ở mọi lượt thử -> phải đi thẳng ra mạng.
    expect(init.cache).toBe('reload');
  });
});

describe('isFatalHttpStatus', () => {
  it('phân loại đúng', () => {
    expect(isFatalHttpStatus(403)).toBe(true);
    expect(isFatalHttpStatus(404)).toBe(true);
    expect(isFatalHttpStatus(500)).toBe(false);
    expect(isFatalHttpStatus(429)).toBe(false);
  });
});
