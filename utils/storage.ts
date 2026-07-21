// Wraps chrome.storage for:
// - Per-tab media list (session): SOURCE OF TRUTH, not kept in an SW global variable.
// - Progressive download state (session): map keyed by a stable key (jobId), not chrome downloadId.
// - HLS job progress (session): map keyed by jobId.
// - Settings (local): preferred quality, download folder, size warning threshold.
// - Cache of the GitHub Releases update check (local): tag + link + last-checked time.

import type { MediaItem, MediaType } from './types';
import { markChildren, upsertMedia, visibleMedia } from './detect';
import { SPOOF_RULE_ID_MIN, SPOOF_RULE_ID_SPAN } from './dnr';
import { DEFAULT_FILENAME_TEMPLATE, isUsableTemplate } from './filename';

const MEDIA_KEY_PREFIX = 'media:';
const DOWNLOADS_KEY = 'downloads';
const HLS_JOBS_KEY = 'hlsjobs';
const PREFERRED_HEIGHT_KEY = 'settings:preferredHeight';
const DOWNLOAD_FOLDER_KEY = 'settings:downloadFolder';
const SIZE_WARN_KEY = 'settings:sizeWarnBytes';
const CONCURRENCY_KEY = 'settings:concurrency';
const ENABLED_TYPES_KEY = 'settings:enabledTypes';
const UPDATE_CHECK_KEY = 'settings:updateCheck';
const DNR_RULE_COUNTER_KEY = 'settings:dnrRuleCounter';
const FILENAME_TEMPLATE_KEY = 'settings:filenameTemplate';

// Serialize storage writes (downloads/hlsjobs) within one context to avoid read-modify-write races.
let writeChain: Promise<unknown> = Promise.resolve();
function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Default size warning threshold: 1.5 GB. */
export const DEFAULT_SIZE_WARN_BYTES = 1.5 * 1024 * 1024 * 1024;

export interface TabMediaState {
  /** epoch ms of the most recent main_frame navigation. */
  navStartedAt: number;
  /**
   * W4.3 — current page URL of the TOP FRAME. Set by `resetTab` (main_frame navigation) and by
   * `setTabNavUrl` (SPA navigation via `tabs.onUpdated`). `addTabMedia` stamps this value onto
   * `detectPageUrl` of each new media item, so downloading still knows which page the media was detected on.
   */
  navUrl?: string;
  items: MediaItem[];
  /**
   * W4.2 — child playlist URLs learned from this tab's already-parsed masters (child -> master).
   * MUST be PERSISTED rather than just flagged on the item: child playlists are often detected
   * AFTER the master finishes parsing, so a newly arriving item needs to look up this table to know it's a child.
   */
  childUrls?: Record<string, string>;
  /**
   * W4.2 — master already parsed, don't fetch again.
   * Lives in storage rather than a global variable: the MV3 service worker is ephemeral, a global
   * variable evaporates in between -> every SW revival would refetch every master of the tab.
   */
  parsedMasters?: string[];
  /**
   * W7.1 — this tab has been revealed to use DRM/EME (the page calls `requestMediaKeySystemAccess`,
   * or the stream fires an `'encrypted'` event). Hard boundary §7: on encounter, STOP and report clearly.
   *
   * The flag is set on the TAB rather than on each media item, because the EME signal comes from
   * `navigator`/`document` — it isn't tied to any particular URL. Cleared on navigation (`resetTab`): a new page invalidates it.
   */
  drmSystems?: string[];
}

function mediaKey(tabId: number): string {
  return `${MEDIA_KEY_PREFIX}${tabId}`;
}

/**
 * 🔴 EVERY new field of `TabMediaState` MUST be listed in the object literal below.
 *
 * Missing a line = the field gets written once then WIPED OUT by the next read-modify-write
 * (`addTabMedia` spreads `{...state}` from a state that already lost that field). Deceptive symptom: downloading
 * RIGHT AWAY works fine, but as soon as the page detects one more media item it's gone. tsc/eslint/vitest all
 * fail to catch it — `Partial<TabMediaState>` allows a missing field.
 */
