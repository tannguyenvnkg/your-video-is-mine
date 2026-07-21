// Pure helper: builds the version label shown in the popup. Split out for unit testing.
export function formatVersionLabel(name: string, version: string): string {
  return `${name} v${version}`;
}

/** Parsed SemVer version. An empty `prerelease` means a stable release. */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

// major.minor.patch + prerelease (-rc.1) + build metadata (+abc) — build metadata is ignored per SemVer.
const SEMVER_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parse a version string, accepting a "v" prefix (GitHub tags like "v0.5.0").
 * Returns null on a malformed input -> caller treats it as "not comparable".
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

// Compare one prerelease identifier per SemVer §11: numeric compares numerically, number < text, text compares by ASCII.
function comparePrereleaseId(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Math.sign(Number(a) - Number(b));
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrerelease(a: string[], b: string[]): number {
  // A version with a prerelease is always SMALLER than the stable version with the same numbers: 1.0.0-rc.1 < 1.0.0.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = comparePrereleaseId(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  // Equal through the shared prefix -> fewer identifiers is smaller: 1.0.0-rc < 1.0.0-rc.1.
  return Math.sign(a.length - b.length);
}

/** Compare two parsed versions: -1 if a < b, 0 if equal, 1 if a > b. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return Math.sign(a.major - b.major);
  if (a.minor !== b.minor) return Math.sign(a.minor - b.minor);
  if (a.patch !== b.patch) return Math.sign(a.patch - b.patch);
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Is the GitHub tag ("v0.6.0") newer than the installed version ("0.5.0")?
 * A malformed value on either side -> false (better to not notify than to notify wrongly).
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
