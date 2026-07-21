import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  addTabMedia,
  allocateSpoofRuleId,
  clearTabMedia,
  getDownloadByChromeId,
  getDownloads,
  getFilenameTemplate,
  getPreferredHeight,
  getTabMedia,
  getTabState,
  getHlsJobs,
  putDownload,
  putHlsJob,
  resetTab,
  setFilenameTemplate,
  setPreferredHeight,
  setTabNavUrl,
  updateDownload,
  updateHlsJob,
  type HlsJob,
} from './storage';
import { SPOOF_RULE_ID_MIN, SPOOF_RULE_ID_SPAN } from './dnr';
import type { MediaItem } from './types';

function item(url: string, extra: Partial<MediaItem> = {}): MediaItem {
  return { id: url, type: 'hls', url, tabId: 1, detectedAt: 0, ...extra };
}

describe('per-tab media storage', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('empty tab returns []', async () => {
    expect(await getTabMedia(1)).toEqual([]);
  });

  it('add & read back', async () => {
    const n = await addTabMedia(1, item('https://a.com/x.m3u8'));
    expect(n).toBe(1);
    expect(await getTabMedia(1)).toHaveLength(1);
  });

  it('duplicate url with no new field -> null, no increment', async () => {
    await addTabMedia(1, item('https://a.com/x.m3u8'));
    const dup = await addTabMedia(1, item('https://a.com/x.m3u8'));
    expect(dup).toBeNull();
    expect(await getTabMedia(1)).toHaveLength(1);
  });

  it('fills in size when the same url is re-detected (merge)', async () => {
    await addTabMedia(1, item('https://a.com/x.m3u8')); // no size yet
    const changed = await addTabMedia(
      1,
      item('https://a.com/x.m3u8', { size: 999 }),
    );
    expect(changed).toBe(1); // changed -> returns the count
    const list = await getTabMedia(1);
    expect(list[0]!.size).toBe(999);
  });

  it('media across tabs is independent', async () => {
    await addTabMedia(1, item('https://a.com/1.m3u8'));
    await addTabMedia(2, item('https://a.com/2.m3u8'));
    expect(await getTabMedia(1)).toHaveLength(1);
    expect(await getTabMedia(2)).toHaveLength(1);
  });

  it('navigation reset: discards media from old requests (timeStamp < navStartedAt)', async () => {
    await resetTab(1, 1000); // navigated at t=1000
    const stale = await addTabMedia(1, item('https://a.com/old.m3u8'), 500);
    expect(stale).toBeNull(); // request started at t=500 < 1000 -> discarded
    const fresh = await addTabMedia(1, item('https://a.com/new.m3u8'), 1500);
    expect(fresh).toBe(1); // request at t=1500 > 1000 -> accepted
    expect(await getTabMedia(1)).toHaveLength(1);
  });

  it('clear wipes the tab list', async () => {
    await addTabMedia(1, item('https://a.com/x.m3u8'));
    await clearTabMedia(1);
    expect(await getTabMedia(1)).toEqual([]);
  });
});

describe('preferredHeight setting (local)', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('defaults to null, set then read back', async () => {
    expect(await getPreferredHeight()).toBeNull();
    await setPreferredHeight(720);
    expect(await getPreferredHeight()).toBe(720);
  });
});

describe('allocateSpoofRuleId (per-download DNR rule id — W2.4)', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('each call allocates a DIFFERENT id, always >= the spoof range floor', async () => {
    // §2.10: the old id = hash(host), so two downloads on the same CDN collided on the same id ->
    // stealing each other's rule. Now each allocation returns a fresh id => two downloads never clash.
    const ids = [
      await allocateSpoofRuleId(),
      await allocateSpoofRuleId(),
      await allocateSpoofRuleId(),
    ];
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toBeGreaterThanOrEqual(SPOOF_RULE_ID_MIN);
  });

  it('the counter lives in storage.session (survives SW revival, not a global variable)', async () => {
    const first = await allocateSpoofRuleId();
    // Read storage.session directly: the counter MUST be persisted (MV3 SW is ephemeral, globals evaporate).
    const raw = await browser.storage.session.get('settings:dnrRuleCounter');
    expect(typeof raw['settings:dnrRuleCounter']).toBe('number');
    const second = await allocateSpoofRuleId();
    expect(second).toBe(first + 1);
  });

  it('id always falls within [MIN, MIN+SPAN) — never spills into another rule range', async () => {
    const id = await allocateSpoofRuleId();
    expect(id).toBeGreaterThanOrEqual(SPOOF_RULE_ID_MIN);
    expect(id).toBeLessThan(SPOOF_RULE_ID_MIN + SPOOF_RULE_ID_SPAN);
  });
});