export async function getTabState(tabId: number): Promise<TabMediaState> {
  const key = mediaKey(tabId);
  const res = await browser.storage.session.get(key);
  const val = res[key] as Partial<TabMediaState> | undefined;
  return {
    navStartedAt: typeof val?.navStartedAt === 'number' ? val.navStartedAt : 0,
    navUrl: val?.navUrl,
    items: Array.isArray(val?.items) ? val.items : [],
    childUrls: val?.childUrls ?? {},
    parsedMasters: Array.isArray(val?.parsedMasters) ? val.parsedMasters : [],
    drmSystems: Array.isArray(val?.drmSystems) ? val.drmSystems : [],
  };
}

export async function getTabMedia(tabId: number): Promise<MediaItem[]> {
  return (await getTabState(tabId)).items;
}

async function setTabState(tabId: number, state: TabMediaState): Promise<void> {
  await browser.storage.session.set({ [mediaKey(tabId)]: state });
}

export async function resetTab(
  tabId: number,
  navStartedAt: number,
  navUrl?: string,
): Promise<void> {
  await setTabState(tabId, { navStartedAt, navUrl, items: [] });
}

/**
 * W4.3 — update the tab's current page URL, WITHOUT touching `items`/`navStartedAt`.
 *
 * Used for SPA navigation (`pushState`): the page changes video WITHOUT any `main_frame`
 * request being generated, so `resetTab` never runs. Deliberately does not clear `items`: that's
 * `resetTab`'s job, and clearing it here would wipe the media list every time the page changes its query string.
 */
export async function setTabNavUrl(tabId: number, url: string): Promise<void> {
  const state = await getTabState(tabId);
  await setTabState(tabId, { ...state, navUrl: url });
}

/**
 * W7.1 — set the "this tab uses DRM/EME" flag (hard boundary §7). Returns `true` if this is NEW news.
 *
 * Deduplicated by system name and NOT repeated: `requestMediaKeySystemAccess` being called
 * repeatedly for the same vendor is normal (a player trying multiple codec configurations).
 */
export async function markTabDrm(
  tabId: number,
  systemName: string,
): Promise<boolean> {
  const state = await getTabState(tabId);
  const cur = state.drmSystems ?? [];
  if (cur.includes(systemName)) return false;
  await setTabState(tabId, { ...state, drmSystems: [...cur, systemName] });
  return true;
}

export async function clearTabMedia(tabId: number): Promise<void> {
  await browser.storage.session.remove(mediaKey(tabId));
}

export async function addTabMedia(
  tabId: number,
  item: MediaItem,
  requestStartedAt?: number,
): Promise<number | null> {
  const state = await getTabState(tabId);
  if (requestStartedAt !== undefined && requestStartedAt < state.navStartedAt) {
    return null;
  }
  // W4.2 — the master usually finishes parsing BEFORE the child playlist is detected, so a newly
  // arriving item must look itself up in the child table. Skipping this step means arrival order decides whether it gets hidden (race).
  const parent = state.childUrls?.[item.url];
  const withParent: MediaItem = parent
    ? { ...item, child: true, parentUrl: parent }
    : item;
  // W4.3 — stamp the page URL AT DETECTION TIME. Media caught via webRequest carries no page URL
  // at all, so without stamping here the `sameDocument` gate at download time has nothing to compare against.
  const incoming: MediaItem =
    withParent.detectPageUrl === undefined && state.navUrl
      ? { ...withParent, detectPageUrl: state.navUrl }
      : withParent;
  const { list, changed } = upsertMedia(state.items, incoming);
  if (!changed) return null;
  await setTabState(tabId, { ...state, items: list });
  // The badge counts what the user SEES. Counting child rows too would show "3" on the badge while the popup shows 1 row.
  return visibleMedia(list).length;
}

