import { describe, expect, it } from 'vitest';
import {
  cleanTitle,
  isJunkTitle,
  normalizeInvisible,
  pickTitle,
  sameDocument,
  siteTokens,
} from './title';

describe('normalizeInvisible', () => {
  it('removes invisible characters, NBSP -> space, collapses whitespace', () => {
    expect(normalizeInvisible('A​B C﻿')).toBe('AB C');
  });
});

describe('siteTokens', () => {
  it('takes the full hostname + site-name label, strips www and the TLD suffix, strips hyphens', () => {
    expect(siteTokens('https://www.abc-xyz.co.uk/a')).toEqual([
      'abcxyzcouk',
      'abcxyz',
    ]);
  });

  // 🔴 Caught by adversarial review: a subdomain label is NOT the site name.
  it('does NOT treat a subdomain label (live/video/watch) as the site name', () => {
    expect(siteTokens('https://live.vtv.vn/x')).toEqual(['livevtvvn', 'vtv']);
  });
  it('no pageUrl -> empty array (does NOT guess)', () => {
    expect(siteTokens(undefined)).toEqual([]);
  });
});

describe('cleanTitle', () => {
  it('does NOT strip a 4-digit number — that is a year, not a notification counter', () => {
    expect(cleanTitle('(2019) Movie', 'https://x.com/')).toBe('(2019) Movie');
  });
});

describe('pickTitle — ranking og > twitter > doc > tab > stored', () => {
  it('og beats a dirty document.title', () => {
    expect(
      pickTitle(
        { og: 'Tên Video Thật', doc: 'Tên Video Thật - SiteName' },
        'https://sitename.com/x',
      ),
    ).toBe('Tên Video Thật');
  });

  it('twitter beats doc', () => {
    expect(
      pickTitle({ twitter: 'T Title', doc: 'D Title' }, 'https://a.com/'),
    ).toBe('T Title');
  });

  it('strips the counter (3) and the site-name suffix matching the hostname', () => {
    expect(
      pickTitle(
        { doc: '(3) Real Name | YouTube' },
        'https://www.youtube.com/watch',
      ),
    ).toBe('Real Name');
  });

  // 🔴 PINS AGAINST FALSE POSITIVES — blindly stripping after a dash would kill episode numbers.
  it('does NOT strip a suffix when it does not match the site name', () => {
    expect(
      pickTitle({ doc: 'Real Name - Part 2' }, 'https://example.com/'),
    ).toBe('Real Name - Part 2');
  });

  it('strips ONLY EXACTLY ONE trailing suffix segment', () => {
    expect(pickTitle({ doc: 'A – B — C' }, 'https://c.com/')).toBe('A – B');
  });

  it('a title that is just the site name -> junk -> falls to a lower rank', () => {
    expect(
      pickTitle({ doc: 'YouTube' }, 'https://youtube.com/'),
    ).toBeUndefined();
  });

  it('missing pageUrl -> SKIPS the suffix-stripping rule, does not guess the site name', () => {
    expect(pickTitle({ doc: 'Real - Site' }, undefined)).toBe('Real - Site');
  });

  it('a candidate with only whitespace is skipped', () => {
    expect(pickTitle({ og: '   ', doc: 'Real Name' }, 'https://a.com/')).toBe(
      'Real Name',
    );
  });

  // 🔴 `stored` is a RANKED CANDIDATE, not a trailing `??`.
  it('stored is the lowest rank but is still used when nothing else is available', () => {
    expect(pickTitle({ og: 'Live', stored: 'Stale' }, 'https://a.com/')).toBe(
      'Live',
    );
    expect(pickTitle({ stored: 'Stale' }, 'https://a.com/')).toBe('Stale');
  });

  it('no candidates at all -> undefined', () => {
    expect(pickTitle({}, 'https://a.com/')).toBeUndefined();
  });

  // 🔴 TRAP FOR THE NEXT REFACTOR: og/twitter are set by the page author -> must NOT be cleaned.
  it('does NOT clean og/twitter', () => {
    expect(
      pickTitle({ og: '(3) Real - YouTube' }, 'https://youtube.com/'),
    ).toBe('(3) Real - YouTube');
  });

  // 🔴 Adversarial review (kept 3/3, measured via probe): 'live.vtv.vn' produces the token 'live' ->
  // the real title "Chung kết - Live" would be truncated to "Chung kết". Exactly the WRONG-NAME bug
  // this package swore to avoid.
  it('does NOT strip text that matches a SUBDOMAIN label of the hostname', () => {
    expect(
      pickTitle({ doc: 'Chung kết - Live' }, 'https://live.vtv.vn/x'),
    ).toBe('Chung kết - Live');
  });

  // 🔴 Substring match with a short token stripping blindly: the token 'abc' used to match into the suffix 'ABC Studio'.
  it('does NOT strip a suffix just because it CONTAINS a short token', () => {
    expect(
      pickTitle({ doc: 'Phim hay - ABC Studio' }, 'https://abc.vn/x'),
    ).toBe('Phim hay - ABC Studio');
  });

  it('a title <= 1 character is junk', () => {
    expect(pickTitle({ doc: 'A' }, 'https://a.com/')).toBeUndefined();
  });
});