describe('DownloadEntry — STABLE key by jobId (W2.5), chromeDownloadId appears at the SAVE phase', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('put then get back by string key; does NOT need a chrome downloadId at start (fetch happens in offscreen)', async () => {
    await putDownload({
      key: 'job-1',
      mediaUrl: 'https://cdn.example.com/v.mp4',
      filename: 'v.mp4',
      state: 'in_progress',
      spoofRuleIds: [2000],
    });
    const all = await getDownloads();
    expect(Object.keys(all)).toEqual(['job-1']);
    expect(all['job-1']!.chromeDownloadId).toBeUndefined();
    expect(all['job-1']!.spoofRuleIds).toEqual([2000]);
  });

  it('updateDownload MERGES by key, no old field is lost (spoofRuleIds stays intact when chromeDownloadId is attached)', async () => {
    await putDownload({
      key: 'job-1',
      mediaUrl: 'https://cdn.example.com/v.mp4',
      state: 'in_progress',
      spoofRuleIds: [2000, 2001],
    });
    // Save phase: offscreen finishes muxing -> background attaches the real chrome.downloads id to the same entry.
    await updateDownload('job-1', { chromeDownloadId: 42, blobUrl: 'blob:x' });
    const e = (await getDownloads())['job-1']!;
    expect(e.chromeDownloadId).toBe(42);
    expect(e.blobUrl).toBe('blob:x');
    expect(e.spoofRuleIds).toEqual([2000, 2001]);
    expect(e.state).toBe('in_progress');
  });

  it('getDownloadByChromeId looks up in reverse from the chrome id (used by downloads.onChanged)', async () => {
    await putDownload({
      key: 'job-1',
      mediaUrl: 'https://cdn.example.com/v.mp4',
      state: 'in_progress',
    });
    await putDownload({
      key: 'job-2',
      mediaUrl: 'https://cdn.example.com/w.mp4',
      state: 'in_progress',
      chromeDownloadId: 7,
    });
    const found = await getDownloadByChromeId(7);
    expect(found?.key).toBe('job-2');
    // No real id attached yet -> not found (correct: job-1 is still fresh in the fetch phase).
    expect(await getDownloadByChromeId(999)).toBeUndefined();
  });

  it('updateDownload on a nonexistent key -> minimal upsert (avoids losing state to an onChanged race)', async () => {
    await updateDownload('ghost', { state: 'complete' });
    const e = (await getDownloads())['ghost']!;
    expect(e.key).toBe('ghost');
    expect(e.state).toBe('complete');
  });
});

describe('W2.7 — a terminal phase is FINAL, cannot be revived', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  function job(patch: Partial<HlsJob> = {}): HlsJob {
    return {
      id: 'j1',
      mediaUrl: 'https://x/a.m3u8',
      variantUrl: 'https://x/v.m3u8',
      phase: 'fetching',
      segmentsTotal: 10,
      segmentsDone: 3,
      ...patch,
    };
  }

  it('a "cancelled" job is NOT pulled back to "loading" by offscreen', async () => {
    // Real scenario: user clicks Cancel -> background writes 'cancelled'; but runHlsJob in offscreen
    // is still mid-run and manages to overwrite it with 'loading' -> popup shows the job as cancelled
    // then spinning again. Confusing for the user.
    await putHlsJob(job({ phase: 'cancelled', error: 'Đã huỷ' }));
    await updateHlsJob('j1', { phase: 'loading' });
    expect((await getHlsJobs())['j1']!.phase).toBe('cancelled');
  });

  it('an "error" job is NOT pulled back to "fetching"', async () => {
    // Real W2.7 scenario: a tick finalizes a dead job; if offscreen revives late and keeps writing,
    // the spoof rule has already been cleaned up -> the job keeps running only to hit 403, and the
    // user gets a SECOND error more confusing than the first.
    await putHlsJob(
      job({ phase: 'error', error: 'Bộ xử lý video đã dừng đột ngột' }),
    );
    await updateHlsJob('j1', { phase: 'fetching', segmentsDone: 9 });
    const j = (await getHlsJobs())['j1']!;
    expect(j.phase).toBe('error');
    expect(j.error).toBe('Bộ xử lý video đã dừng đột ngột');
  });

  it('still allows writing OTHER fields on a terminal job (only phase + error are locked)', async () => {
    await putHlsJob(job({ phase: 'done' }));
    await updateHlsJob('j1', { filename: 'x.mp4' });
    const j = (await getHlsJobs())['j1']!;
    expect(j.filename).toBe('x.mp4');
    expect(j.phase).toBe('done');
  });

  it('a running job still changes phase normally (not wrongly locked)', async () => {
    await putHlsJob(job({ phase: 'fetching' }));
    await updateHlsJob('j1', { phase: 'muxing' });
    expect((await getHlsJobs())['j1']!.phase).toBe('muxing');
  });

  it('a running job can still transition into a terminal phase', async () => {
    await putHlsJob(job({ phase: 'fetching' }));
    await updateHlsJob('j1', { phase: 'done' });
    expect((await getHlsJobs())['j1']!.phase).toBe('done');
  });
});

