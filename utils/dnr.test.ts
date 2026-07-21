import { describe, expect, it } from 'vitest';
import {
  buildHeaderSpoofRule,
  buildRefererSpoofRule,
  hasConflictingSensitiveRule,
  hostFromUrl,
  originFromUrl,
  SPOOF_RULE_ID_MIN,
  staleSpoofRuleIds,
  type DnrRule,
} from './dnr';

describe('hostFromUrl / originFromUrl', () => {
  it('extracts host & origin', () => {
    expect(hostFromUrl('https://cdn.example.com:8443/a/b.ts?x=1')).toBe(
      'cdn.example.com',
    );
    expect(originFromUrl('https://cdn.example.com:8443/a/b.ts')).toBe(
      'https://cdn.example.com:8443',
    );
  });
  it('a malformed URL -> null', () => {
    expect(hostFromUrl('not a url')).toBeNull();
    expect(originFromUrl('not a url')).toBeNull();
  });
});

describe('buildRefererSpoofRule', () => {
  const rule = buildRefererSpoofRule(
    2345,
    'cdn.example.com',
    'https://page.example.com/watch',
    'https://page.example.com',
  );

  it('accepts an EXPLICIT id (W2.4: one id per download, not derived from host)', () => {
    // Before W2.4, id = hash(host) -> two downloads on the same CDN would steal each other's rule (§2.10).
    // Now the caller assigns a separate id per (download, host) pair, so the builder simply uses the id passed in.
    expect(rule.id).toBe(2345);
  });

  it('modifyHeaders sets Referer + Origin', () => {
    expect(rule.action.type).toBe('modifyHeaders');
    const headers = rule.action.requestHeaders;
    expect(headers).toEqual([
      {
        header: 'referer',
        operation: 'set',
        value: 'https://page.example.com/watch',
      },
      { header: 'origin', operation: 'set', value: 'https://page.example.com' },
    ]);
  });

  it('condition is restricted to host + resourceTypes belonging to the EXTENSION', () => {
    expect(rule.condition.requestDomains).toEqual(['cdn.example.com']);
    expect(rule.condition.resourceTypes).toContain('xmlhttprequest');
    expect(rule.condition.resourceTypes).toContain('other');
  });

  it("W2.4: does NOT spoof request types belonging to the PAGE'S OWN PLAYER (media/sub_frame/object)", () => {
    // §2.10: the old rule covered media/sub_frame/object -> it overwrote Referer/Origin on the
    // page's own traffic (player, iframe) -> the user saw a broken player / API 403 / got logged out.
    // These 3 types are dropped entirely.
    expect(rule.condition.resourceTypes).not.toContain('media');
    expect(rule.condition.resourceTypes).not.toContain('sub_frame');
    expect(rule.condition.resourceTypes).not.toContain('object');
  });

  it('W2.4: tabIds:[-1] -> matches ONLY requests issued by the extension, never touches page traffic', () => {
    // -1 = a request not tied to any tab (issued by the extension's SW/offscreen document). This one
    // line turns the vulnerability from "harms general browsing" into "affects only the extension's own fetches".
    expect(rule.condition.tabIds).toEqual([-1]);
  });
});

describe('staleSpoofRuleIds (reconciling leaked rules — W2.4 sweep)', () => {
  it('removes spoof ids with NO live job, KEEPS ids that are still alive', () => {
    const session = [
      SPOOF_RULE_ID_MIN,
      SPOOF_RULE_ID_MIN + 1,
      SPOOF_RULE_ID_MIN + 2,
    ];
    const alive = [SPOOF_RULE_ID_MIN + 1];
    expect(staleSpoofRuleIds(session, alive)).toEqual([
      SPOOF_RULE_ID_MIN,
      SPOOF_RULE_ID_MIN + 2,
    ]);
  });

  it('NEVER touches a rule id below the threshold (belongs to someone else / another range)', () => {
    // The sweep is only allowed to clean up within our own spoof rule range (>= MIN). A lower rule id
    // belongs to some other mechanism -> absolutely must not be deleted even if it's not in the "alive" set.
    const session = [1, 42, 1999, SPOOF_RULE_ID_MIN];
    expect(staleSpoofRuleIds(session, [])).toEqual([SPOOF_RULE_ID_MIN]);
  });

  it('empty alive set + no spoof rules -> deletes nothing', () => {
    expect(staleSpoofRuleIds([1, 2, 3], [])).toEqual([]);
  });
});