/**
 * W4.2 — claim the right to parse a master: `true` = nobody has parsed it yet, go parse it.
 *
 * Dedup MUST go through storage: the same URL gets reported twice, by `onBeforeRequest` and
 * `onHeadersReceived` (the second one merges in contentType so it's still `changed`), and with an
 * ephemeral SW a global variable can't survive long enough to remember. Without this, each master gets fetched twice or more.
 */
export async function claimMasterParse(
  tabId: number,
  url: string,
): Promise<boolean> {
  const state = await getTabState(tabId);
  if (state.parsedMasters?.includes(url)) return false;
  await setTabState(tabId, {
    ...state,
    parsedMasters: [...(state.parsedMasters ?? []), url],
  });
  return true;
}

/**
 * W4.2 — record the child playlists just learned from `parentUrl` + immediately hide any already in the list.
 * @returns the number of STILL-VISIBLE rows (to update the badge), or null if nothing changed.
 */
export async function addChildUrls(
  tabId: number,
  parentUrl: string,
  childUrls: readonly string[],
): Promise<number | null> {
  if (childUrls.length === 0) return null;
  const state = await getTabState(tabId);
  const map = { ...(state.childUrls ?? {}) };
  for (const u of childUrls) map[u] = parentUrl;
  const { list, changed } = markChildren(state.items, childUrls, parentUrl);
  await setTabState(tabId, { ...state, items: list, childUrls: map });
  return changed ? visibleMedia(list).length : null;
}

// --- Progressive download state (session), keyed by downloadId ---

export type DownloadState = 'in_progress' | 'complete' | 'interrupted';

export interface DownloadEntry {
  /**
   * W2.5 — STABLE KEY for the whole lifecycle (jobId UUID), does NOT change when transitioning from fetch(offscreen)->save.
   * Before W2.5 the key was the chrome.downloads id — but that id only exists AFTER the bytes finish
   * downloading; the new progressive path fetches bytes in offscreen FIRST so it needs a key independent of chrome.downloads.
   */
  key: string;
  mediaUrl: string;
  filename?: string;
  state: DownloadState;
  error?: string;
  /** blob URL (file obtained from offscreen: muxed HLS, or progressive fetch) -> revoked once the download finishes. */
  blobUrl?: string;
  /**
   * the REAL chrome.downloads id — ONLY present in the SAVE phase (after offscreen hands over the blob). downloads.onChanged
   * looks up the entry via this field; the popup uses it to cancel the save.
   */
  chromeDownloadId?: number;
  /** bytes received / total (progressive via offscreen) -> progress bar. */
  bytesReceived?: number;
  bytesTotal?: number;
  /** epoch ms at creation -> the popup picks the newest entry per mediaUrl (string keys aren't comparable). */
  startedAt?: number;
  /**
   * W2.7 — epoch ms of the LAST time background heard from offscreen about this download (heartbeat).
   * ONLY meaningful during the FETCH phase; once `chromeDownloadId` exists, chrome.downloads takes over
   * and this field stops being checked (see `findDeadDownloads`).
   */
  lastSeenAt?: number;
  /**
   * W2.4 — id of the spoof session rule applied to this download (a SEPARATE id per download, not derived from the host).
   * Saved so the right rule gets removed once the download finishes, without stealing another download's rule on the same host.
   */
  spoofRuleIds?: number[];
}

export async function getDownloads(): Promise<Record<string, DownloadEntry>> {
  const res = await browser.storage.session.get(DOWNLOADS_KEY);
  const v = res[DOWNLOADS_KEY];
  return v && typeof v === 'object' ? (v as Record<string, DownloadEntry>) : {};
}

export async function putDownload(entry: DownloadEntry): Promise<void> {
  await serializeWrite(async () => {
    const all = await getDownloads();
    // Merge (not a hard overwrite) so an onChanged patch isn't lost if it ran first.
    all[entry.key] = { ...all[entry.key], ...entry };
    await browser.storage.session.set({ [DOWNLOADS_KEY]: all });
  });
}

