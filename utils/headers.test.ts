// W2.1 — RED-FIRST test for capturing & replaying the REAL headers of the player.
//
// 🔬 EVERY DECISION BELOW WAS MEASURED IN REAL EDGE (2026-07-19), don't "simplify" by
// intuition. Measurement table (fetch from the SERVICE WORKER, tabId -1, to an echo server logging received headers):
//
//   header                | fetch(url,{headers}) | DNR modifyHeaders
//   ----------------------|----------------------|------------------
//   Cookie                | ❌ DROPPED, SILENTLY  | ✅ arrives
//   Referer               | ❌ DROPPED, SILENTLY  | ✅ arrives
//   User-Agent            | ❌ DROPPED, SILENTLY  | ✅ arrives
//   Origin                | ✅ arrives            | ✅ arrives
//   Authorization         | ✅ arrives            | ✅ arrives
//   X-Playback-Session-Id | ✅ arrives            | ✅ arrives
//
// TWO DESIGN CONSEQUENCES:
// 1. The "DROPPED, SILENTLY" column is the GREEN-AND-SILENT class of bug that has killed this
//    project 3 times. `fetch` accepts the header then throws it away without a word -> MUST NOT
//    replay via `fetch(headers)`.
// 2. DNR can set EVERY header measured -> replay ALL of it via DNR, without touching offscreen's
//    fetch chain. This also avoids the `retry.ts` trap (adding a second `headers` key would
//    overwrite the byterange `Range` from W1.3 — silently breaking fMP4/CMAF).
//
// ⚠️ WRONG-CONTEXT MEASUREMENT WARNING: the first measurement ran fetch from the options page ->
// the page has a REAL tabId, so the rule `tabIds:[-1]` does NOT match -> every header was dropped,
// INCLUDING referer (which we know for a fact works in production). Nearly concluded the opposite.
// Re-measuring from the SW produced the table above.

import { describe, it, expect } from 'vitest';
import {
  capturedFromHeaderList,
  filterCapturable,
  planHeaderReplay,
  shouldCaptureRequest,
  stripSensitive,
} from './headers';

describe('capturedFromHeaderList — normalize webRequest header list', () => {
  it('lowercases header names (webRequest returns a mix of "User-Agent" and "sec-ch-ua")', () => {
    expect(
      capturedFromHeaderList([
        { name: 'Referer', value: 'https://site.example/watch' },
        { name: 'X-Playback-Session-Id', value: 'abc' },
      ]),
    ).toEqual({
      referer: 'https://site.example/watch',
      'x-playback-session-id': 'abc',
    });
  });

  it('drops headers without a value (webRequest may return binaryValue instead of value)', () => {
    expect(
      capturedFromHeaderList([
        { name: 'Referer', value: 'https://site.example/' },
        { name: 'X-Weird' },
      ]),
    ).toEqual({ referer: 'https://site.example/' });
  });

  it('empty list -> empty object', () => {
    expect(capturedFromHeaderList([])).toEqual({});
  });
});

describe('shouldCaptureRequest — only capture headers from the PAGE PLAYER', () => {
  // 🔬 MEASURED: fetches from the extension ITSELF also land in onSendHeaders, carrying
  // initiator='chrome-extension://<id>'. Without filtering we'd capture back our own FAKED
  // header then "replay" it next time — a self-poisoning loop, and every gate stays GREEN.
  const extId = 'eodhaphachabehmjnpdombgcpkmigkcd';

  it('CAPTURES a request from the page (real tabId, initiator is the site)', () => {
    expect(
      shouldCaptureRequest(
        { tabId: 7, initiator: 'https://site.example', type: 'xmlhttprequest' },
        extId,
      ),
    ).toBe(true);
  });

  it('🔴 does NOT capture a request from the extension itself (initiator chrome-extension://<id>)', () => {
    expect(
      shouldCaptureRequest(
        {
          tabId: 7,
          initiator: `chrome-extension://${extId}`,
          type: 'xmlhttprequest',
        },
        extId,
      ),
    ).toBe(false);
  });

  it('🔴 does NOT capture a tab-less request (tabId -1 = issued by our own SW/offscreen)', () => {
    expect(
      shouldCaptureRequest(
        { tabId: -1, initiator: undefined, type: 'xmlhttprequest' },
        extId,
      ),
    ).toBe(false);
  });

  it('CAPTURES type "media" (a <video> tag direct load, not via XHR)', () => {
    expect(
      shouldCaptureRequest(
        { tabId: 7, initiator: 'https://site.example', type: 'media' },
        extId,
      ),
    ).toBe(true);
  });

  it('does NOT capture main_frame (page navigation, not a player request)', () => {
    expect(
      shouldCaptureRequest(
        { tabId: 7, initiator: 'https://site.example', type: 'main_frame' },
        extId,
      ),
    ).toBe(false);
  });
});

