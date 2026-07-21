import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  formatVersionLabel,
  isUpdateAvailable,
  parseVersion,
} from './version';

describe('formatVersionLabel', () => {
  it('joins into "<name> v<version>"', () => {
    expect(formatVersionLabel('Your Video Is Mine', '0.1.0')).toBe(
      'Your Video Is Mine v0.1.0',
    );
  });
});

describe('parseVersion', () => {
  it('parses the standard format', () => {
    expect(parseVersion('0.5.0')).toEqual({
      major: 0,
      minor: 5,
      patch: 0,
      prerelease: [],
    });
  });

  it('strips the "v" prefix of a GitHub tag', () => {
    expect(parseVersion('v1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
  });

  it('splits prerelease into individual identifiers', () => {
    expect(parseVersion('1.0.0-rc.1')?.prerelease).toEqual(['rc', '1']);
  });

  it('ignores build metadata', () => {
    expect(parseVersion('1.0.0+build.5')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: [],
    });
  });

  it('trims extra whitespace', () => {
    expect(parseVersion('  v2.0.0 \n')?.major).toBe(2);
  });

  it('returns null on invalid format', () => {
    for (const bad of ['', 'v', '1.2', 'abc', '1.2.3.4', 'v1.2.x', '-1.0.0']) {
      expect(parseVersion(bad), bad).toBeNull();
    }
  });
});

// Compact helper for the comparison cases below.
function cmp(a: string, b: string): number {
  return compareVersions(parseVersion(a)!, parseVersion(b)!);
}

describe('compareVersions', () => {
  it('compares by NUMBER not by string (0.10.0 > 0.9.0)', () => {
    expect(cmp('0.10.0', '0.9.0')).toBe(1);
    expect(cmp('0.9.0', '0.10.0')).toBe(-1);
    // Classic string-comparison trap: '0.10.0' < '0.9.0' in lexicographic order.
    expect('0.10.0' < '0.9.0').toBe(true);
  });

  it('compares major then minor then patch', () => {
    expect(cmp('1.0.0', '0.99.99')).toBe(1);
    expect(cmp('1.2.0', '1.1.99')).toBe(1);
    expect(cmp('1.1.2', '1.1.1')).toBe(1);
  });

  it('equal returns 0, the v prefix has no effect', () => {
    expect(cmp('1.2.3', '1.2.3')).toBe(0);
    expect(cmp('v1.2.3', '1.2.3')).toBe(0);
  });

  it('prerelease is SMALLER than the release version with the same numbers', () => {
    expect(cmp('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(cmp('1.0.0', '1.0.0-rc.1')).toBe(1);
  });

  it('prerelease comparison: numeric by number, numeric < alpha, fewer identifiers < more', () => {
    expect(cmp('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1); // 2 < 10 numerically
    expect(cmp('1.0.0-1', '1.0.0-alpha')).toBe(-1); // numeric < alphanumeric
    expect(cmp('1.0.0-rc', '1.0.0-rc.1')).toBe(-1); // fewer identifiers
    expect(cmp('1.0.0-alpha', '1.0.0-beta')).toBe(-1); // ASCII
  });

  it('the §11 sample SemVer strings sort in ascending order', () => {
    const order = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 0; i < order.length - 1; i++) {
      expect(
        cmp(order[i]!, order[i + 1]!),
        `${order[i]} < ${order[i + 1]}`,
      ).toBe(-1);
    }
  });
});

describe('isUpdateAvailable', () => {
  it('newer tag -> true', () => {
    expect(isUpdateAvailable('v0.6.0', '0.5.0')).toBe(true);
    expect(isUpdateAvailable('v0.10.0', '0.9.0')).toBe(true);
  });

  it('equal or older -> false', () => {
    expect(isUpdateAvailable('v0.5.0', '0.5.0')).toBe(false);
    expect(isUpdateAvailable('v0.4.1', '0.5.0')).toBe(false);
  });

  it('when the installed version is a prerelease, the release with the same numbers is newer', () => {
    expect(isUpdateAvailable('v1.0.0', '1.0.0-rc.1')).toBe(true);
    expect(isUpdateAvailable('v1.0.0-rc.1', '1.0.0')).toBe(false);
  });

  it('invalid format -> false (better not to report than to report wrong)', () => {
    expect(isUpdateAvailable('latest', '0.5.0')).toBe(false);
    expect(isUpdateAvailable('v0.6.0', '')).toBe(false);
    expect(isUpdateAvailable('', '')).toBe(false);
  });
});