export async function updateDownload(
  key: string,
  patch: Partial<DownloadEntry>,
): Promise<void> {
  await serializeWrite(async () => {
    const all = await getDownloads();
    const cur = all[key];
    // Upsert: if the entry doesn't exist yet (onChanged raced ahead of putDownload) create a minimal
    // one, to avoid losing state that would leave the popup stuck on "Downloading…".
    const base: DownloadEntry = cur ?? {
      key,
      mediaUrl: '',
      state: 'in_progress',
    };
    all[key] = { ...base, ...patch };
    await browser.storage.session.set({ [DOWNLOADS_KEY]: all });
  });
}

/** Look up an entry by chrome.downloads id (used in downloads.onChanged). undefined if no id attached yet. */
export async function getDownloadByChromeId(
  id: number,
): Promise<DownloadEntry | undefined> {
  return Object.values(await getDownloads()).find(
    (d) => d.chromeDownloadId === id,
  );
}

// --- HLS job progress (session), keyed by jobId ---

// 'queued'  = background has created the job and SENT it to offscreen, offscreen has NOT received it yet (or it's queued).
// 'loading' = offscreen HAS received the work and started running (fetching the playlist + loading ffmpeg in parallel).
// Splitting these 2 phases is DELIBERATE: merging them into one would make a "stuck job" indistinguishable
// from a dropped message vs. a hung playlist — a real case that burned 2 hours of debugging without a single clue.
export type HlsPhase =
  | 'queued'
  | 'loading'
  | 'fetching'
  | 'muxing'
  | 'saving'
  | 'done'
  | 'error'
  | 'cancelled';

export interface HlsJob {
  id: string;
  mediaUrl: string;
  variantUrl: string;
  phase: HlsPhase;
  segmentsTotal: number;
  segmentsDone: number;
  error?: string;
  /**
   * W2.6 — TEMPORARY note shown under the progress bar ("retrying 2/4…").
   * NOT an error: the job is still running. With this, a minute of waiting on retry no longer looks like a hang.
   */
  note?: string;
  /**
   * W2.7 — epoch ms of the LAST time background heard from offscreen about this job (heartbeat).
   *
   * 🔴 Stamped by BACKGROUND, NOT offscreen: a single clock means no clock skew between the two
   * contexts, and if offscreen dies the stamp naturally stops advancing — exactly what we want to measure.
   * Missing this field (job created before this upgrade) = CANNOT conclude it's dead (see `findDeadHlsJobs`).
   */
  lastSeenAt?: number;
  filename?: string;
  // NEW (detailed progress):
  /** tab where the media was detected -> background sets the badge % on the right tab. */
  tabId?: number;
  /** epoch ms when entering 'fetching' -> popup computes speed/ETA. */
  startedAt?: number;
  /** total segment bytes downloaded -> computes MB/s. */
  bytesDownloaded?: number;
  /** estimated size (bandwidth × duration) -> fallback. */
  bytesTotal?: number;
  /** mux/remux progress 0..1 from the ffmpeg progress event. */
  muxProgress?: number;
  /**
   * W2.4 — ids of every spoof session rule applied to this job (one id per host: video + audio +
   * segment/key/init on a different host each). Saved so it can be CLEANED UP on EVERY terminal branch
   * (done/error/cancelled): a DNR session rule lives for the whole session (§2.10), leftover ones are litter.
   * The success branch also does extra cleanup in handleBlobDownload.
   * (Before W2.4 this stored `spoofHosts: string[]` then hashed it into an id — now the id is the direct source of truth.)
   */
  spoofRuleIds?: number[];
}

/** TERMINAL phase — cannot be reverted (see `updateHlsJob`). */
const TERMINAL_HLS_PHASES = new Set<HlsPhase>(['done', 'error', 'cancelled']);

export async function getHlsJobs(): Promise<Record<string, HlsJob>> {
  const res = await browser.storage.session.get(HLS_JOBS_KEY);
  const v = res[HLS_JOBS_KEY];
  return v && typeof v === 'object' ? (v as Record<string, HlsJob>) : {};
}