describe('planHeaderReplay — replaying to the SAME host (full)', () => {
  const same = (h: Record<string, string>) =>
    planHeaderReplay(h, { sameHost: true });

  it('replays Referer/Origin with the exact value the page sent', () => {
    expect(
      same({
        referer: 'https://site.example/watch?v=1',
        origin: 'https://site.example',
      }).headers,
    ).toEqual({
      referer: 'https://site.example/watch?v=1',
      origin: 'https://site.example',
    });
  });

  it('replays Authorization + an unknown token header (exactly the §2.11 403 pain point)', () => {
    expect(
      same({
        authorization: 'Bearer TOKEN123',
        'x-playback-session-id': 'sess-9',
      }).headers,
    ).toEqual({
      authorization: 'Bearer TOKEN123',
      'x-playback-session-id': 'sess-9',
    });
  });

  it('🔴 does NOT replay Cookie — the browser jar already sent it', () => {
    // 🔬 MEASURED: every one of our media fetches already has credentials:'include' and
    // AUTOMATICALLY carries the site's real cookie (measured in a probe: the extension fetch
    // received the exact `playertoken` without doing anything). Replaying the captured snapshot
    // would (a) overwrite the NEW cookie with the OLD one, (b) leak the site cookie to another CDN host.
    const out = same({
      cookie: 'sid=SECRET',
      referer: 'https://site.example/',
    });
    expect(out.headers).not.toHaveProperty('cookie');
    expect(out.dropped).toContain('cookie');
  });

  it("🔴 DROPS Range — that is OUR OWN header (byterange W1.3), not the page's", () => {
    const out = same({ range: 'bytes=0-100' });
    expect(out.headers).toEqual({});
    expect(out.dropped).toContain('range');
  });

  it('DROPS transport-layer / browser-identity headers (we are the same browser, replaying is meaningless)', () => {
    expect(
      same({
        host: 'site.example',
        connection: 'keep-alive',
        'content-length': '0',
        'accept-encoding': 'gzip',
        'proxy-authorization': 'x',
        'user-agent': 'Mozilla/5.0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
      }).headers,
    ).toEqual({});
  });
});

describe('planHeaderReplay — replaying to a DIFFERENT host (narrowed)', () => {
  // Why this distinction is needed: a DNR rule matches by HOST and covers EVERY tab-less request
  // to that host. Shooting site A's `Authorization` at CDN B is a CREDENTIAL LEAK — worse than the
  // 403 it was meant to fix. Referer/Origin are the opposite: they ARE the PAGE's identity, and
  // sending them to the CDN is exactly the intended purpose (§2.4: keys/segments often live on a
  // different host, which is precisely where Referer is checked most strictly).
  const cross = (h: Record<string, string>) =>
    planHeaderReplay(h, { sameHost: false });

  it('Referer/Origin STILL get replayed to a different host (that is the point of W2.3)', () => {
    expect(
      cross({
        referer: 'https://site.example/watch',
        origin: 'https://site.example',
      }).headers,
    ).toEqual({
      referer: 'https://site.example/watch',
      origin: 'https://site.example',
    });
  });

  it('🔴 does NOT send Authorization to a different host', () => {
    const out = cross({
      authorization: 'Bearer TOKEN123',
      referer: 'https://site.example/',
    });
    expect(out.headers).not.toHaveProperty('authorization');
    expect(out.headers).toEqual({ referer: 'https://site.example/' });
    expect(out.dropped).toContain('authorization');
  });

  it('🔴 does NOT send an unknown token header (x-*) to a different host', () => {
    const out = cross({ 'x-playback-session-id': 'sess-9' });
    expect(out.headers).toEqual({});
    expect(out.isEmpty).toBe(true);
  });
});

