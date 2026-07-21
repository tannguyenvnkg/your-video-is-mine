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

/** Fake fetch response (only the 2 fields the code actually uses). */
function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

describe('isCacheFresh', () => {
  it('just checked -> still fresh', () => {
    expect(isCacheFresh(NOW, NOW)).toBe(true);
  });

  it('within TTL -> still fresh', () => {
    expect(isCacheFresh(NOW - UPDATE_CHECK_TTL_MS + 1000, NOW)).toBe(true);
  });

  it('exactly at TTL -> expired', () => {
    expect(isCacheFresh(NOW - UPDATE_CHECK_TTL_MS, NOW)).toBe(false);
  });

  it('past TTL -> expired', () => {
    expect(isCacheFresh(NOW - UPDATE_CHECK_TTL_MS - 1, NOW)).toBe(false);
  });

  it('clock running backward (checkedAt in the future) -> treated as expired', () => {
    expect(isCacheFresh(NOW + 60_000, NOW)).toBe(false);
  });
});

describe('parseLatestRelease', () => {
  it('accepts a valid tag + release link', () => {
    expect(
      parseLatestRelease({ tag_name: 'v0.6.0', html_url: RELEASE_URL }),
    ).toEqual({ latestTag: 'v0.6.0', releaseUrl: RELEASE_URL });
  });

  it('ignores extra GitHub fields', () => {
    const parsed = parseLatestRelease({
      tag_name: 'v0.6.0',
      html_url: RELEASE_URL,
      body: 'changelog',
      assets: [{ size: 123 }],
    });
    expect(parsed).toEqual({ latestTag: 'v0.6.0', releaseUrl: RELEASE_URL });
  });

  it('returns null when a field is missing/wrong type', () => {
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

  it('returns null when the tag is empty', () => {
    expect(
      parseLatestRelease({ tag_name: '', html_url: RELEASE_URL }),
    ).toBeNull();
  });

  it('rejects a link that is not github.com (will open via tabs.create)', () => {
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

  it('cache still fresh -> does NOT call the API (avoids the 60 req/hour rate limit)', async () => {
    const cached: UpdateCheck = {
      latestTag: 'v0.6.0',
      releaseUrl: RELEASE_URL,
      checkedAt: NOW - 1000,
    };
    await setUpdateCheck(cached);

    expect(await fetchLatestRelease(NOW)).toEqual(cached);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no cache yet -> calls the API and saves it along with checkedAt', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ tag_name: 'v0.6.0', html_url: RELEASE_URL }),
    );

    expect(await fetchLatestRelease(NOW)).toEqual({
      latestTag: 'v0.6.0',
      releaseUrl: RELEASE_URL,
      checkedAt: NOW,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Cache has been written -> readable again next time.
    expect(await getUpdateCheck()).toEqual({
      latestTag: 'v0.6.0',
      releaseUrl: RELEASE_URL,
      checkedAt: NOW,
    });
  });

  it('does not send github.com cookies, includes the GitHub API Accept header', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ tag_name: 'v0.6.0', html_url: RELEASE_URL }),
    );
    await fetchLatestRelease(NOW);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api.github.com');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual({ Accept: 'application/vnd.github+json' });
  });

  it('cache expired -> calls the API again and updates it', async () => {
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

  it('API network error -> keeps the old cache, does NOT throw', async () => {
    const stale: UpdateCheck = {
      latestTag: 'v0.5.0',
      releaseUrl: RELEASE_URL,
      checkedAt: NOW - UPDATE_CHECK_TTL_MS - 1,
    };
    await setUpdateCheck(stale);
    fetchMock.mockRejectedValue(new Error('network down'));

    expect(await fetchLatestRelease(NOW)).toEqual(stale);
    // Old cache is NOT overwritten -> next time the popup opens it will retry.
    expect(await getUpdateCheck()).toEqual(stale);
  });

  it('API returns 403 (quota exhausted) -> keeps the old cache', async () => {
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

  it('malformed JSON -> keeps the old cache, does not write garbage', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ foo: 'bar' }));

    expect(await fetchLatestRelease(NOW)).toBeNull();
    expect(await getUpdateCheck()).toBeNull();
  });

  it('no cache yet + API error -> null (no banner)', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    expect(await fetchLatestRelease(NOW)).toBeNull();
  });

  it('corrupted cache in storage -> treated as none, calls the API again', async () => {
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