export async function putHlsJob(job: HlsJob): Promise<void> {
  await serializeWrite(async () => {
    const all = await getHlsJobs();
    all[job.id] = { ...all[job.id], ...job };
    await browser.storage.session.set({ [HLS_JOBS_KEY]: all });
  });
}

export async function updateHlsJob(
  id: string,
  patch: Partial<HlsJob>,
): Promise<void> {
  await serializeWrite(async () => {
    const all = await getHlsJobs();
    const cur = all[id];
    if (!cur) return;
    const next = { ...cur, ...patch };
    // W2.7 — A TERMINAL PHASE IS FINAL. Once a job is done/error/cancelled, nobody is allowed to
    // pull it back to a running phase. Two real cases this plugs:
    //   1. User clicks Cancel -> background writes 'cancelled', but runHlsJob still running in
    //      offscreen manages to write 'loading' over it -> the popup shows the job cancelled then spinning again.
    //   2. The W2.7 tick declares the job dead + CLEANS UP the spoof rule; if the job revives late
    //      it keeps running without a rule -> 403 -> the user gets a SECOND ERROR more confusing than the first.
    // Only locks `phase` + `error` (the first reason is the CORRECT one); other fields still write normally.
    if (TERMINAL_HLS_PHASES.has(cur.phase)) {
      next.phase = cur.phase;
      next.error = cur.error;
    }
    all[id] = next;
    await browser.storage.session.set({ [HLS_JOBS_KEY]: all });
  });
}

// --- DNR spoof rule id (session), allocated via a counter — W2.4 ---

/**
 * Allocate a NEW DNR rule id for each spoof (one id per download×host pair).
 *
 * Why NOT hash(host) as before: two downloads on the same CDN would collide on id -> whichever
 * finishes first deletes the rule of the one still running -> 403 mid-download (§2.10). A counter
 * gives a DIFFERENT id every time so they never collide.
 *
 * The counter lives in `chrome.storage.session` (NOT a global variable): the MV3 SW is ephemeral, a
 * global variable evaporates in between -> the id would restart from 0 and collide. Session storage
 * survives SW revival but resets on browser restart (exactly when session rules are also cleared) -> the id starts clean again.
 * Goes through serializeWrite so the counter's read-modify-write isn't raced by concurrent allocations.
 */
export async function allocateSpoofRuleId(): Promise<number> {
  return serializeWrite(async () => {
    const res = await browser.storage.session.get(DNR_RULE_COUNTER_KEY);
    const raw = res[DNR_RULE_COUNTER_KEY];
    const cur = typeof raw === 'number' && raw >= 0 ? raw : 0;
    const next = (cur + 1) % SPOOF_RULE_ID_SPAN;
    await browser.storage.session.set({ [DNR_RULE_COUNTER_KEY]: next });
    return SPOOF_RULE_ID_MIN + cur;
  });
}

// --- Settings (local) ---

export async function getPreferredHeight(): Promise<number | null> {
  const res = await browser.storage.local.get(PREFERRED_HEIGHT_KEY);
  const v = res[PREFERRED_HEIGHT_KEY];
  return typeof v === 'number' ? v : null;
}

export async function setPreferredHeight(height: number): Promise<void> {
  await browser.storage.local.set({ [PREFERRED_HEIGHT_KEY]: height });
}

export async function getDownloadFolder(): Promise<string> {
  const res = await browser.storage.local.get(DOWNLOAD_FOLDER_KEY);
  const v = res[DOWNLOAD_FOLDER_KEY];
  return typeof v === 'string' ? v : '';
}

export async function setDownloadFolder(folder: string): Promise<void> {
  await browser.storage.local.set({ [DOWNLOAD_FOLDER_KEY]: folder });
}

/**
 * W4.3 — filename template.
 *
 * The getter VALIDATES rather than returning the stored value directly: a template missing
 * `{title}`/`{basename}` would collapse EVERY video onto the same name, and `conflictAction: 'uniquify'`
 * silently appends ' (1)', ' (2)'... so the user never sees an error — just a folder full of anonymous files. Better to fall back to the default.
 */
