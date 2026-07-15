// Helper thuần: tạo nhãn phiên bản hiển thị trên popup. Tách riêng để unit test.
export function formatVersionLabel(name: string, version: string): string {
  return `${name} v${version}`;
}

/** Phiên bản SemVer đã tách. `prerelease` rỗng nghĩa là bản chính thức. */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

// major.minor.patch + prerelease (-rc.1) + build metadata (+abc) — build bị bỏ qua theo SemVer.
const SEMVER_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Tách chuỗi phiên bản, chấp nhận tiền tố "v" (tag GitHub dạng "v0.5.0").
 * Trả null nếu sai dạng -> nơi gọi coi như "không so sánh được".
 */
export function parseVersion(input: string): ParsedVersion | null {
  const m = SEMVER_RE.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

// So 1 định danh prerelease theo SemVer §11: số so theo số, số < chữ, chữ so theo ASCII.
function comparePrereleaseId(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Math.sign(Number(a) - Number(b));
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrerelease(a: string[], b: string[]): number {
  // Bản có prerelease luôn NHỎ hơn bản chính thức cùng số: 1.0.0-rc.1 < 1.0.0.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = comparePrereleaseId(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  // Trùng tới hết phần chung -> ít định danh hơn là nhỏ hơn: 1.0.0-rc < 1.0.0-rc.1.
  return Math.sign(a.length - b.length);
}

/** So 2 phiên bản đã tách: -1 nếu a < b, 0 nếu bằng, 1 nếu a > b. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return Math.sign(a.major - b.major);
  if (a.minor !== b.minor) return Math.sign(a.minor - b.minor);
  if (a.patch !== b.patch) return Math.sign(a.patch - b.patch);
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Tag GitHub ("v0.6.0") có mới hơn phiên bản đang cài ("0.5.0") không?
 * Sai dạng ở bất kỳ vế nào -> false (thà không báo còn hơn báo nhầm).
 */
export function isUpdateAvailable(
  latestTag: string,
  currentVersion: string,
): boolean {
  const latest = parseVersion(latestTag);
  const current = parseVersion(currentVersion);
  if (!latest || !current) return false;
  return compareVersions(latest, current) > 0;
}
