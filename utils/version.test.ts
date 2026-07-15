import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  formatVersionLabel,
  isUpdateAvailable,
  parseVersion,
} from './version';

describe('formatVersionLabel', () => {
  it('ghép thành "<name> v<version>"', () => {
    expect(formatVersionLabel('Your Video Is Mine', '0.1.0')).toBe(
      'Your Video Is Mine v0.1.0',
    );
  });
});

describe('parseVersion', () => {
  it('tách được dạng chuẩn', () => {
    expect(parseVersion('0.5.0')).toEqual({
      major: 0,
      minor: 5,
      patch: 0,
      prerelease: [],
    });
  });

  it('bỏ tiền tố "v" của tag GitHub', () => {
    expect(parseVersion('v1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
  });

  it('tách prerelease thành từng định danh', () => {
    expect(parseVersion('1.0.0-rc.1')?.prerelease).toEqual(['rc', '1']);
  });

  it('bỏ qua build metadata', () => {
    expect(parseVersion('1.0.0+build.5')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: [],
    });
  });

  it('cắt khoảng trắng thừa', () => {
    expect(parseVersion('  v2.0.0 \n')?.major).toBe(2);
  });

  it('trả null khi sai dạng', () => {
    for (const bad of ['', 'v', '1.2', 'abc', '1.2.3.4', 'v1.2.x', '-1.0.0']) {
      expect(parseVersion(bad), bad).toBeNull();
    }
  });
});

// Helper gọn cho các case so sánh bên dưới.
function cmp(a: string, b: string): number {
  return compareVersions(parseVersion(a)!, parseVersion(b)!);
}

describe('compareVersions', () => {
  it('so theo SỐ chứ không theo chuỗi (0.10.0 > 0.9.0)', () => {
    expect(cmp('0.10.0', '0.9.0')).toBe(1);
    expect(cmp('0.9.0', '0.10.0')).toBe(-1);
    // Bẫy kinh điển của so chuỗi: '0.10.0' < '0.9.0' theo thứ tự từ điển.
    expect('0.10.0' < '0.9.0').toBe(true);
  });

  it('so major rồi minor rồi patch', () => {
    expect(cmp('1.0.0', '0.99.99')).toBe(1);
    expect(cmp('1.2.0', '1.1.99')).toBe(1);
    expect(cmp('1.1.2', '1.1.1')).toBe(1);
  });

  it('bằng nhau trả 0, tiền tố v không ảnh hưởng', () => {
    expect(cmp('1.2.3', '1.2.3')).toBe(0);
    expect(cmp('v1.2.3', '1.2.3')).toBe(0);
  });

  it('prerelease NHỎ hơn bản chính thức cùng số', () => {
    expect(cmp('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(cmp('1.0.0', '1.0.0-rc.1')).toBe(1);
  });

  it('so prerelease: số theo số, số < chữ, ít định danh < nhiều', () => {
    expect(cmp('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1); // 2 < 10 theo số
    expect(cmp('1.0.0-1', '1.0.0-alpha')).toBe(-1); // số < chữ
    expect(cmp('1.0.0-rc', '1.0.0-rc.1')).toBe(-1); // ít định danh hơn
    expect(cmp('1.0.0-alpha', '1.0.0-beta')).toBe(-1); // ASCII
  });

  it('chuỗi SemVer mẫu §11 xếp đúng thứ tự tăng dần', () => {
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
  it('tag mới hơn -> true', () => {
    expect(isUpdateAvailable('v0.6.0', '0.5.0')).toBe(true);
    expect(isUpdateAvailable('v0.10.0', '0.9.0')).toBe(true);
  });

  it('bằng hoặc cũ hơn -> false', () => {
    expect(isUpdateAvailable('v0.5.0', '0.5.0')).toBe(false);
    expect(isUpdateAvailable('v0.4.1', '0.5.0')).toBe(false);
  });

  it('bản cài là prerelease thì bản chính thức cùng số là mới hơn', () => {
    expect(isUpdateAvailable('v1.0.0', '1.0.0-rc.1')).toBe(true);
    expect(isUpdateAvailable('v1.0.0-rc.1', '1.0.0')).toBe(false);
  });

  it('sai dạng -> false (thà không báo còn hơn báo nhầm)', () => {
    expect(isUpdateAvailable('latest', '0.5.0')).toBe(false);
    expect(isUpdateAvailable('v0.6.0', '')).toBe(false);
    expect(isUpdateAvailable('', '')).toBe(false);
  });
});