// ── W2.1 ─────────────────────────────────────────────────────────────────────────────────────
describe("buildHeaderSpoofRule — replays the player's ACTUAL headers", () => {
  it('generates exactly one modifyHeaders entry per header given', () => {
    const rule = buildHeaderSpoofRule(SPOOF_RULE_ID_MIN, 'cdn.example', {
      referer: 'https://site.example/watch',
      'x-playback-session-id': 'sess-9',
    });
    expect(rule.action.requestHeaders).toEqual([
      {
        header: 'referer',
        operation: 'set',
        value: 'https://site.example/watch',
      },
      { header: 'x-playback-session-id', operation: 'set', value: 'sess-9' },
    ]);
  });

  it('🔴 does NOT add Origin on its own when not given one (§2.11 golden rule)', () => {
    // The old FABRICATED version always included Origin. A real player usually doesn't send Origin
    // on a GET, and some CDNs 403 precisely because of that unexpected Origin -> the "anti-403" rule caused its own 403.
    const rule = buildHeaderSpoofRule(SPOOF_RULE_ID_MIN, 'cdn.example', {
      referer: 'https://site.example/',
    });
    expect(rule.action.requestHeaders.map((h) => h.header)).toEqual([
      'referer',
    ]);
  });

  it('keeps the blast radius narrowed at W2.4 (tabIds:[-1], no media/sub_frame)', () => {
    const rule = buildHeaderSpoofRule(SPOOF_RULE_ID_MIN, 'cdn.example', {
      referer: 'https://site.example/',
    });
    expect(rule.condition.tabIds).toEqual([-1]);
    expect(rule.condition.requestDomains).toEqual(['cdn.example']);
    expect(rule.condition.resourceTypes).not.toContain('media');
    expect(rule.condition.resourceTypes).not.toContain('sub_frame');
  });

  it('empty headers -> rule has no entries (caller must avoid applying a meaningless rule)', () => {
    expect(
      buildHeaderSpoofRule(SPOOF_RULE_ID_MIN, 'cdn.example', {}).action
        .requestHeaders,
    ).toEqual([]);
  });
});

describe('W2.1 debt (a) — hasConflictingSensitiveRule: value conflict, not mere existence', () => {
  // A newer job only drops its own sensitive headers when an existing rule on the same host sets a
  // sensitive header to a value that CONFLICTS with the one this job is about to set. Same token =>
  // no conflict => both downloads keep working. This is the fix for the existence-check regression
  // that used to 403 the common same-token case.
  const ruleWithToken = (token: string) =>
    buildHeaderSpoofRule(SPOOF_RULE_ID_MIN, 'cdn.example', {
      referer: 'https://site.example/',
      authorization: token,
    });

  it('same token, same host -> FALSE (no suppression, both jobs download)', () => {
    // 🔴 The most common case: two downloads from one site share ONE session token. An
    // existence-only check would wrongly suppress the second job and 403 it.
    expect(
      hasConflictingSensitiveRule(
        [ruleWithToken('Bearer TOKEN_A')],
        'cdn.example',
        { referer: 'https://site.example/', authorization: 'Bearer TOKEN_A' },
      ),
    ).toBe(false);
  });

  it('different token, same host -> TRUE (second job must strip its sensitive headers)', () => {
    expect(
      hasConflictingSensitiveRule(
        [ruleWithToken('Bearer TOKEN_A')],
        'cdn.example',
        { referer: 'https://site.example/', authorization: 'Bearer TOKEN_B' },
      ),
    ).toBe(true);
  });

  it('existing sensitive header this job does NOT set -> TRUE (it would leak onto our requests)', () => {
    expect(
      hasConflictingSensitiveRule(
        [ruleWithToken('Bearer TOKEN_A')],
        'cdn.example',
        { referer: 'https://site.example/' },
      ),
    ).toBe(true);
  });

  it('matching x-* token -> FALSE (custom tokens compared by value too)', () => {
    const r = buildHeaderSpoofRule(SPOOF_RULE_ID_MIN, 'cdn.example', {
      'x-playback-session-id': 'sess-9',
    });
    expect(
      hasConflictingSensitiveRule([r], 'cdn.example', {
        'x-playback-session-id': 'sess-9',
      }),
    ).toBe(false);
  });

  it('conflicting x-* token -> TRUE', () => {
    const r = buildHeaderSpoofRule(SPOOF_RULE_ID_MIN, 'cdn.example', {
      'x-playback-session-id': 'sess-9',
    });
    expect(
      hasConflictingSensitiveRule([r], 'cdn.example', {
        'x-playback-session-id': 'sess-DIFFERENT',
      }),
    ).toBe(true);
  });

  it('existing rule sets only referer/origin -> FALSE even if our referer differs', () => {
    // referer/origin are cross-host-safe identity headers, never "sensitive": a referer-only rule
    // must never suppress, or the ordinary one-job-per-host replay path dies.
    const refererOnlyRule = buildHeaderSpoofRule(
      SPOOF_RULE_ID_MIN,
      'cdn.example',
      {
        referer: 'https://site.example/a',
        origin: 'https://site.example',
      },
    );
    expect(
      hasConflictingSensitiveRule([refererOnlyRule], 'cdn.example', {
        referer: 'https://site.example/b',
        authorization: 'Bearer TOKEN_B',
      }),
    ).toBe(false);
  });

  it('conflicting sensitive rule but on a DIFFERENT host -> FALSE (no cross-host bleed)', () => {
    expect(
      hasConflictingSensitiveRule(
        [ruleWithToken('Bearer TOKEN_A')],
        'other.example',
        { authorization: 'Bearer TOKEN_B' },
      ),
    ).toBe(false);
  });

  it('no rules -> FALSE', () => {
    expect(
      hasConflictingSensitiveRule([], 'cdn.example', {
        authorization: 'x',
      }),
    ).toBe(false);
  });

  it('a remove operation is not a value conflict -> FALSE', () => {
    // Only `set` operations carry a value that could clobber another job; a `remove` sets nothing.
    const removeRule: DnrRule = {
      id: SPOOF_RULE_ID_MIN,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'authorization', operation: 'remove' }],
      },
      condition: {
        requestDomains: ['cdn.example'],
        resourceTypes: ['xmlhttprequest', 'other'],
        tabIds: [-1],
      },
    };
    expect(
      hasConflictingSensitiveRule([removeRule], 'cdn.example', {
        authorization: 'Bearer X',
      }),
    ).toBe(false);
  });
});
