import { describe, expect, it } from 'vitest';
import {
  baseNameFromUrl,
  buildDownloadFilename,
  DEFAULT_FILENAME_TEMPLATE,
  extForMedia,
  isUsableTemplate,
  renderFilenameTemplate,
  sanitizeFilename,
  truncateUtf8,
  type TemplateVars,
} from './filename';

const bytes = (s: string) => new TextEncoder().encode(s).length;

// A LONE surrogate = evidence of a cut that split an emoji in half. Note: must NOT check with
// /[\uD800-\uDFFF]/ — every valid emoji is a surrogate PAIR so that regex always matches.
const hasLoneSurrogate = (s: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    s,
  );

describe('sanitizeFilename', () => {
  it('replaces forbidden characters with _', () => {
    expect(sanitizeFilename('a/b:c*?"<>|d')).toBe('a_b_c_d');
  });
  it('trims extra whitespace/dots on both ends', () => {
    expect(sanitizeFilename('  ..Tên video..  ')).toBe('Tên video');
  });
  it('KEEPS uppercase letters, digits, spaces and hyphens', () => {
    expect(sanitizeFilename('My Video 2024 HD-1080p')).toBe(
      'My Video 2024 HD-1080p',
    );
  });
});

describe('extForMedia', () => {
  it('uses the URL extension', () => {
    expect(extForMedia('https://a.com/v.webm?x=1')).toBe('.webm');
  });
  it('uses Content-Type when the URL has no video extension', () => {
    expect(extForMedia('https://a.com/stream', 'video/mp4')).toBe('.mp4');
    expect(extForMedia('https://a.com/stream', 'video/webm')).toBe('.webm');
  });
  it('defaults to .mp4', () => {
    expect(extForMedia('https://a.com/stream')).toBe('.mp4');
  });
});

describe('baseNameFromUrl', () => {
  it('extracts the filename without extension', () => {
    expect(baseNameFromUrl('https://a.com/dir/clip.mp4?t=1')).toBe('clip');
  });
  it('falls back to hostname when the path is empty', () => {
    expect(baseNameFromUrl('https://a.com/')).toBe('a.com');
  });
});

describe('buildDownloadFilename', () => {
  it('joins title + resolution + extension', () => {
    expect(
      buildDownloadFilename({
        url: 'https://a.com/x.mp4',
        title: 'Phim hay',
        height: 720,
      }),
    ).toBe('Phim hay_720p.mp4');
  });

  it('sanitizes a title with forbidden characters', () => {
    expect(
      buildDownloadFilename({ url: 'https://a.com/x.mp4', title: 'a/b:c' }),
    ).toBe('a_b_c.mp4');
  });

  it('falls back to a URL-derived name when there is no title', () => {
    expect(buildDownloadFilename({ url: 'https://a.com/dir/movie.webm' })).toBe(
      'movie.webm',
    );
  });

  it('adds a subfolder', () => {
    expect(
      buildDownloadFilename({
        url: 'https://a.com/x.mp4',
        title: 'clip',
        folder: 'YVIM',
      }),
    ).toBe('YVIM/clip.mp4');
  });

  it('extension from Content-Type when the URL is unclear', () => {
    expect(
      buildDownloadFilename({
        url: 'https://a.com/play',
        title: 'live',
        contentType: 'video/webm',
      }),
    ).toBe('live.webm');
  });
});

// ── W4.3 ────────────────────────────────────────────────────────────────────

