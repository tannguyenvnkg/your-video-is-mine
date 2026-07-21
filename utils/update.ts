// Checks for new releases on GitHub Releases.
// The extension is published via GitHub Releases (.zip, load unpacked) rather than through the
// Web Store -> it cannot auto-update. This only NOTIFIES the user + opens the Release page for a
// manual download.
//
// Constraint: GitHub limits unauthenticated API calls to 60 requests/hour/IP
// -> always go through the TTL cache in storage.local, never call on every popup open.

import {
  getUpdateCheck,
  setUpdateCheck,
  UPDATE_CHECK_TTL_MS,
  type UpdateCheck,
} from './storage';

const LATEST_RELEASE_API =
  'https://api.github.com/repos/tannguyenvnkg/your-video-is-mine/releases/latest';

const FETCH_TIMEOUT_MS = 8000;

/**
 * Is the cache still fresh? Kept pure for unit testing.
 * If the machine clock runs backward (checkedAt > now) -> treat it as expired and check again.
 */
export function isCacheFresh(
  checkedAt: number,
  now: number,
  ttlMs: number = UPDATE_CHECK_TTL_MS,
): boolean {
  const age = now - checkedAt;
  return age >= 0 && age < ttlMs;
}

/**
 * Sanitizes JSON from GitHub — network data, not trusted. Only accepts a valid tag + release link.
 * Kept pure for unit testing.
 */
export function parseLatestRelease(
  data: unknown,
): Omit<UpdateCheck, 'checkedAt'> | null {
  if (!data || typeof data !== 'object') return null;
  const o = data as { tag_name?: unknown; html_url?: unknown };
  if (typeof o.tag_name !== 'string' || typeof o.html_url !== 'string') {
    return null;
  }
  if (o.tag_name === '') return null;
  // The link will be opened with tabs.create -> block javascript:/data: by matching the github.com prefix.
  if (!o.html_url.startsWith('https://github.com/')) return null;
  return { latestTag: o.tag_name, releaseUrl: o.html_url };
}

/**
 * Fetches the latest release: uses the cache if still fresh, otherwise calls the API and caches the result.
 * Any error (network, timeout, 403 rate-limit, bad JSON) -> returns the stale cache if present, else null.
 * Does NOT throw and does NOT surface an error in the UI: this is a secondary feature and must not be intrusive.
 */
export async function fetchLatestRelease(
  now: number = Date.now(),
): Promise<UpdateCheck | null> {
  const cached = await getUpdateCheck();
  if (cached && isCacheFresh(cached.checkedAt, now)) return cached;

  try {
    const res = await fetch(LATEST_RELEASE_API, {
      // Does NOT send github.com cookies to the API (unlike the media fetch which uses credentials: 'include').
      credentials: 'omit',
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return cached;
    const parsed = parseLatestRelease(await res.json());
    if (!parsed) return cached;
    const fresh: UpdateCheck = { ...parsed, checkedAt: now };
    await setUpdateCheck(fresh);
    return fresh;
  } catch {
    return cached;
  }
}