export async function getFilenameTemplate(): Promise<string> {
  const res = await browser.storage.local.get(FILENAME_TEMPLATE_KEY);
  const v = res[FILENAME_TEMPLATE_KEY];
  return typeof v === 'string' && isUsableTemplate(v)
    ? v.trim()
    : DEFAULT_FILENAME_TEMPLATE;
}

export async function setFilenameTemplate(template: string): Promise<void> {
  await browser.storage.local.set({ [FILENAME_TEMPLATE_KEY]: template });
}

/** Threshold (bytes) for the size warning before downloading HLS. */
export async function getSizeWarnBytes(): Promise<number> {
  const res = await browser.storage.local.get(SIZE_WARN_KEY);
  const v = res[SIZE_WARN_KEY];
  return typeof v === 'number' && v > 0 ? v : DEFAULT_SIZE_WARN_BYTES;
}

export async function setSizeWarnBytes(bytes: number): Promise<void> {
  await browser.storage.local.set({ [SIZE_WARN_KEY]: bytes });
}

/** Number of concurrent segment fetch threads (1..16). Default 6. */
export const DEFAULT_CONCURRENCY = 6;

export async function getConcurrency(): Promise<number> {
  const res = await browser.storage.local.get(CONCURRENCY_KEY);
  const v = res[CONCURRENCY_KEY];
  return typeof v === 'number' && v >= 1 && v <= 16 ? v : DEFAULT_CONCURRENCY;
}

export async function setConcurrency(n: number): Promise<void> {
  await browser.storage.local.set({ [CONCURRENCY_KEY]: n });
}

/** Show/hide by media type. */
export type EnabledTypes = Record<MediaType, boolean>;

export const DEFAULT_ENABLED_TYPES: EnabledTypes = {
  hls: true,
  dash: true,
  progressive: true,
  blob: true,
};

export async function getEnabledTypes(): Promise<EnabledTypes> {
  const res = await browser.storage.local.get(ENABLED_TYPES_KEY);
  const v = res[ENABLED_TYPES_KEY];
  return v && typeof v === 'object'
    ? { ...DEFAULT_ENABLED_TYPES, ...(v as Partial<EnabledTypes>) }
    : { ...DEFAULT_ENABLED_TYPES };
}

export async function setEnabledTypes(types: EnabledTypes): Promise<void> {
  await browser.storage.local.set({ [ENABLED_TYPES_KEY]: types });
}

/** Update check cache TTL: 6 hours (GitHub limits 60 requests/hour/IP). */
export const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Cached GitHub Releases check result.
 * Stores the RAW TAG rather than an "update available" flag: it must be compared against the
 * running version at render time, otherwise the banner would keep showing after the user has already updated (until the TTL expires).
 */
export interface UpdateCheck {
  /** GitHub tag, in the form "v0.6.0". */
  latestTag: string;
  /** Release page link to open for the user to download manually. */
  releaseUrl: string;
  /** epoch ms when the API call succeeded. */
  checkedAt: number;
}

export async function getUpdateCheck(): Promise<UpdateCheck | null> {
  const res = await browser.storage.local.get(UPDATE_CHECK_KEY);
  const v = res[UPDATE_CHECK_KEY] as Partial<UpdateCheck> | undefined;
  if (
    typeof v?.latestTag !== 'string' ||
    typeof v?.releaseUrl !== 'string' ||
    typeof v?.checkedAt !== 'number'
  ) {
    return null; // missing/corrupt -> treat as not-yet-checked, will call the API again.
  }
  // Value comes from the network and will be opened via tabs.create -> only accept github.com links.
  if (!v.releaseUrl.startsWith('https://github.com/')) return null;
  return {
    latestTag: v.latestTag,
    releaseUrl: v.releaseUrl,
    checkedAt: v.checkedAt,
  };
}

export async function setUpdateCheck(check: UpdateCheck): Promise<void> {
  await browser.storage.local.set({ [UPDATE_CHECK_KEY]: check });
}