describe('truncateUtf8 + sanitizeFilename cut by BYTE', () => {
  it('cutting emoji does NOT split a surrogate pair', () => {
    const out = sanitizeFilename('🎬'.repeat(200));
    expect(bytes(out)).toBeLessThanOrEqual(200);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it('accented Vietnamese text still stays within the byte cap', () => {
    expect(
      bytes(sanitizeFilename('Tên video '.repeat(40))),
    ).toBeLessThanOrEqual(200);
  });

  // 🔴 PIN THE ORDER: cut FIRST, then trim both ends. Doing it the other way lets the cut expose a
  // trailing '.'.
  it('does not leave a trailing dot/underscore/space after cutting', () => {
    const out = sanitizeFilename('a'.repeat(199) + '.xyz');
    expect(out.endsWith('.')).toBe(false);
    expect(out.endsWith('_')).toBe(false);
    expect(out.endsWith(' ')).toBe(false);
  });

  it('150-char ASCII stays unchanged (looser than the old 120 cap)', () => {
    expect(sanitizeFilename('a'.repeat(150))).toBe('a'.repeat(150));
  });

  it('strips invisible characters that slip into the filename', () => {
    expect(sanitizeFilename('A\u200BB')).toBe('AB');
  });

  // NBSP often leaks in from page titles. Must become a NORMAL space, not be kept as-is.
  it('NBSP -> normal space', () => {
    const out = sanitizeFilename('Tên\u00A0video\u202Fhay');
    expect(out).toBe('Tên video hay');
    expect(/[\u00A0\u2007\u202F]/.test(out)).toBe(false);
  });

  it('truncateUtf8 counts by byte, not by character', () => {
    expect(bytes(truncateUtf8('é'.repeat(100), 10))).toBeLessThanOrEqual(10);
  });

  // 🔴 An ODD cap relative to emoji width (5 bytes / 4-byte emoji) -> the cut falls RIGHT in the
  // middle of a surrogate pair if you iterate by UTF-16 unit. An even cap like 200 lets this bug
  // slip through by numeric luck.
  it('an odd cap still does not split an emoji', () => {
    const out = truncateUtf8('🎬🎬🎬', 5);
    expect(bytes(out)).toBeLessThanOrEqual(5);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).toBe('🎬');
  });
});

describe('renderFilenameTemplate', () => {
  const vars: TemplateVars = {
    title: 'A',
    basename: 'x',
    res: '_720p',
    site: 's.com',
    date: '2026-07-19',
    time: '143500',
  };

  it('substitutes tokens', () => {
    expect(renderFilenameTemplate('{title}{res}', vars)).toBe('A_720p');
  });

  // 🔴 The hyphen lives INSIDE the {res} token -> no video should ever end up named 'A_'.
  it('an empty res leaves no dangling hyphen', () => {
    expect(renderFilenameTemplate('{title}{res}', { ...vars, res: '' })).toBe(
      'A',
    );
  });

  // 🔴 '{' and '}' are NOT in the forbidden-character list -> keeping an unknown token as-is would
  // let it reach disk.
  it('an unknown token -> empty, braces must NOT leak into the filename', () => {
    expect(renderFilenameTemplate('{title}_{nope}', vars)).toBe('A_');
  });
});

describe('isUsableTemplate', () => {
  it('the template must produce names that DISTINGUISH between videos', () => {
    expect(isUsableTemplate('{title}{res}')).toBe(true);
    expect(isUsableTemplate('{basename}')).toBe(true);
    expect(isUsableTemplate('{date}')).toBe(false);
    expect(isUsableTemplate('   ')).toBe(false);
  });
});

describe('buildDownloadFilename + filename templates', () => {
  it('the default template produces EXACTLY the pre-W4.3 result', () => {
    expect(DEFAULT_FILENAME_TEMPLATE).toBe('{title}{res}');
  });

  it('a template with {site} and {date}', () => {
    // 🔴 W4.3 debt — {date} is derived from the MACHINE's clock (new Date(now) getters, local), so
    // the expectation MUST be built from that same new Date(now), NOT hardcoded. The old version
    // hardcoded '2026-07-19' + Date.UTC, which FALSELY fails on machines at UTC+13/+14 (12:00Z on
    // the 19th rolls over to the 20th in local time). Nearly reached the opposite conclusion. This
    // test measures the TEST MACHINE's timezone, not behavior — it must be self-consistent with the
    // environment.
    const now = Date.UTC(2026, 6, 19, 12, 0, 0);
    const d = new Date(now);
    const p2 = (n: number) => String(n).padStart(2, '0');
    const expectDate = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    expect(
      buildDownloadFilename({
        url: 'https://a.com/x.mp4',
        title: 'A',
        template: '{site}_{title}_{date}',
        pageUrl: 'https://www.site.com/w',
        now,
      }),
    ).toBe(`site.com_A_${expectDate}.mp4`);
  });

  // 🔴 W4.3 debt — {time} and the two() helper (2-digit padding) were SHIPPED tokens with zero
  // assertions. Using new Date(local components) then reading back local components ->
  // TIMEZONE-INDEPENDENT (unlike Date.UTC). Picking single-digit hour/minute/second pins down two()
  // exactly: missing the pad would give '305' instead of '030509'.
  it('{time} = HHMMSS in local time, 2-digit padded (pins down two())', () => {
    const now = new Date(2026, 0, 2, 3, 5, 9).getTime(); // 03:05:09 local time
    expect(
      buildDownloadFilename({
        url: 'https://a.com/x.mp4',
        title: 'A',
        template: '{title}_{time}',
        now,
      }),
    ).toBe('A_030509.mp4');
  });

  it('{time} pads both digits (does not truncate a large number)', () => {
    const now = new Date(2026, 0, 2, 23, 47, 58).getTime();
    expect(
      buildDownloadFilename({
        url: 'https://a.com/x.mp4',
        title: 'A',
        template: '{title}_{time}',
        now,
      }),
    ).toBe('A_234758.mp4');
  });

  it('empty {title} -> falls back to the URL-derived name', () => {
    expect(
      buildDownloadFilename({
        url: 'https://a.com/dir/movie.webm',
        title: '',
        template: '{title}',
      }),
    ).toBe('movie.webm');
  });

  // 🔴 SECOND-TIER fallback, runs AFTER sanitize: a template of only unknown tokens produces an
  // empty string.
  it('a nonsensical template still produces a usable name, never empty', () => {
    expect(
      buildDownloadFilename({
        url: 'https://a.com/dir/movie.webm',
        template: '{nope}',
      }),
    ).toBe('movie.webm');
    expect(
      buildDownloadFilename({ url: 'https://a.com/', template: '{nope}' }),
    ).toBe('a.com.mp4');
  });

  // 🔴 PIN THE ORDER: the template '...' renders to a NON-EMPTY string, and only becomes empty
  // AFTER sanitize. Checking the fallback BEFORE sanitize misses this case -> a file named '.mp4'
  // (a hidden file with no visible extension).
  it('a template made entirely of sanitize-stripped characters -> still falls back correctly', () => {
    expect(
      buildDownloadFilename({
        url: 'https://a.com/dir/movie.webm',
        template: '...',
      }),
    ).toBe('movie.webm');
  });

  // 🔴 A user-typed template must NOT be able to inject a directory separator: '/' is only valid
  // as the folder separator.
  it('a template cannot inject a directory separator', () => {
    expect(
      buildDownloadFilename({
        url: 'https://a.com/x.mp4',
        title: 'A',
        template: '{title}/{title}',
        folder: 'YVIM',
      }),
    ).toBe('YVIM/A_A.mp4');
  });
});