describe('isJunkTitle', () => {
  it('empty and generic names are junk', () => {
    expect(isJunkTitle('', 'https://a.com/')).toBe(true);
    expect(isJunkTitle('video', 'https://a.com/')).toBe(true);
    expect(isJunkTitle('Tên video thật', 'https://a.com/')).toBe(false);
  });
});

describe('sameDocument', () => {
  it('ignores the hash — changing #t=90 is NOT a navigation', () => {
    expect(sameDocument('https://a.com/w?v=1#t=9', 'https://a.com/w?v=1')).toBe(
      true,
    );
  });
  it('different query -> different page', () => {
    expect(sameDocument('https://a.com/w?v=1', 'https://a.com/w?v=2')).toBe(
      false,
    );
  });
  it('missing one side -> false (does not guess)', () => {
    expect(sameDocument(undefined, 'https://a.com/')).toBe(false);
  });

  // 🔴 Adversarial review (kept 3/3): for an SPA hash-router, the hash IS the page.
  it('hash-router: #/xem/1 and #/xem/2 are TWO different pages', () => {
    expect(sameDocument('https://a.com/#/xem/1', 'https://a.com/#/xem/2')).toBe(
      false,
    );
    expect(sameDocument('https://a.com/#!/v/1', 'https://a.com/#!/v/2')).toBe(
      false,
    );
  });

  // Pins the origin check: an implementation that ignores origin would let all the above cases through.
  it('different origin -> different page', () => {
    expect(sameDocument('https://a.com/w', 'https://b.com/w')).toBe(false);
    expect(sameDocument('https://a.com/w', 'http://a.com/w')).toBe(false);
  });

  // 🔴 W4.3 debt — self-appended JUNK params (tracking + seek position) must not defeat the naming gate.
  it('ignores known junk params (utm_*, fbclid, t) -> still the SAME page', () => {
    expect(
      sameDocument('https://a.com/w?v=1&utm_source=fb', 'https://a.com/w?v=1'),
    ).toBe(true);
    expect(
      sameDocument(
        'https://a.com/w?v=1&fbclid=xyz&t=90',
        'https://a.com/w?v=1',
      ),
    ).toBe(true);
  });

  it('param ORDER does NOT change the result (the page may reorder them)', () => {
    expect(
      sameDocument('https://a.com/w?a=1&b=2', 'https://a.com/w?b=2&a=1'),
    ).toBe(true);
  });

  // 🔴 GUARDS AGAINST BEING TOO LENIENT: different IDENTIFYING params (?v=) must still count as TWO
  // pages, otherwise the wrong-naming guard treats two different videos as one -> naming video A's
  // file after video B.
  it('different UNKNOWN params (not on the junk list) -> DIFFERENT page', () => {
    expect(sameDocument('https://a.com/w?v=1', 'https://a.com/w?v=2')).toBe(
      false,
    );
    expect(
      sameDocument('https://a.com/w?id=abc', 'https://a.com/w?id=def'),
    ).toBe(false);
  });
});
