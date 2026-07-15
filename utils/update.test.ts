import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { fetchLatestRelease, isCacheFresh, parseLatestRelease } from './update';
import {
  getUpdateCheck,
  setUpdateCheck,
  UPDATE_CHECK_TTL_MS,
  type UpdateCheck,
} from './storage';

const RELEASE_URL =
  'https://github.com/tannguyenvnkg/your-video-is-mine/releases/tag/v0.6.0';

const NOW = 1_700_000_000_000;

/** Giả response của fetch (chỉ 2 field mà code dùng tới). */
function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

describe('isCacheFresh', () => {
  it('vừa kiểm tra xong -> còn hạn', () => {
    expect(isCacheFresh(NOW, NOW)).toBe(true);
  });

  it('trong TTL -> còn hạn', () => {
    expect(isCacheFresh(NOW - UPDATE_CHECK_TTL_MS + 1000, NOW)).toBe(true);
  });

  it('đúng bằng TTL -> hết hạn', () => {
    expect(isCacheFresh(NOW - UPDATE_CHECK_TTL_MS, NOW)).toBe(false);
  });

  it('quá TTL -> hết hạn', () => {
    expect(isCacheFresh(NOW - UPDATE_CHECK_TTL_MS - 1, NOW)).toBe(false);
  });

  it('đồng hồ chạy lùi (checkedAt ở tương lai) -> coi như hết hạn', () => {
    expect(isCacheFresh(NOW + 60_000, NOW)).toBe(false);
  });
});

describe('parseLatestRelease', () => {
  it('nhận tag + link release hợp lệ', () => {
    expect(
      parseLatestRelease({ tag_name: 'v0.6.0', html_url: RELEASE_URL }),
    ).toEqual({ latestTag: 'v0.6.0', releaseUrl: RELEASE_URL });
  });

  it('bỏ qua field thừa của GitHub', () => {
    const parsed = parseLatestRelease({
      tag_name: 'v0.6.0',
      html_url: RELEASE_URL,
      body: 'changelog',
      assets: [{ size: 123 }],
    });
    expect(parsed).toEqual({ latestTag: 'v0.6.0', releaseUrl: RELEASE_URL });
  });

  it('trả null khi thiếu/sai kiểu field', () => {
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease('v0.6.0')).toBeNull();
    expect(parseLatestRelease({})).toBeNull();
    expect(parseLatestRelease({ tag_name: 'v0.6.0' })).toBeNull();
    expect(parseLatestRelease({ html_url: RELEASE_URL })).toBeNull();
    expect(
      parseLatestRelease({ tag_name: 1, html_url: RELEASE_URL }),
    ).toBeNull();
    expect(parseLatestRelease({ tag_name: 'v0.6.0', html_url: 5 })).toBeNull();
  });

  it('trả null khi tag rỗng', () => {
    expect(
      parseLatestRelease({ tag_name: '', html_url: RELEASE_URL }),
    ).toBeNull();
  });

  it('từ chối link không phải github.com (sẽ mở bằng tabs.create)', () => {
    for (const url of [
      'javascript:alert(1)',
      'http://github.com/x/y/releases',
      'https://evil.com/x',
      'https://github.evil.com/x',
    ]) {
      expect(
        parseLatestRelease({ tag_name: 'v0.6.0', html_url: url }),
        url,
      ).toBeNull();
    }
  });
});

describe('fetchLatestRelease', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fakeBrowser.reset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cache còn hạn -> KHÔNG gọi API (tránh rate limit 60 req/giờ)', async () => {
    const cached: UpdateCheck = {
      latestTag: 'v0.6.0',
      releaseUrl: RELEASE_URL,
      checkedAt: NOW - 1000,
    };
    await setUpdateCheck(cached);

    expect(await fetchLatestRelease(NOW)).toEqual(cached);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('chưa có cache -> gọi API và lưu lại kèm checkedAt', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ tag_name: 'v0.6.0', html_url: RELEASE_URL }),
    );

    expect(await fetchLatestRelease(NOW)).toEqual({
      latestTag: 'v0.6.0',
      releaseUrl: RELEASE_URL,
      checkedAt: NOW,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Đã ghi cache -> lần sau đọc lại được.
    expect(await getUpdateCheck()).toEqual({
      latestTag: 'v0.6.0',
      releaseUrl: RELEASE_URL,
      checkedAt: NOW,
    });
  });

  it('không gửi cookie github.com, có header Accept của GitHub API', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ tag_name: 'v0.6.0', html_url: RELEASE_URL }),
    );
    await fetchLatestRelease(NOW);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api.github.com');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual({ Accept: 'application/vnd.github+json' });
  });

  it('cache hết hạn -> gọi lại API và cập nhật', async () => {
    await setUpdateCheck({
      latestTag: 'v0.5.0',
      releaseUrl: RELEASE_URL,
      checkedAt: NOW - UPDATE_CHECK_TTL_MS - 1,
    });
    fetchMock.mockResolvedValue(
      jsonResponse({ tag_name: 'v0.7.0', html_url: RELEASE_URL }),
    );

    expect((await fetchLatestRelease(NOW))?.latestTag).toBe('v0.7.0');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('API lỗi mạng -> giữ cache cũ, KHÔNG ném lỗi', async () => {
    const stale: UpdateCheck = {
      latestTag: 'v0.5.0',
      releaseUrl: RELEASE_URL,
      checkedAt: NOW - UPDATE_CHECK_TTL_MS - 1,
    };
    await setUpdateCheck(stale);
    fetchMock.mockRejectedValue(new Error('network down'));

    expect(await fetchLatestRelease(NOW)).toEqual(stale);
    // Cache cũ KHÔNG bị ghi đè -> lần mở popup sau vẫn thử lại.
    expect(await getUpdateCheck()).toEqual(stale);
  });

  it('API trả 403 (hết quota) -> giữ cache cũ', async () => {
    const stale: UpdateCheck = {
      latestTag: 'v0.5.0',
      releaseUrl: RELEASE_URL,
      checkedAt: NOW - UPDATE_CHECK_TTL_MS - 1,
    };
    await setUpdateCheck(stale);
    fetchMock.mockResolvedValue(
      jsonResponse({ message: 'rate limited' }, false),
    );

    expect(await fetchLatestRelease(NOW)).toEqual(stale);
  });

  it('JSON sai dạng -> giữ cache cũ, không ghi rác', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ foo: 'bar' }));

    expect(await fetchLatestRelease(NOW)).toBeNull();
    expect(await getUpdateCheck()).toBeNull();
  });

  it('chưa có cache + API lỗi -> null (không banner)', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    expect(await fetchLatestRelease(NOW)).toBeNull();
  });

  it('cache trong storage bị hỏng -> coi như chưa có, gọi lại API', async () => {
    await browser.storage.local.set({
      'settings:updateCheck': { latestTag: 5 },
    });
    fetchMock.mockResolvedValue(
      jsonResponse({ tag_name: 'v0.6.0', html_url: RELEASE_URL }),
    );

    expect((await fetchLatestRelease(NOW))?.latestTag).toBe('v0.6.0');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