// ── W4.3 ────────────────────────────────────────────────────────────────────

describe('settings:filenameTemplate', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('default is the template preserving the old behavior', async () => {
    expect(await getFilenameTemplate()).toBe('{title}{res}');
  });

  it('save then read back', async () => {
    await setFilenameTemplate('{title}');
    expect(await getFilenameTemplate()).toBe('{title}');
  });

  it('empty template -> falls back to default', async () => {
    await setFilenameTemplate('   ');
    expect(await getFilenameTemplate()).toBe('{title}{res}');
  });

  // 🔴 A template without {title}/{basename} collapses EVERY video onto the same name;
  // conflictAction 'uniquify' silently appends ' (1)', ' (2)'... so the user never sees an error —
  // just a pile of nameless files.
  it('a template that cannot distinguish videos -> rejected, falls back to default', async () => {
    await setFilenameTemplate('{date}');
    expect(await getFilenameTemplate()).toBe('{title}{res}');
  });
});

describe('W4.3 per-tab navUrl', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('resetTab records the new page navUrl', async () => {
    await resetTab(1, 100, 'https://a.com/p');
    expect((await getTabState(1)).navUrl).toBe('https://a.com/p');
  });

  it('setTabNavUrl only changes navUrl, does NOT touch items/navStartedAt', async () => {
    await resetTab(1, 100, 'https://a.com/p');
    await addTabMedia(1, item('https://a.com/v.m3u8'));
    await setTabNavUrl(1, 'https://a.com/q');
    const st = await getTabState(1);
    expect(st.navUrl).toBe('https://a.com/q');
    expect(st.navStartedAt).toBe(100);
    expect(st.items).toHaveLength(1);
  });

  // 🔴 PINS THE WIPEOUT TRAP: getTabState rebuilds an object literal, so any field not listed in it
  // gets swallowed by the next read-modify-write cycle. Symptom: downloading right away works, but
  // detecting one more piece of media loses the title. Current tsc/eslint/vitest see NONE of this.
  it('navUrl SURVIVES the next media write', async () => {
    await setTabNavUrl(1, 'https://a.com/q');
    await addTabMedia(1, item('https://a.com/v.m3u8'));
    expect((await getTabState(1)).navUrl).toBe('https://a.com/q');
  });

  it('a real navigation (resetTab without a URL) clears navUrl', async () => {
    await resetTab(1, 100, 'https://a.com/p');
    await resetTab(1, 200);
    expect((await getTabState(1)).navUrl).toBeUndefined();
  });

  // 🔴 This is the key to giving the sameDocument gate REAL data on the NETWORK detection path:
  // media captured via webRequest carries no page URL at all.
  it('new media is stamped with the page URL AT DETECTION TIME', async () => {
    await resetTab(1, 100, 'https://a.com/p');
    await addTabMedia(1, item('https://a.com/v.m3u8'));
    expect((await getTabMedia(1))[0]!.detectPageUrl).toBe('https://a.com/p');
  });

  // 🔴 THIS CASE USED TO LOCK IN A WRONG BEHAVIOR — an adversarial review caught it, now reversed.
  // The old version celebrated `detectPageUrl` being filled in on the MERGE branch. But filling it
  // in late = stamping page A's media with page B's URL: the same media URL is often reported again
  // AFTER the user has navigated within an SPA. At that point the sameDocument gate turns around and
  // CONFIRMS the wrong stamp -> video B's title ends up on video A's file. True, not stamping means
  // losing a nice title — but a missing title beats a WRONG one.
  it('does NOT backfill detectPageUrl late on the MERGE branch (the stamp belongs to the FIRST time)', async () => {
    await addTabMedia(1, item('https://a.com/v.m3u8'));
    expect((await getTabMedia(1))[0]!.detectPageUrl).toBeUndefined();
    await setTabNavUrl(1, 'https://b.com/khac');
    await addTabMedia(1, item('https://a.com/v.m3u8'));
    expect((await getTabMedia(1))[0]!.detectPageUrl).toBeUndefined();
  });

  it('does NOT overwrite an existing detectPageUrl', async () => {
    await resetTab(1, 100, 'https://a.com/p');
    await addTabMedia(
      1,
      item('https://a.com/v.m3u8', { detectPageUrl: 'https://b.com/' }),
    );
    expect((await getTabMedia(1))[0]!.detectPageUrl).toBe('https://b.com/');
  });
});