describe('planHeaderReplay — GOLDEN RULE and fallback path', () => {
  it('🔴 page does NOT send Origin -> we do NOT generate Origin', () => {
    // §2.11: old code set Origin UNCONDITIONALLY on GET. Real players usually don't send Origin,
    // and some CDNs treat a stray Origin on GET as a CORS violation -> the very rule meant to
    // "fight 403" CAUSES a 403.
    const out = planHeaderReplay(
      { referer: 'https://site.example/' },
      { sameHost: true },
    );
    expect(out.headers).toEqual({ referer: 'https://site.example/' });
    expect(out.headers).not.toHaveProperty('origin');
  });

  it('empty snapshot -> isEmpty true (caller MUST fall back to the old spoof)', () => {
    expect(planHeaderReplay({}, { sameHost: true }).isEmpty).toBe(true);
  });

  it('🔴 only dropped headers present -> isEmpty TRUE, must NOT be treated as "captured"', () => {
    // If isEmpty is wrong here, the caller thinks it has real headers and DROPS the fake-Referer
    // fallback -> loses the currently-working 403-bypass feature (e2e variants-403 /
    // segments-other-host / progressive-403). This is the most dangerous regression case in the
    // whole W2.1 package.
    expect(
      planHeaderReplay({ 'accept-encoding': 'gzip' }, { sameHost: true })
        .isEmpty,
    ).toBe(true);
  });

  it('at least one replayable header -> isEmpty false', () => {
    expect(
      planHeaderReplay({ referer: 'https://a.example/' }, { sameHost: true })
        .isEmpty,
    ).toBe(false);
  });
});

// ── Fixed after adversarial review (2026-07-19) ──────────────────────────────────────────────
// The three bugs below were each flagged by 4 INDEPENDENT reviewers (2 bugs were flagged twice
// from 2 different angles). Per the W1.5 lesson: **convergence of multiple lenses beats vote
// count** — go MEASURE it, and all three turned out to be REAL.
describe('🔴 REVIEW: harmless headers must NOT pretend to be "captured"', () => {
  it('accept + accept-language alone -> isEmpty TRUE (must not block the fallback)', () => {
    // 🔬 MEASURED: the player's captured snapshot ALWAYS has `accept` and `accept-language` (seen
    // in the probe). A page that sets `Referrer-Policy: no-referrer` (very common, correctly, on
    // anti-hotlink sites) will have NO referer in the snapshot. Before the fix: these two harmless
    // headers survived -> isEmpty=false -> caller thought "we have real headers" -> DROPPED the
    // fake-Referer fallback -> lost the currently-working 403-bypass feature entirely. The old test
    // missed this because it only tried `accept-encoding` (already in NEVER_REPLAY).
    const out = planHeaderReplay(
      { accept: '*/*', 'accept-language': 'en-US,en;q=0.9' },
      { sameHost: true },
    );
    expect(out.headers).toEqual({});
    expect(out.isEmpty).toBe(true);
  });

  it('harmless accept + a real referer -> referer still gets replayed', () => {
    const out = planHeaderReplay(
      { accept: '*/*', referer: 'https://site.example/watch' },
      { sameHost: true },
    );
    expect(out.headers).toEqual({ referer: 'https://site.example/watch' });
    expect(out.isEmpty).toBe(false);
  });
});

describe('🔴 REVIEW: do NOT replay cache validators (turns the request into an empty 304)', () => {
  it('if-none-match / if-modified-since are dropped', () => {
    // The player already fetched the manifest once -> next time the browser attaches
    // `If-None-Match: "v37"`. Replaying that on our NEW fetch -> the server returns a **304 with
    // no body** -> parsing an empty playlist. Live HLS refreshes every target-duration, so this
    // case is anything but rare.
    const out = planHeaderReplay(
      {
        'if-none-match': '"v37"',
        'if-modified-since': 'Wed, 19 Jul 2026 00:00:00 GMT',
        referer: 'https://site.example/',
      },
      { sameHost: true },
    );
    expect(out.headers).toEqual({ referer: 'https://site.example/' });
    expect(out.dropped).toContain('if-none-match');
    expect(out.dropped).toContain('if-modified-since');
  });
});

describe('🔴 REVIEW: a rule carrying a sensitive header must anchor to ORIGIN, not host', () => {
  it('has a sensitive header -> hasSensitive TRUE', () => {
    // DNR `requestDomains:['example.com']` matches ANY subdomain (api., accounts., cdn.). So a
    // rule carrying `Authorization` for media on the apex would shoot that token to EVERY
    // subdomain the extension fetches to — including a segment host we deliberately stripped auth
    // from on the cross-host branch. The cross-host shield gets neutralized by DNR's own
    // subdomain-matching semantics.
    expect(
      planHeaderReplay(
        { authorization: 'Bearer T', referer: 'https://site.example/' },
        { sameHost: true },
      ).hasSensitive,
    ).toBe(true);
  });

  it('only Referer/Origin -> hasSensitive FALSE (allowed to span the whole host)', () => {
    expect(
      planHeaderReplay(
        { referer: 'https://site.example/', origin: 'https://site.example' },
        { sameHost: true },
      ).hasSensitive,
    ).toBe(false);
  });
});

describe('🔴 REVIEW: filterCapturable — do not STORE what never gets replayed', () => {
  it('Cookie never touches storage', () => {
    // Privacy: the listener runs on `<all_urls>`, so storing the raw snapshot would put the raw
    // Cookie of every site with video (internal LMS, paid courses…) into storage.session even
    // before the user ever clicks download. We already decided NOT to replay Cookie -> so don't
    // store it in the first place.
    const out = filterCapturable({
      cookie: 'sid=SECRET',
      referer: 'https://site.example/',
      'x-playback-session-id': 'tok',
    });
    expect(out).toEqual({
      referer: 'https://site.example/',
      'x-playback-session-id': 'tok',
    });
  });

  it('a snapshot that is all junk -> empty object (caller skips it, no storage write)', () => {
    expect(
      filterCapturable({ accept: '*/*', 'accept-encoding': 'gzip' }),
    ).toEqual({});
  });
});

describe('W2.1 debt (a) — stripSensitive: downgrade a plan to only referer/origin', () => {
  it('drops Authorization + the x-* token, KEEPS referer/origin', () => {
    const plan = planHeaderReplay(
      {
        referer: 'https://site.example/',
        origin: 'https://site.example',
        authorization: 'Bearer TOKEN_A',
        'x-playback-session-id': 'sess-9',
      },
      { sameHost: true },
    );
    expect(plan.hasSensitive).toBe(true); // precondition: the original plan has sensitive data
    const stripped = stripSensitive(plan);
    expect(stripped.headers).toEqual({
      referer: 'https://site.example/',
      origin: 'https://site.example',
    });
    expect(stripped.hasSensitive).toBe(false);
    expect(stripped.isEmpty).toBe(false);
  });

  it('a plan of only sensitive headers -> downgrades to EMPTY (caller falls back to fake Referer)', () => {
    const plan = planHeaderReplay(
      { authorization: 'Bearer TOKEN_A' },
      { sameHost: true },
    );
    const stripped = stripSensitive(plan);
    expect(stripped.headers).toEqual({});
    expect(stripped.isEmpty).toBe(true);
  });
});
