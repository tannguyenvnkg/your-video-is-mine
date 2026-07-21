import {
  buildMediaItem,
  mediaId,
  visibleMedia,
  type BuildMediaInput,
} from '@/utils/detect';
import { describeError } from '@/utils/errors';
import { DRM_UNSUPPORTED_ERROR, drmNameFromKeySystem } from '@/utils/drm';
import { buildDownloadFilename } from '@/utils/filename';
import { pickTitle, sameDocument } from '@/utils/title';
import {
  DEAD_OFFSCREEN_ERROR,
  HEARTBEAT_TIMEOUT_MS,
  findDeadDownloads,
  findDeadHlsJobs,
  singleFlight,
} from '@/utils/liveness';
import {
  addChildUrls,
  addTabMedia,
  allocateSpoofRuleId,
  claimMasterParse,
  clearTabMedia,
  getConcurrency,
  getDownloadByChromeId,
  getDownloadFolder,
  getDownloads,
  getFilenameTemplate,
  getHlsJobs,
  getTabMedia,
  getTabState,
  markTabDrm,
  putDownload,
  putHlsJob,
  resetTab,
  setTabNavUrl,
  updateDownload,
  updateHlsJob,
  type DownloadEntry,
  type DownloadState,
  type HlsJob,
  type HlsPhase,
} from '@/utils/storage';
import {
  childUrlsOfMaster,
  parseHlsManifest,
  spoofTargetsFromSegments,
} from '@/utils/hls';
import { parseDashManifest, parseTrackSegments } from '@/utils/dash';
import {
  buildRefererSpoofRule,
  hasConflictingSensitiveRule,
  hostFromUrl,
  originFromUrl,
  staleSpoofRuleIds,
  type DnrRule,
  buildHeaderSpoofRule,
} from '@/utils/dnr';
import {
  capturedFromHeaderList,
  filterCapturable,
  planHeaderReplay,
  shouldCaptureRequest,
  stripSensitive,
} from '@/utils/headers';
import type { MediaItem } from '@/utils/types';
import type {
  DownloadProgressResponse,
  DownloadStartResponse,
  EngineSelfTestResponse,
  HlsDownloadResponse,
  HlsEstimateResponse,
  HlsProgressResponse,
  ManifestKind,
  RuntimeMessage,
  VariantsResponse,
} from '@/utils/messages';

// Terminal phase of an HLS job (done/error/cancelled) — used for both the badge and spoof-rule reconciliation.
const TERMINAL_PHASES = new Set<HlsPhase>(['done', 'error', 'cancelled']);

export default defineBackground(() => {
  // Serialize storage writes to avoid a read-modify-write race between multiple events.
  // TEMPORARY coordination within one SW lifetime; chrome.storage.session is the SOURCE OF TRUTH.
  let writeChain: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function updateBadge(tabId: number, count: number): Promise<void> {
    try {
      await browser.action.setBadgeText({
        tabId,
        text: count > 0 ? String(count) : '',
      });
      await browser.action.setBadgeBackgroundColor({ tabId, color: '#2f6feb' });
    } catch {
      // tab may have already closed.
    }
  }

  async function recordMedia(
    input: BuildMediaInput,
    requestStartedAt?: number,
  ): Promise<void> {
    if (input.tabId < 0) return;
    const item = buildMediaItem(input);
    if (!item) return;
    try {
      await serialize(async () => {
        const count = await addTabMedia(input.tabId, item, requestStartedAt);
        if (count !== null) await updateBadge(input.tabId, count);
      });
    } catch {
      // best-effort.
    }
    // W4.2 — any .m3u8 could be a master; the only way to know its children is to read it.
    if (item.type === 'hls') void learnMasterChildren(input.tabId, item.url);
  }

  /**
   * W4.2 — read a master to learn its child playlists, then hide the child rows from the popup.
   *
   * MEASURED IN REAL LIFE (Edge + extension, audio-split fixture): one video = 3 identical "HLS"
   * rows (master + video.m3u8 + audio.m3u8) because webRequest sees every .m3u8 request the player makes.
   *
   * Why RE-FETCH the master (the player just fetched it): a request's body cannot be read from MV3
   * webRequest — that's an API limitation, not a choice. This fetch usually hits the browser's HTTP
   * cache. Fully best-effort: 403/network failure -> nothing learned -> popup falls back to the old
   * behavior (shows all 3 rows), NEVER blocks the download path.
   * ⚠️ This function does not yet spoof Referer (§2.3, left for W2.2 to fix) -> on an anti-hotlink
   * site it will 403 and W4.2 silently has no effect. That's a KNOWN limitation, not a hidden bug.
   */
  async function learnMasterChildren(
    tabId: number,
    url: string,
  ): Promise<void> {
    try {
      // Already known to be a child of another master -> definitely not a master -> skip the fetch.
      const state = await getTabState(tabId);
      if (state.childUrls?.[url]) return;
      // Claim BEFORE fetching: the same URL is reported twice, by onBeforeRequest and
      // onHeadersReceived — without claiming it we'd fetch twice.
      if (!(await serialize(() => claimMasterParse(tabId, url)))) return;

      // W2.1 debt (b) — replay the player's REAL Referer/Origin for this master, but NOT its token.
      // Previously this fetch was bare (fabricated Referer from pageUrl, plus a fabricated Origin),
      // so on a hotlink site the master 403'd and W4.2 (hiding child renditions) was dead code
      // exactly where it was needed. Passing `captured` uses the real request's Referer/Origin,
      // which correctly OMIT Origin when the page never sent one — dodging the §2.11 trap where a
      // fabricated Origin makes the anti-403 rule self-cause a 403.
      //
      // 🔴 forceStripSensitive: drop the token from THIS background fetch. MEASURED (e2e
      // dual-host-different-token): if learnMasterChildren replays a token, its transient sensitive
      // rule can still be alive when a DIFFERENT asset's real download starts on the same host —
      // that download sees a value-conflict and suppresses its OWN (correct) token, then 403s. A
      // best-effort child-hiding fetch must never be able to kill a real download. Referer/Origin
      // is enough for the common hotlink gate; a master that truly needs a token just won't be
      // learned (best-effort). No capture -> fall back to a fabricated Referer/Origin from pageUrl;
      // that fallback still sets an Origin the page may not have sent (a §2.11 residue), but it only
      // affects best-effort child-hiding here, never a real download.
      const pageUrl = await pageUrlFor(tabId, url);
      const captured = await capturedFor(tabId, url);
      const res = await withSpoofedFetch(
        url,
        pageUrl,
        () => fetch(url, { credentials: 'include' }),
        captured,
        /* forceStripSensitive */ true,
      );
      if (!res.ok) return;
      const children = childUrlsOfMaster(
        parseHlsManifest(await res.text(), url),
      );
      if (children.length === 0) return; // media playlist -> no children.
      const count = await serialize(() => addChildUrls(tabId, url, children));
      if (count !== null) await updateBadge(tabId, count);
    } catch {
      // best-effort: hiding duplicate rows is a nicety, it must never break detection.
    }
  }

  // Record blob/MSE media (blob: URL doesn't go through classify -> create a 'blob' type item directly).
  async function recordBlobMedia(input: {
    url: string;
    tabId: number;
    pageUrl?: string;
    title?: string;
  }): Promise<void> {
    if (input.tabId < 0) return;
    const item: MediaItem = {
      id: mediaId(input.url),
      type: 'blob',
      url: input.url,
      tabId: input.tabId,
      pageUrl: input.pageUrl,
      title: input.title,
      detectedAt: Date.now(),
      detectSource: 'mse',
    };
    try {
      await serialize(async () => {
        const count = await addTabMedia(input.tabId, item);
        if (count !== null) await updateBadge(input.tabId, count);
      });
    } catch {
      // best-effort.
    }
  }

  // Record a disguised HLS/DASH manifest (content script sniffed it from the body). The URL may
  // carry a fake extension (.jpg) so it does NOT go through classifyMedia -> create an 'hls'/'dash'
  // type item DIRECTLY using the received mediaType.
  async function recordManifestMedia(input: {
    url: string;
    mediaType: ManifestKind;
    tabId: number;
    pageUrl?: string;
    title?: string;
  }): Promise<void> {
    if (input.tabId < 0) return;
    const item: MediaItem = {
      id: mediaId(input.url),
      type: input.mediaType,
      url: input.url,
      tabId: input.tabId,
      pageUrl: input.pageUrl,
      title: input.title,
      detectedAt: Date.now(),
      detectSource: 'network',
    };
    try {
      await serialize(async () => {
        const count = await addTabMedia(input.tabId, item);
        if (count !== null) await updateBadge(input.tabId, count);
      });
    } catch {
      // best-effort.
    }
  }

  const filter = { urls: ['<all_urls>'] };

  browser.webRequest.onBeforeRequest.addListener((details): undefined => {
    if (details.type === 'main_frame' && details.tabId >= 0) {
      const navAt = details.timeStamp;
      void serialize(async () => {
        await resetTab(details.tabId, navAt, details.url);
        await updateBadge(details.tabId, 0);
      });
      return undefined;
    }
    void recordMedia(
      {
        url: details.url,
        tabId: details.tabId,
        detectedAt: Date.now(),
        detectSource: 'network',
      },
      details.timeStamp,
    );
    return undefined;
  }, filter);

  browser.webRequest.onHeadersReceived.addListener(
    (details): undefined => {
      let contentType: string | undefined;
      let size: number | undefined;
      let acceptRanges: boolean | undefined;
      for (const h of details.responseHeaders ?? []) {
        const name = h.name.toLowerCase();
        if (name === 'content-type') {
          contentType = h.value;
        } else if (name === 'content-length' && h.value) {
          const n = Number(h.value);
          size = Number.isFinite(n) ? n : undefined;
        } else if (name === 'accept-ranges' && h.value) {
          acceptRanges = h.value.toLowerCase() !== 'none';
        }
      }
      void recordMedia(
        {
          url: details.url,
          contentType,
          tabId: details.tabId,
          size,
          acceptRanges,
          detectedAt: Date.now(),
          detectSource: 'network',
        },
        details.timeStamp,
      );
      return undefined;
    },
    filter,
    ['responseHeaders'],
  );

  /**
   * W2.1 — CAPTURE the REAL headers the page's player sends, to REPLAY later instead of FABRICATING them (§2.11).
   *
   * `extraHeaders` is REQUIRED: without it Chrome hides Cookie/Referer/Origin from the listener.
   * Measured in real Edge — with `extraHeaders` we see the full `Referer`, `Cookie`, `X-Playback-Session-Id`.
   *
   * WHY GO THROUGH `recordMedia` instead of keeping a separate Map: the roadmap suggested "a
   * requestId -> headers Map with TTL sweeping", but the MV3 service worker is EPHEMERAL — a global
   * variable dies with the SW and the capture would evaporate right before the user clicks download
   * (exactly the kind of silent failure that has killed this project 3 times). Going through
   * `recordMedia` puts the capture straight into `chrome.storage.session` alongside the MediaItem: it
   * survives SW death, cleans up per-tab automatically, and obeys the navigation epoch automatically.
   * No TTL needed, no Map needed.
   *
   * Free garbage filtering: `buildMediaItem` returns null for non-media URLs, so segments/images/scripts
   * don't produce any record — only manifests & media files get their headers stored.
   */
  browser.webRequest.onSendHeaders.addListener(
    (details): undefined => {
      if (!shouldCaptureRequest(details, browser.runtime.id)) return undefined;
      // Filter RIGHT AT CAPTURE TIME: Cookie and friends must never be replayed, so don't store them
      // in storage.session (this listener runs on <all_urls>, before the user has clicked download at all).
      const sentHeaders = filterCapturable(
        capturedFromHeaderList(details.requestHeaders ?? []),
      );
      if (Object.keys(sentHeaders).length === 0) return undefined;
      void recordMedia(
        {
          url: details.url,
          tabId: details.tabId,
          detectedAt: Date.now(),
          detectSource: 'network',
          sentHeaders,
        },
        details.timeStamp,
      );
      return undefined;
    },
    filter,
    ['requestHeaders', 'extraHeaders'],
  );

  // Message router.
  //
  // CONTRACT: return `true` SYNCHRONOUSLY for every async branch, then call `sendResponse` later.
  // ABSOLUTELY DO NOT return a Promise: that's the webextension-polyfill contract (this project does
  // NOT use it). Chrome only accepts a Promise from build 148 onward, and that's still "rolling out
  // gradually" -> the dev machine (Edge 150) runs fine while an older user machine gets back
  // `undefined` — NOT a bug, so the `catch` in utils/messages.ts never fires: the popup just silently
  // receives undefined and then blows up elsewhere.
  // Chrome docs: `return true` runs "whether this capability is enabled or not".
  // Pinned by tests/background-messaging.test.ts (do NOT put tests in entrypoints/ — WXT treats every
  // file there as an entrypoint and `pnpm build` will die from a name collision). The listener must
  // NOT be `async`: an `async` function ALWAYS returns a Promise, which reintroduces this exact bug
  // silently — tsc/lint won't flag it.
  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      sender,
      sendResponse: (response?: unknown) => void,
    ): true | undefined => {
      if (isOffscreenTargeted(message)) return undefined;
      if (!isRuntimeMessage(message)) return undefined;

      // Keep the channel open and respond once the promise settles. The handler catches its own
      // errors and returns {ok:false}, but a reject branch is still required: missing an unexpected
      // error would leave the popup spinning forever.
      const respond = (p: Promise<unknown>): true => {
        void p
          .then(
            (res) => sendResponse(res),
            (e: unknown) =>
              sendResponse({ ok: false, error: describeError(e) }),
          )
          // Channel already closed (user closed the popup mid-flight) -> sendResponse throws.
          // Nothing to do about it, but it must not become an unhandled rejection.
          .catch(() => undefined);
        return true;
      };

      if (message.kind === 'manifest/variants') {
        return respond(
          handleVariants(message.url, message.mediaType, message.tabId),
        );
      }
      if (message.kind === 'download/progressive') {
        return respond(handleDownload(message.url, message.tabId));
      }
      if (message.kind === 'engine/selftest') {
        return respond(handleEngineSelfTest());
      }
      if (message.kind === 'hls/estimate') {
        return respond(
          handleHlsEstimate(
            message.variantUrl,
            message.bandwidth,
            message.audioUrl,
            message.tabId,
            message.mediaType,
            message.variantId,
            message.audioId,
          ),
        );
      }
      if (message.kind === 'hls/download') {
        return respond(
          handleHlsDownload(
            message.variantUrl,
            message.mediaUrl,
            message.tabId,
            message.height,
            message.audioUrl,
            message.mediaType,
            message.variantId,
            message.audioId,
          ),
        );
      }
      // Offscreen reports progress -> background writes it to storage.session on its behalf.
      // ACK so offscreen can `await` it: this keeps updates in the CORRECT ORDER and write errors
      // don't vanish into nothing. This ACK MUST go through `respond` — returning a Promise directly
      // here resolves to `undefined` IMMEDIATELY on Chrome <148, and storage write order silently breaks.
      if (message.kind === 'hls/progress') {
        // W2.7 — EVERY message from offscreen is a heartbeat: hearing from it means it's still alive.
        // Stamp it with the BACKGROUND's clock (a single clock -> no time drift between the two
        // contexts, and if offscreen dies the stamp naturally stops advancing).
        return respond(
          updateHlsJob(message.jobId, {
            ...message.patch,
            lastSeenAt: Date.now(),
          }).then((): HlsProgressResponse => ({ ok: true })),
        );
      }
      if (message.kind === 'download/blob') {
        void handleBlobDownload(
          message.blobUrl,
          message.filename,
          message.mediaUrl,
          message.tabId,
          message.jobId,
          message.spoofRuleIds,
          message.downloadKey,
        );
        return undefined;
      }
      // W2.5 — offscreen reports progressive fetch progress/errors; background writes it on its
      // behalf (offscreen has no chrome.storage). ACK via respond to keep update order CORRECT
      // (same reasoning as hls/progress).
      if (message.kind === 'download/progress') {
        const { key, patch } = message;
        // W2.7 — same as hls/progress: any message from offscreen is proof it's still alive.
        return respond(
          updateDownload(key, { ...patch, lastSeenAt: Date.now() }).then(
            async (): Promise<DownloadProgressResponse> => {
              // Fetch FAILED (403 mid-way / network) -> handleBlobDownload will NEVER run, so this
              // round's spoof rule will LEAK for the rest of the session unless removed here (same bug class as W2.4).
              if (patch.state === 'interrupted') {
                const e = (await getDownloads())[key];
                if (e?.spoofRuleIds?.length)
                  await removeSpoofRules(e.spoofRuleIds);
              }
              return { ok: true };
            },
          ),
        );
      }
      if (message.kind === 'hls/cancel') {
        // W2.7 — BEFORE: fired the message and wrote 'cancelled' IMMEDIATELY, without waiting for
        // anything. If the message dropped (offscreen dead/not yet registered its listener) the popup
        // reported "Cancelled" while the job KEPT RUNNING and still downloaded the file — literally
        // lying to the user. NOW: only finalize once offscreen confirms receipt.
        const jobId = message.jobId;
        void (async () => {
          const delivered = await sendToOffscreen({
            kind: 'hls/cancel',
            jobId,
          });
          if (delivered) {
            await updateHlsJob(jobId, { phase: 'cancelled', error: 'Đã huỷ' });
            return;
          }
          // Offscreen did NOT receive it -> it's dead, meaning the job died along with it (all the
          // download work lives there). Still must finalize to a terminal state, otherwise the job
          // stays stuck in 'fetching' forever — but state the REAL reason, don't pretend it was a clean cancel.
          await updateHlsJob(jobId, {
            phase: 'cancelled',
            error: 'Đã huỷ (bộ xử lý video đã dừng trước đó).',
          });
        })();
        return undefined;
      }
      if (message.kind === 'download/cancel') {
        void handleDownloadCancel(message.key);
        return undefined;
      }

      const tabId = sender.tab?.id ?? -1;
      if (tabId < 0) return undefined;

      if (message.kind === 'media/dom') {
        const pageUrl = sender.tab?.url;
        const title = sender.tab?.title;
        for (const c of message.candidates) {
          void recordMedia({
            url: c.url,
            contentType: c.contentTypeHint ?? null,
            tabId,
            pageUrl,
            title,
            detectedAt: Date.now(),
            detectSource: 'dom',
          });
        }
      }
      // W7.1 — page requests DRM/EME -> flag the tab (hard boundary §7). Does NOT block the page from
      // playing the video: we only refuse to DOWNLOAD, never break the viewing experience.
      if (message.kind === 'media/drm') {
        const name = drmNameFromKeySystem(message.keySystem) ?? 'DRM không rõ';
        // 🔴 MUST go through `serialize`: this is a read-modify-write on the SAME storage key as
        // `setTabNavUrl` (W4.3, fires on every URL change). Without queuing, the two writers overwrite
        // each other and the DRM flag can get WIPED -> the §7 hard boundary breaks with no error at all.
        void serialize(() => markTabDrm(tabId, name)).then((isNew) => {
          if (isNew) console.warn(`[bg] W7.1: tab ${tabId} dùng DRM (${name})`);
        });
      }
      if (message.kind === 'media/mse') {
        void recordBlobMedia({
          url: message.url,
          tabId,
          pageUrl: sender.tab?.url,
          title: sender.tab?.title,
        });
      }
      if (message.kind === 'media/manifest') {
        void recordManifestMedia({
          url: message.url,
          mediaType: message.mediaType,
          tabId,
          pageUrl: sender.tab?.url,
          title: sender.tab?.title,
        });
      }
      return undefined;
    },
  );

  // Watch the SAVE state (chrome.downloads) -> update storage + revoke the blob URL when done.
  // W2.5: DownloadEntry is keyed by jobId, so look up the entry BACKWARDS via chromeDownloadId
  // (delta.id is chrome's own id, not our key). An entry only has chromeDownloadId during the SAVE
  // phase, so the lookup is guaranteed to succeed here.
  browser.downloads.onChanged.addListener((delta) => {
    void (async () => {
      const entry = await getDownloadByChromeId(delta.id);
      if (!entry) return; // not our download (or the id wasn't attached yet — an early onChanged will just be skipped).
      const patch: Partial<DownloadEntry> = {};
      if (delta.state) patch.state = delta.state.current as DownloadState;
      if (delta.error?.current) patch.error = delta.error.current;
      if (delta.filename?.current) patch.filename = delta.filename.current;
      if (Object.keys(patch).length > 0) await updateDownload(entry.key, patch);

      const finished =
        delta.state?.current === 'complete' ||
        delta.state?.current === 'interrupted';
      if (finished) {
        // W2.7 — via the helper: if offscreen is dead, the blob URL died with it, so there's nothing
        // to revoke and this must not leave an unhandled rejection either.
        if (entry.blobUrl)
          void sendToOffscreen({ kind: 'revoke', url: entry.blobUrl });
        // Remove the session spoof rule for this download (don't let it persist the whole session).
        // W2.4: tracked by its own id. (Progressive already removes it in handleBlobDownload once the
        // fetch is done; doing it again here is harmless.)
        if (entry.spoofRuleIds?.length)
          void removeSpoofRules(entry.spoofRuleIds);
      }
    })();
  });

  // --- HLS progress -> icon badge % + notification on done/error (v0.5.0) ---

  // Aggregate % shown on the badge, based on phase.
  function jobBadgePct(job: HlsJob): number {
    if (job.phase === 'fetching') {
      return job.segmentsTotal > 0
        ? Math.min(99, Math.round((job.segmentsDone / job.segmentsTotal) * 100))
        : 0;
    }
    if (job.phase === 'muxing') {
      return Math.min(99, Math.round((job.muxProgress ?? 0) * 100));
    }
    if (job.phase === 'saving') return 99;
    return 0;
  }

  async function setBadgePct(tabId: number, pct: number): Promise<void> {
    try {
      await browser.action.setBadgeText({ tabId, text: `${pct}%` });
      await browser.action.setBadgeBackgroundColor({ tabId, color: '#1a7f37' });
    } catch {
      // tab may have already closed.
    }
  }

  function notify(title: string, message: string): void {
    try {
      browser.notifications.create({
        type: 'basic',
        iconUrl: browser.runtime.getURL('/icon/128.png'),
        title,
        message,
      });
    } catch {
      // notifications may not be available.
    }
  }

  const ACTIVE_PHASES = new Set(['fetching', 'muxing', 'saving']);

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session' || !changes.hlsjobs) return;
    const oldJobs = (changes.hlsjobs.oldValue ?? {}) as Record<string, HlsJob>;
    const newJobs = (changes.hlsjobs.newValue ?? {}) as Record<string, HlsJob>;
    void (async () => {
      for (const [id, job] of Object.entries(newJobs)) {
        const prevPhase = oldJobs[id]?.phase;
        const justFinished =
          TERMINAL_PHASES.has(job.phase) && prevPhase !== job.phase;
        // W2.3/W2.4: remove EVERY spoof rule of this job on a terminal branch (done/error/cancelled)
        // — does NOT depend on tabId (the badge needs tabId, rule removal doesn't). The success
        // branch also removes them in handleBlobDownload; doing it twice is harmless
        // (removeRuleIds skips ids that no longer exist).
        if (justFinished && job.spoofRuleIds?.length) {
          void removeSpoofRules(job.spoofRuleIds);
        }
        if (job.tabId == null) continue;
        if (ACTIVE_PHASES.has(job.phase)) {
          await setBadgePct(job.tabId, jobBadgePct(job));
        } else if (justFinished) {
          // Restore the badge = count of rows STILL VISIBLE (W4.2: don't count hidden child playlists).
          const count = visibleMedia(await getTabMedia(job.tabId)).length;
          await updateBadge(job.tabId, count);
          const name = job.filename?.split('/').pop() ?? 'video';
          if (job.phase === 'done') {
            notify('Đã tải xong', name);
          } else if (job.phase === 'error') {
            notify('Tải thất bại', job.error ?? 'Lỗi không rõ');
          }
        }
      }
    })();
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void clearTabMedia(tabId);
  });

  // W4.3 — SPA navigation (`pushState`) does NOT generate any `main_frame` request so `resetTab`
  // never runs; but `tabs.onUpdated` STILL fires with `changeInfo.url`. Only update navUrl, do NOT
  // clear items: media from the new route needs to be stamped with the correct page, while clearing
  // the list is resetTab's job.
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const url = changeInfo.url;
    if (url) void serialize(() => setTabNavUrl(tabId, url));
  });

  // W2.4 — reconcile leaked spoof rules. `onStartup` fires when the browser is reopened; the
  // top-level call fires every time the SW cold-starts mid-session (catches rules from a job that
  // died earlier and didn't get to clean up). A still-alive job has its id in the "alive" set, so it
  // is NOT swept by mistake.
  browser.runtime.onStartup.addListener(() => {
    void sweepStaleSpoofRules();
    // W4.3 — a tab already open before this SW ran also needs to know which URL it's on.
    void seedNavUrls(serialize);
  });
  void sweepStaleSpoofRules();

  // W2.7 — periodic tick that detects "the video processor has died". An alarm, NOT setInterval:
  // the MV3 service worker can be put to sleep at any time and a timer would die with it, while an
  // alarm wakes the SW back up to run. 0.5-minute period = the densest Chrome allows; the 60s death
  // threshold means the worst case is the user waits ~30s extra.
  browser.alarms.create(DEAD_JOB_ALARM, { periodInMinutes: 0.5 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== DEAD_JOB_ALARM) return;
    void reapDeadHlsJobs();
    void reapDeadDownloads();
  });
  // Also run one pass right at SW cold-start: if the SW just revived after both it and offscreen
  // were killed, an orphaned job must be finalized IMMEDIATELY, not wait for the alarm cycle.
  void reapDeadHlsJobs();
  void reapDeadDownloads();
});

const DEAD_JOB_ALARM = 'w27-dead-job-tick';

/**
 * W2.7 — finalize an ERROR for a job whose offscreen died mid-way (§2.14).
 *
 * Why this is needed: offscreen dies SILENTLY — Chrome fires no event back to background. Without
 * this tick a job would stay stuck at 'fetching' FOREVER and the popup would spin with no
 * explanation — exactly the worst possible outcome for a download app: the user has no idea whether
 * to keep waiting or click again.
 */
async function reapDeadHlsJobs(): Promise<void> {
  try {
    const jobs = await getHlsJobs();
    const dead = findDeadHlsJobs(jobs, Date.now(), HEARTBEAT_TIMEOUT_MS);
    if (dead.length === 0) return;
    for (const id of dead) {
      await updateHlsJob(id, {
        phase: 'error',
        error: DEAD_OFFSCREEN_ERROR,
        note: undefined,
      });
      // A dead job's spoof rule is garbage: it can no longer clean itself up (the normal terminal
      // branch never runs). Same leak bug class as W2.4.
      const ids = jobs[id]?.spoofRuleIds;
      if (ids?.length) await removeSpoofRules(ids);
    }
    console.warn(`[bg] W2.7: chốt lỗi ${dead.length} job do offscreen đã chết`);
  } catch (e) {
    // The periodic tick MUST NOT throw: throwing here would be an unhandled rejection every 30 seconds.
    console.warn('[bg] tick dò job chết lỗi:', describeError(e));
  }
}

/**
 * W2.7 — finalize an ERROR for a PROGRESSIVE download whose offscreen died mid-fetch.
 *
 * Why this path is also needed (easy to overlook): W2.5 moved .mp4 to fetch inside offscreen so it
 * could carry the Referer spoof — from that point it depends on offscreen just like HLS does, but the
 * original liveness net only covered HLS. MEASURED via e2e `progressive-offscreen-death`: entry stuck
 * at `in_progress` for >150s.
 */
async function reapDeadDownloads(): Promise<void> {
  try {
    const entries = await getDownloads();
    const dead = findDeadDownloads(entries, Date.now(), HEARTBEAT_TIMEOUT_MS);
    if (dead.length === 0) return;
    for (const key of dead) {
      await updateDownload(key, {
        state: 'interrupted',
        error: DEAD_OFFSCREEN_ERROR,
      });
      // A dead round's spoof rule can no longer clean itself up: the normal terminal branch
      // (handleBlobDownload / download/progress 'interrupted') never runs. Same leak class as W2.4.
      const ids = entries[key]?.spoofRuleIds;
      if (ids?.length) await removeSpoofRules(ids);
    }
    console.warn(
      `[bg] W2.7: chốt lỗi ${dead.length} lượt tải do offscreen đã chết`,
    );
  } catch (e) {
    console.warn('[bg] tick dò lượt tải chết lỗi:', describeError(e));
  }
}

/**
 * W2.2 — enable a Referer/Origin spoof TIGHTLY WRAPPED around one fetch, then remove it right in `finally`.
 *
 * §2.3: `handleVariants`/`handleHlsEstimate` are the FIRST TWO fetches of the flow, and they used to
 * fetch bare ⇒ an anti-hotlink site would 403 right at the "Quality" step, so `handleHlsDownload`
 * (the function WITH spoofing) never got called at all ⇒ the 403-bypass feature was dead code exactly
 * on the site that needed it most.
 *
 * `pageUrl` (looked up from `media.pageUrl` by tabId) is the page's REAL Referer — important because
 * hotlink checks usually match Referer against the site's domain, not the CDN's. Without pageUrl,
 * applySpoof falls back to using targetUrl itself (enough to pass a "missing Referer" gate, but a
 * weaker match on a site that checks the domain).
 *
 * W2.4: allocate a SEPARATE id for each fetch (allocateSpoofRuleId) and remove exactly that id -> two
 * downloads/estimates on the SAME host no longer steal each other's rule (the old W2.2 limitation is gone).
 */
async function withSpoofedFetch<T>(
  targetUrl: string,
  pageUrl: string | undefined,
  fn: () => Promise<T>,
  captured?: CapturedContext,
  forceStripSensitive = false,
): Promise<T> {
  const ruleId = await allocateSpoofRuleId();
  await applySpoof(ruleId, targetUrl, pageUrl, captured, forceStripSensitive);
  try {
    return await fn();
  } finally {
    await removeSpoofRules([ruleId]);
  }
}

/**
 * pageUrl to build the real Referer. Prefer the item matching `url` (the master); if none matches
 * (e.g. estimate only has the variant URL, no matching media) fall back to the pageUrl of any item on
 * the tab — pageUrl is really a fact about the whole PAGE (resetTab clears everything on navigation
 * so every item belongs to the same page). undefined when there's no tabId or the tab has no media yet.
 */
async function pageUrlFor(
  tabId?: number,
  url?: string,
): Promise<string | undefined> {
  if (tabId === undefined || tabId < 0) return undefined;
  const items = await getTabMedia(tabId);
  if (url) {
    const exact = items.find((m) => m.url === url)?.pageUrl;
    if (exact) return exact;
  }
  return items.find((m) => m.pageUrl)?.pageUrl;
}

/**
 * W2.1 — real header capture for the EXACT `url`. EXACT MATCH ONLY, no fallback.
 *
 * Intentionally different from `pageUrlFor` right above: that function is allowed to fall back to
 * any item because `pageUrl` is a fact at the PAGE level. Headers are a fact at the REQUEST level —
 * assigning another media's headers to this request is FABRICATION, the exact thing W2.1 exists to
 * kill. No match -> undefined -> fall back to the old spoof.
 */
async function capturedFor(
  tabId: number | undefined,
  url: string,
): Promise<CapturedContext | undefined> {
  if (tabId === undefined || tabId < 0) return undefined;
  const items = await getTabMedia(tabId);
  return capturedContextOf(items.find((m) => m.url === url));
}

/**
 * Wait cap when reading the page title. Reading the filename is a SIDE concern — it must not be
 * allowed to hold up the whole download.
 *
 * Real case: if the renderer hangs (heavy page, devtools breakpoint), `executeScript` never resolves.
 * This call sits BEFORE `putHlsJob`/`putDownload`, so hanging here means clicking Download does
 * NOTHING: no job, no error, no log line — exactly the kind of silent failure this project has paid
 * for before.
 */
const TITLE_READ_TIMEOUT_MS = 3_000;

function withTitleTimeout<T>(p: Promise<T>): Promise<T | undefined> {
  return Promise.race([
    p,
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), TITLE_READ_TIMEOUT_MS),
    ),
  ]);
}

/**
 * W4.3 — seed `navUrl` for tabs ALREADY OPEN when the service worker starts up.
 *
 * Without this step, a tab open before the extension was installed/updated has no `navUrl` (only
 * `resetTab` via main_frame and `tabs.onUpdated` ever set it), so any media detected in it does NOT
 * get stamped -> the anti-wrong-name guard closes -> the filename falls back to `master.mp4` even
 * though the user is standing right on that page. Seed it upfront so the common case still gets a nice name.
 */
async function seedNavUrls(
  run: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<void> {
  try {
    const tabs = await browser.tabs.query({});
    for (const t of tabs) {
      const id = t.id;
      const url = t.url;
      if (typeof id === 'number' && id >= 0 && url?.startsWith('http')) {
        await run(() => setTabNavUrl(id, url));
      }
    }
  } catch (e) {
    console.warn('[bg] W4.3 không nạp được navUrl ban đầu:', describeError(e));
  }
}

/**
 * W4.3 — resolve the video title AT DOWNLOAD TIME, not at detection time.
 *
 * WHY READ LATE: network-based detection (`onBeforeRequest`/`onHeadersReceived`/`onSendHeaders`)
 * runs BEFORE the content script (`document_idle`) — that's exactly why most HLS/DASH media used to
 * have no title at all and fell back to `master.mp4`. Reading when the user clicks download means the
 * DOM is already built and `og:title` already exists. Reading late also means we do NOT need to store
 * the title on `MediaItem` -> avoids `upsertMedia`'s "first writer wins" trap, and there's no race to lose.
 *
 * On `frameIds: [0]` — MEASURED (e2e `title-og` + mutation ME5, 2026-07-19): it is NOT what's doing
 * the work. `executeScript` already only injects into the TOP frame by default, so removing this line
 * still leaves the e2e test green. Kept because it states intent clearly and guards against someone
 * later switching to `allFrames: true` — that's when an embedded player's iframe (with its own title
 * like 'JW Player') would actually have a chance to sneak in. DO NOT write it off as "required":
 * fixture `/og.html` already has an iframe with a wrong title and the mutation still doesn't fire.
 */
async function resolveTitle(
  tabId: number | undefined,
  media: MediaItem | undefined,
): Promise<string | undefined> {
  const stored = media?.title;
  const detectedAt = media?.detectPageUrl;
  if (tabId === undefined || tabId < 0) {
    return pickTitle({ stored }, detectedAt);
  }

  let tab: { url?: string; title?: string } | undefined;
  try {
    tab = await withTitleTimeout(browser.tabs.get(tabId));
  } catch {
    // Tab already closed / evicted from memory by Chrome. Not an error — just use what was stored.
    tab = undefined;
  }
  const currentUrl = tab?.url;

  // 🔴 The anti-WRONG-NAME guard — CLOSED when facts are missing (adversarial review: 6 independent
  // lenses all pointed here). Both cases must be blocked:
  //  - media detected on a different page than the one currently open (user switched videos SPA-style);
  //  - media with NO page stamp (`detectPageUrl` empty) -> we have no way to know which page it
  //    belongs to, so we must NOT borrow the title of the currently open page.
  // Blocking here only makes the filename fall back to a URL-derived name. Letting it through would
  // produce a WRONG name that looks very real — far worse than `master.mp4`, because the user TRUSTS it.
  if (!detectedAt || !sameDocument(detectedAt, currentUrl)) {
    return pickTitle({ stored }, detectedAt ?? currentUrl);
  }

  let meta: { og?: string; twitter?: string; doc?: string } = {};
  try {
    const results = await withTitleTimeout(
      browser.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => {
          const read = (sel: string): string | undefined => {
            const el = document.querySelector(sel);
            const v = el?.getAttribute('content') ?? undefined;
            return v && v.trim() ? v : undefined;
          };
          return {
            og: read('meta[property="og:title"]'),
            twitter:
              read('meta[name="twitter:title"]') ??
              read('meta[property="twitter:title"]'),
            doc: document.title || undefined,
          };
        },
      }),
    );
    meta = results?.[0]?.result ?? {};
  } catch (e) {
    // Page forbids script injection (chrome://, Web Store, PDF viewer) — NOT an error for the download.
    // Log it instead of swallowing it whole: a bare `catch {}` is what hid 3 fatal bugs in this project.
    console.warn('[bg] W4.3 không đọc được tiêu đề trang:', describeError(e));
  }

  return pickTitle(
    {
      og: meta.og,
      twitter: meta.twitter,
      doc: meta.doc,
      tab: tab?.title,
      stored,
    },
    currentUrl ?? detectedAt,
  );
}

async function handleVariants(
  url: string,
  mediaType: ManifestKind,
  tabId?: number,
): Promise<VariantsResponse> {
  try {
    const pageUrl = await pageUrlFor(tabId, url);
    // W2.2: spoof BEFORE fetching — a 403 must not kill the quality-selection step.
    // W2.1: replay the player's REAL headers for this exact manifest if they were captured.
    const res = await withSpoofedFetch(
      url,
      pageUrl,
      () => fetch(url, { credentials: 'include' }),
      await capturedFor(tabId, url),
    );
    if (!res.ok) return { ok: false, error: `Máy chủ trả mã ${res.status}.` };
    const text = await res.text();
    const parsed =
      mediaType === 'hls'
        ? parseHlsManifest(text, url)
        : parseDashManifest(text, url);
    if (parsed.variants.length === 0) {
      return { ok: false, error: 'Manifest không có chất lượng nào.' };
    }
    return { ok: true, isMaster: parsed.isMaster, variants: parsed.variants };
  } catch {
    return {
      ok: false,
      error: 'Không tải/parse được manifest (mạng hoặc CORS).',
    };
  }
}

async function handleDownload(
  url: string,
  tabId: number,
): Promise<DownloadStartResponse> {
  // W7.1 — HARD BOUNDARY §7: also block the progressive path, not just HLS.
  const drmBlocked = await drmBlockReason(tabId);
  if (drmBlocked) return { ok: false, error: drmBlocked };
  // W2.5 — ROUTE THROUGH OFFSCREEN instead of calling chrome.downloads.download({url}) directly.
  // MEASURED 2026-07-18: a direct download does NOT receive the DNR modifyHeaders rule (the server
  // sees Referer:NONE -> 403 on an anti-hotlink site). offscreen's fetch() is a tab-less
  // xmlhttprequest -> MATCHES the spoof rule -> passes the 403. chrome.downloads.download now only
  // ever receives a blob: URL (VDH invariant).
  //
  // Hoisted out of the try so the catch can clean it up: the rule is applied BEFORE ensureOffscreen;
  // if it throws before putDownload, the id isn't stored anywhere -> only the cold-start sweep would
  // clean it. Remove it right away in the catch to avoid leaking it for the rest of the session.
  let ruleId: number | undefined;
  const key = crypto.randomUUID();
  try {
    const media = (await getTabMedia(tabId)).find((m) => m.url === url);
    // Spoof Referer/Origin to bypass hotlink-protection/403 (non-DRM). Own id for this download (W2.4).
    ruleId = await allocateSpoofRuleId();
    await applySpoof(ruleId, url, media?.pageUrl, capturedContextOf(media));
    const folder = await getDownloadFolder();
    const filename = buildDownloadFilename({
      url,
      // W4.3 — no longer using `media?.title`: it's almost always empty on the network detection path.
      title: await resolveTitle(tabId, media),
      height: media?.height,
      contentType: media?.contentType,
      folder,
      template: await getFilenameTemplate(),
      pageUrl: media?.pageUrl ?? media?.detectPageUrl,
    });
    // In-flight entry (FETCH phase inside offscreen) — no chromeDownloadId yet, popup shows "Downloading…".
    await putDownload({
      key,
      mediaUrl: url,
      filename,
      state: 'in_progress',
      startedAt: Date.now(),
      // W2.7 — first heartbeat: also covers the case "offscreen died before it could pick up the work".
      lastSeenAt: Date.now(),
      spoofRuleIds: [ruleId],
    });
    await ensureOffscreen();
    // Not awaited: offscreen's fetch can run long, it reports progress via download/progress. BUT the
    // send must be error-caught (offscreen hasn't registered its listener yet) -> otherwise the entry
    // stays stuck at 'in_progress' forever.
    void browser.runtime
      .sendMessage({
        target: 'offscreen',
        kind: 'download/run',
        key,
        url,
        filename,
        mediaUrl: url,
        tabId,
        spoofRuleIds: [ruleId],
      })
      .catch(async (e: unknown) => {
        if (ruleId !== undefined) await removeSpoofRules([ruleId]);
        await updateDownload(key, {
          state: 'interrupted',
          error: `Không gửi được việc sang bộ xử lý: ${describeError(e)}`,
        });
      });
    return { ok: true, key };
  } catch (e) {
    // Clean up a rule that was applied but never got handed off to offscreen — avoids a session-long leak.
    if (ruleId !== undefined) await removeSpoofRules([ruleId]);
    await updateDownload(key, {
      state: 'interrupted',
      error: e instanceof Error ? e.message : 'Không bắt đầu tải được.',
    });
    return {
      ok: false,
      error: 'Không bắt đầu tải được (URL có thể hết hạn/403 hoặc bị chặn).',
    };
  }
}

/** Server returned an error code — keep `status` so the message still points in the right direction (403 = anti-hotlink). */
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/**
 * W7.1 — HARD BOUNDARY §7. Once a tab is revealed to use DRM/EME, every DOWNLOAD path closes, with
 * a clear reason given.
 *
 * Returns the error message if it must block, `null` if clean. Placed in background (not the popup)
 * because the popup is just one of the entry points — blocking here seals every path.
 *
 * 🔴 This is REFUSAL code, not decryption code: we only detect it to say "not supported".
 */
async function drmBlockReason(tabId?: number): Promise<string | null> {
  if (tabId === undefined || tabId < 0) return null;
  try {
    const systems = (await getTabState(tabId)).drmSystems ?? [];
    if (systems.length === 0) return null;
    // Drop the generic entry if a named vendor is already known -> the message states the real name
    // instead of "unknown".
    const named = systems.filter((s) => s !== 'DRM không rõ');
    return DRM_UNSUPPORTED_ERROR(
      named.length > 0 ? named.join(', ') : undefined,
    );
  } catch {
    return null; // storage read failed -> don't block unjustly.
  }
}

async function handleHlsEstimate(
  variantUrl: string,
  bandwidth?: number,
  audioUrl?: string,
  tabId?: number,
  mediaType?: 'hls' | 'dash',
  variantId?: string,
  audioId?: string,
): Promise<HlsEstimateResponse> {
  // W7.1 — the TAB's DRM flag (EME) is a signal INDEPENDENT of the playlist: SAMPLE-AES shows up in
  // the playlist, while Widevine/PlayReady leave NO trace there and only surface via EME. Knowing
  // upfront lets us answer immediately, without spending a single request.
  const drmBlocked = await drmBlockReason(tabId);
  if (drmBlocked) {
    return {
      ok: true,
      protected: true,
      segmentCount: 0,
      durationSec: 0,
      // No playlist has been fetched yet (DRM blocked it first) -> nothing is known about splice
      // points. The popup stops at the `protected` branch before reading this far, so 0 here means
      // "no data", not "measured and clean".
      discontinuityCount: 0,
    };
  }
  // W2.2: spoof Referer/Origin around the estimate fetch — same §2.3 reasoning as handleVariants.
  // The estimate usually points at the same host as video; a different audio host (if any) is fully
  // covered by W2.3.
  const pageUrl = await pageUrlFor(tabId, variantUrl);
  try {
    return await withSpoofedFetch(
      variantUrl,
      pageUrl,
      () =>
        estimateFromPlaylists(
          variantUrl,
          bandwidth,
          audioUrl,
          mediaType,
          variantId,
          audioId,
        ),
      await capturedFor(tabId, variantUrl),
    );
  } catch (e) {
    if (e instanceof HttpError) {
      return { ok: false, error: `Máy chủ trả mã ${e.status}.` };
    }
    return {
      ok: false,
      error: 'Không tải/parse được playlist (mạng hoặc CORS).',
    };
  }
}

async function estimateFromPlaylists(
  variantUrl: string,
  bandwidth?: number,
  audioUrl?: string,
  mediaType?: 'hls' | 'dash',
  variantId?: string,
  audioId?: string,
): Promise<HlsEstimateResponse> {
  // The HTTP status MUST survive all the way to the user: "Server returned code 403." points
  // straight at anti-hotlink protection, while "network or CORS" points in a completely wrong
  // direction — exactly the "real reason evaporates" pattern this very session just patched in the
  // ffmpeg layer. Throw a dedicated HttpError so the catch block can tell them apart.
  const fetchParse = async (url: string) => {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new HttpError(res.status);
    return parseTrackSegments(await res.text(), url, mediaType, variantId);
  };
  // W1.1: the job will also download the audio playlist -> the estimate must inspect it too,
  // otherwise the popup reports "10 segments" and then the progress bar runs up to 21 — looks like a bug.
  //
  // ⚠️ A broken audio playlist must NOT block the download path: this is only the ESTIMATE step. The
  // audio host can differ from the video host, so the estimate's spoof (which only covers the video
  // host) doesn't reach it -> on an anti-hotlink site, the audio playlist can easily 403 right here
  // and still download fine later in handleHlsDownload. Letting Promise.all reject would cost the user
  // the download button entirely over one estimate number — trading a small annoyance for a dead end.
  // W1.5 — DASH keeps BOTH video AND audio in the SAME .mpd file, so `variantUrl === audioUrl`.
  // Calling fetchParse twice would download the whole manifest twice just for one estimate number;
  // fetching once and parsing both tracks is enough and costs no extra network.
  let parsed: Awaited<ReturnType<typeof fetchParse>>;
  let audio: Awaited<ReturnType<typeof fetchParse>> | null;
  if (mediaType === 'dash') {
    const res = await fetch(variantUrl, { credentials: 'include' });
    if (!res.ok) throw new HttpError(res.status);
    const text = await res.text();
    parsed = parseTrackSegments(text, variantUrl, 'dash', variantId);
    audio = audioId
      ? parseTrackSegments(text, variantUrl, 'dash', audioId)
      : null;
  } else {
    [parsed, audio] = await Promise.all([
      fetchParse(variantUrl),
      audioUrl ? fetchParse(audioUrl).catch(() => null) : Promise.resolve(null),
    ]);
  }
  // Duration is the MAX, NOT the sum: video and audio run IN PARALLEL, not back to back.
  const durationSec = Math.max(parsed.totalDuration, audio?.totalDuration ?? 0);
  // #EXT-X-STREAM-INF's BANDWIDTH already includes the audio rendition (RFC 8216 §4.3.4.2) -> do
  // NOT add anything on top, adding more would double-count it.
  const estBytes =
    bandwidth && bandwidth > 0
      ? Math.round((bandwidth / 8) * durationSec)
      : undefined;
  return {
    ok: true,
    protected: parsed.isProtected || (audio?.isProtected ?? false),
    // Name the DRM vendor explicitly: a bare "not supported" makes the user think the extension is broken.
    ...(parsed.drmName || audio?.drmName
      ? { drmName: parsed.drmName ?? audio?.drmName }
      : {}),
    segmentCount: parsed.segments.length + (audio?.segments.length ?? 0),
    durationSec,
    estBytes,
    // W1.4 — MAX, NOT sum: video and audio are two views of the SAME timeline, so the same ad-break
    // splice point shows up in BOTH playlists. Adding them would double-count. Take the max so
    // whichever playlist declares it more completely wins — missing a splice point is the silent failure.
    discontinuityCount: Math.max(
      parsed.discontinuityCount,
      audio?.discontinuityCount ?? 0,
    ),
  };
}

async function handleHlsDownload(
  variantUrl: string,
  mediaUrl: string,
  tabId: number,
  height?: number,
  audioUrl?: string,
  mediaType?: 'hls' | 'dash',
  variantId?: string,
  audioId?: string,
): Promise<HlsDownloadResponse> {
  // W7.1 — HARD BOUNDARY §7: refuse IMMEDIATELY, before applying any spoof rule or firing any request.
  const drmBlocked = await drmBlockReason(tabId);
  if (drmBlocked) return { ok: false, error: drmBlocked };
  // Hoisted out of the try so the catch can still clean up: if it throws BEFORE putHlsJob, the id
  // isn't stored anywhere; if ensureOffscreen throws AFTER putHlsJob, the job stays stuck at 'queued'
  // (storage.onChanged has no terminal branch to clean it) -> removing directly via the id we're
  // already holding is the most reliable approach.
  const spoofRuleIds: number[] = [];
  try {
    const media = (await getTabMedia(tabId)).find((m) => m.url === mediaUrl);
    const pageUrl = media?.pageUrl;
    // W2.1 — the REAL headers the player sent for this exact manifest. Captured by the EXACT media
    // URL, NOT via a `pageUrlFor`-style fallback (which returns any item on the tab): pageUrl is a
    // page-level fact so it can be borrowed, but headers are a request-level fact — borrowing from
    // another media item would be a new kind of fabrication.
    const captured = capturedContextOf(media);
    // Every applied rule MUST be tracked so it can be CLEANED UP: a DNR session rule lives for the
    // rest of the browser session (§2.10) -> missing one leaks it until the browser closes. W2.4:
    // each host gets its OWN id (not derived from the host) so two downloads on the same host don't
    // steal each other's rule. `spoofedHosts` is only for DEDUPING (one rule per host for this job),
    // while `spoofRuleIds` is what actually gets cleaned up.
    const spoofedHosts = new Set<string>();
    const spoof = async (url: string): Promise<void> => {
      const host = hostFromUrl(url);
      if (
        !host ||
        spoofedHosts.has(host) ||
        spoofedHosts.size >= MAX_SPOOF_HOSTS
      )
        return;
      const ruleId = await allocateSpoofRuleId();
      await applySpoof(ruleId, url, pageUrl, captured);
      spoofedHosts.add(host);
      spoofRuleIds.push(ruleId);
    };
    // Spoof the video + audio playlist hosts (audio can be on a separate CDN — W1.1).
    await spoof(variantUrl);
    if (audioUrl) await spoof(audioUrl);
    // W2.3: parse the playlist FIRST, then spoof EVERY host of segment/key/init. These are very often
    // on a different CDN host than the playlist (the AES key host is ALMOST ALWAYS different, and is
    // also the thing that most often checks Referer) -> missing one means the job reaches 'fetching'
    // and every segment 403s. The rule is applied HERE, BEFORE offscreen fetches any segment.
    // Best-effort: if the playlist 403s at this step, offscreen still retries on its own; we only lose
    // the "different host" coverage.
    //
    // W1.5 — parse using the CORRECT format: feeding a .mpd into the HLS parser yields 0 segments
    // WITHOUT throwing -> 0 segment hosts get spoofed -> the job reaches 'fetching' and then 403s
    // cleanly, silently.
    // DASH keeps both video and audio in one .mpd, so dedupe by URL: same document, two tracks.
    const playlistJobs: { url: string; trackId?: string }[] =
      mediaType === 'dash'
        ? [
            { url: variantUrl, ...(variantId ? { trackId: variantId } : {}) },
            ...(audioId ? [{ url: variantUrl, trackId: audioId }] : []),
          ]
        : (audioUrl ? [variantUrl, audioUrl] : [variantUrl]).map((url) => ({
            url,
          }));
    const textCache = new Map<string, string | null>();
    for (const job of playlistJobs) {
      try {
        if (!textCache.has(job.url)) {
          const res = await fetch(job.url, { credentials: 'include' });
          textCache.set(job.url, res.ok ? await res.text() : null);
        }
        const text = textCache.get(job.url);
        if (text == null) continue;
        const parsed = parseTrackSegments(
          text,
          job.url,
          mediaType,
          job.trackId,
        );
        for (const url of spoofTargetsFromSegments(parsed.segments)) {
          await spoof(url);
        }
        // DASH SegmentBase: the whole representation is just ONE .mp4 file that downloads directly
        // -> there's no segment to mux. Route it to the progressive path (W2.5) instead of letting
        // offscreen report "playlist has no segments" — technically true but entirely the wrong reason.
        if (parsed.directUrl) await spoof(parsed.directUrl);
      } catch {
        // best-effort — host discovery must never be allowed to break the download path.
      }
    }
    const folder = await getDownloadFolder();
    const filename = buildDownloadFilename({
      url: variantUrl,
      // W4.3 — this is the MAIN download path (HLS/DASH) and also where `media?.title` is empty most often.
      title: await resolveTitle(tabId, media),
      height: height ?? media?.height,
      folder,
      template: await getFilenameTemplate(),
      pageUrl: media?.pageUrl ?? media?.detectPageUrl,
    });
    const jobId = crypto.randomUUID();
    await putHlsJob({
      id: jobId,
      mediaUrl,
      variantUrl,
      // 'queued', NOT 'loading': offscreen hasn't run a single line yet. Only offscreen is allowed to
      // set 'loading' (main.ts), so a job stuck at 'queued' means the message never arrived.
      phase: 'queued',
      segmentsTotal: 0,
      segmentsDone: 0,
      filename,
      tabId,
      // W2.7 — the FIRST heartbeat, set right when the job is created. This gives the case
      // "offscreen died before it could pick up the work" (job stuck at 'queued') a timestamp for the
      // detection tick to find, instead of falling outside the net.
      lastSeenAt: Date.now(),
      // Stored so it can be CLEANED UP on EVERY terminal branch (done/error/cancelled), not just the
      // success branch via handleBlobDownload — W2.3 expanded the host set so a leak on error would
      // be worse without this.
      spoofRuleIds,
    });
    await ensureOffscreen();
    // Not awaited: the job runs long, offscreen reports progress via storage, not via the response.
    // BUT errors must be caught — swallowing them here would mean a dropped message (e.g. offscreen
    // hasn't registered its listener yet) leaves the job stuck at 'queued' FOREVER with no error line at all.
    void browser.runtime
      .sendMessage({
        target: 'offscreen',
        kind: 'hls/run',
        jobId,
        variantUrl,
        audioUrl,
        filename,
        mediaUrl,
        tabId,
        spoofRuleIds,
        // W1.5 — missing these 3 fields makes offscreen feed the .mpd into the HLS parser, and the
        // job dies silently.
        mediaType,
        variantId,
        audioId,
        // Offscreen cannot read settings itself (no chrome.storage) -> read them here and pass them along.
        concurrency: await getConcurrency(),
      })
      .catch(async (e: unknown) => {
        await updateHlsJob(jobId, {
          phase: 'error',
          error: `Không gửi được việc sang bộ xử lý video: ${describeError(e)}`,
        });
      });
    return { ok: true, jobId };
  } catch (e) {
    // Clean up every rule applied before throwing (see the hoist comment at the top of this function)
    // — otherwise an orphaned id would only get cleaned up by the cold-start sweep.
    if (spoofRuleIds.length) await removeSpoofRules(spoofRuleIds);
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Không khởi tạo được tải HLS.',
    };
  }
}

async function handleBlobDownload(
  blobUrl: string,
  filename: string,
  mediaUrl: string,
  _tabId: number,
  jobId: string,
  spoofRuleIds?: number[],
  downloadKey?: string,
): Promise<void> {
  // Bytes are already fetched -> remove the spoof rule for EVERY host (HLS: video/audio/segment;
  // progressive: 1 host).
  if (spoofRuleIds?.length) void removeSpoofRules(spoofRuleIds);
  // W2.5: progressive hands off via downloadKey -> ATTACH chromeDownloadId to the EXACT entry that's
  // fetching (don't create a new one, or the popup will show 2 rows). HLS has no downloadKey ->
  // create an entry keyed by jobId.
  const key = downloadKey ?? jobId;
  try {
    const downloadId = await browser.downloads.download({
      url: blobUrl,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    if (downloadKey) {
      // User already CANCELLED during fetch->save (entry is already 'interrupted'; at that point
      // there was no chromeDownloadId yet, so handleDownloadCancel only aborted offscreen — harmless
      // since the fetch had finished) -> cancel this freshly created blob download too + revoke it,
      // DO NOT write 'complete' over the user's cancel.
      const cur = (await getDownloads())[key];
      if (cur?.state === 'interrupted') {
        void browser.downloads.cancel(downloadId).catch(() => undefined);
        void sendToOffscreen({ kind: 'revoke', url: blobUrl });
        return;
      }
      // Entry already exists (fetch phase) -> merge in the real id + blobUrl; keep state in_progress
      // (onChanged will flip it).
      await updateDownload(key, { chromeDownloadId: downloadId, blobUrl });
      // Race guard: a small blob can COMPLETE before downloads.onChanged manages to match the entry
      // (at that point chromeDownloadId hasn't persisted yet -> onChanged skips it -> entry stuck at
      // 'in_progress'). Re-read the state IMMEDIATELY: if already terminal, write it now + revoke the
      // blob (avoids depending on onChanged's timing).
      const [d] = await browser.downloads.search({ id: downloadId });
      if (d && d.state !== 'in_progress') {
        await updateDownload(key, {
          state: d.state as DownloadState,
          ...(d.error ? { error: d.error } : {}),
        });
        void sendToOffscreen({ kind: 'revoke', url: blobUrl });
      }
    } else {
      await putDownload({
        key,
        mediaUrl,
        filename,
        state: 'in_progress',
        chromeDownloadId: downloadId,
        blobUrl,
      });
    }
  } catch (e) {
    // Could not save -> report the error at the EXACT place the popup is watching: progressive watches
    // DownloadEntry, HLS watches the job.
    const msg = e instanceof Error ? e.message : 'Không lưu được file về máy.';
    if (downloadKey) {
      await updateDownload(key, { state: 'interrupted', error: msg });
    } else {
      await updateHlsJob(jobId, { phase: 'error', error: msg });
    }
  }
}

/**
 * W2.5 — cancel a progressive download by KEY. Two phases, two ways to cancel:
 * - already has chromeDownloadId (currently SAVING) -> chrome.downloads.cancel;
 * - doesn't yet (currently FETCHING inside offscreen) -> tell offscreen to abort the fetch + remove
 *   the spoof rule + mark it cancelled.
 */
async function handleDownloadCancel(key: string): Promise<void> {
  const entry = (await getDownloads())[key];
  if (!entry) return;
  if (entry.chromeDownloadId !== undefined) {
    void browser.downloads
      .cancel(entry.chromeDownloadId)
      .catch(() => undefined);
    return;
  }
  void browser.runtime
    .sendMessage({ target: 'offscreen', kind: 'download/abort', key })
    .catch(() => undefined);
  if (entry.spoofRuleIds?.length) void removeSpoofRules(entry.spoofRuleIds);
  await updateDownload(key, { state: 'interrupted', error: 'Đã huỷ' });
}

async function handleEngineSelfTest(): Promise<EngineSelfTestResponse> {
  try {
    await ensureOffscreen();
    const res = await browser.runtime.sendMessage({
      target: 'offscreen',
      kind: 'engine/selftest',
    });
    // W2.7 — if offscreen is dead/hasn't registered its listener, `sendMessage` resolves to
    // UNDEFINED instead of throwing. Returning that straight through hands `undefined` to the popup
    // -> the test button stays silent, saying nothing at all.
    // This function's contract is to ALWAYS return a readable object.
    if (!res || typeof res !== 'object') {
      return {
        ok: false,
        error:
          'Bộ xử lý video không trả lời (có thể đã bị trình duyệt thu hồi).',
      };
    }
    return res as EngineSelfTestResponse;
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Không chạy được offscreen.',
    };
  }
}

/**
 * W2.7 — is the offscreen document currently ALIVE?
 *
 * `getContexts` asks the browser directly, unlike the old approach of "just send and see if it
 * throws": offscreen being dead is a NORMAL BRANCH to handle, not an unexpected rejection.
 * (API available since Chrome 116; if missing, return `true` to preserve the old behavior instead of
 * blocking unjustly.)
 */
async function isOffscreenAlive(): Promise<boolean> {
  const rt = browser.runtime as typeof browser.runtime & {
    getContexts?: (f: {
      contextTypes: string[];
    }) => Promise<{ length: number }[]>;
  };
  if (typeof rt.getContexts !== 'function') return true;
  try {
    const ctxs = await rt.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctxs.length > 0;
  } catch {
    return true; // API failed -> don't block unjustly, just try sending as before.
  }
}

/**
 * W2.7 — send a message to offscreen, NEVER throws and never creates an unhandled rejection.
 *
 * Returns `true` if offscreen actually received it. Before W2.7, two call sites (`hls/cancel`,
 * `revoke`) called `sendMessage` bare without `.catch` -> a dead offscreen produced an unhandled
 * rejection, and worse, the caller still assumed the message had arrived.
 */
async function sendToOffscreen(msg: Record<string, unknown>): Promise<boolean> {
  if (!(await isOffscreenAlive())) return false;
  try {
    await browser.runtime.sendMessage({ target: 'offscreen', ...msg });
    return true;
  } catch (e) {
    // Common case: offscreen just died BETWEEN the alive check and the send (a race), or hasn't
    // registered its listener yet. Not a fatal error — the caller decides what to do based on `false`.
    console.warn('[bg] không gửi được tin sang offscreen:', describeError(e));
    return false;
  }
}

/**
 * W2.7 — `singleFlight` kills the race "two jobs both call createDocument".
 *
 * Before W2.7: two `handleHlsDownload` calls close together -> both enter `createDocument`; the
 * second one throws "single offscreen document" which was then SWALLOWED as if normal, so it fired
 * `hls/run` at a document that MIGHT not have finished registering its listener -> the job stayed
 * stuck at 'queued' forever, with no error line at all. Now the second call awaits the FIRST call's
 * exact promise, so by the time it proceeds the document is ready.
 */
const ensureOffscreen = singleFlight(async (): Promise<void> => {
  // Check first: if already alive, no need to touch createDocument (no need to catch an "already
  // exists" error just for fun).
  if (await isOffscreenAlive()) return;
  try {
    await browser.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification:
        'Chạy libav.wasm để ghép/remux video và tạo blob URL để tải.',
    });
  } catch (e) {
    // Each extension only gets 1 offscreen document -> "already exists" is NORMAL, ignore it.
    // Every other error (document creation genuinely failing) MUST be rethrown: swallowing it all
    // would make the caller believe offscreen is alive, and the job would hang forever with no explanation.
    if (!/single offscreen document/i.test(describeError(e))) throw e;
  }
});

// Cap on the number of hosts spoofed per job (VDH caps the total at ~750 rules; a job here rarely
// exceeds a few hosts, but the cap keeps a malformed manifest from spawning hundreds of rules).
const MAX_SPOOF_HOSTS = 64;

/** W2.1 — the player's real captured headers + the host they were captured for. */
interface CapturedContext {
  headers: Record<string, string>;
  /** host of the URL whose request was observed; decides which headers may be fired at a different host. */
  host: string;
  /** origin of the captured URL — used to ANCHOR a rule carrying a sensitive header (prevents leaking to subdomains). */
  origin: string;
}

/**
 * W2.1 — get the header capture for THIS EXACT media (undefined if no request was ever observed for it).
 *
 * ⚠️ Must NOT be loosened into "grab any item on the tab" the way `pageUrlFor` does: `pageUrl` is a
 * page-level fact so borrowing between media items is reasonable, but headers are a request-level
 * fact — borrowing another video's `Authorization` is a new kind of fabrication, exactly what W2.1
 * exists to kill.
 */
function capturedContextOf(media?: MediaItem): CapturedContext | undefined {
  if (!media?.sentHeaders) return undefined;
  const host = hostFromUrl(media.url);
  const origin = originFromUrl(media.url);
  if (!host || !origin) return undefined;
  return { headers: media.sentHeaders, host, origin };
}

/**
 * W2.1 — pick the spoof rule: REPLAY the real headers if captured, otherwise fall back to the old FABRICATION path.
 *
 * 🔴 THE FALLBACK IS REQUIRED, NOT EXTRA CAUTION. We only capture headers when a player request for
 * that exact URL was observed. Media detected via DOM/MSE, or a tab that already finished loading
 * before the extension started listening, will have empty `sentHeaders`. Dropping the fallback would
 * lose the 403-bypass feature that IS CURRENTLY WORKING (e2e `variants-403`, `segments-other-host`,
 * `progressive-403` are all green thanks to it).
 */
function buildSpoofRule(
  ruleId: number,
  host: string,
  targetUrl: string,
  pageUrl: string | undefined,
  captured: CapturedContext | undefined,
  /**
   * W2.1 debt (a) — this host already has a sensitive rule from ANOTHER live job. Stacking a second
   * sensitive rule makes the earlier job pick up the wrong token (MEASURED: DNR lets the higher id
   * win, applying it to the other job's request too). True -> downgrade the plan to just
   * Referer/Origin so the first job keeps its own correct token.
   */
  suppressSensitive = false,
): DnrRule | null {
  if (captured) {
    let plan = planHeaderReplay(captured.headers, {
      sameHost: host === captured.host,
    });
    if (suppressSensitive && plan.hasSensitive) plan = stripSensitive(plan);
    // isEmpty = the capture was entirely made of discarded headers -> treat it as if nothing was
    // captured -> continue down to the fallback.
    if (!plan.isEmpty) {
      // A rule carrying a sensitive header (Authorization, x-* token) must be ANCHORED by origin:
      // DNR's requestDomains also match subdomains, so without anchoring the token leaks to
      // api./accounts./cdn. on the same apex domain.
      return buildHeaderSpoofRule(
        ruleId,
        host,
        plan.headers,
        plan.hasSensitive ? captured.origin : undefined,
      );
    }
  }
  const refererBase =
    pageUrl && pageUrl.startsWith('http') ? pageUrl : targetUrl;
  const origin = originFromUrl(refererBase);
  if (!origin) return null;
  return buildRefererSpoofRule(ruleId, host, refererBase, origin);
}

// Apply a DNR session rule that spoofs Referer/Origin for the media's host (bypasses non-DRM hotlink/403).
// W2.4: `ruleId` is provided by the caller (allocateSpoofRuleId) — a separate id per (download, host)
// so two downloads on the same host don't steal each other's rule.
// W2.1: prefer the player's REAL headers (`captured`), only FABRICATE when there's nothing to replay.
async function applySpoof(
  ruleId: number,
  targetUrl: string,
  pageUrl?: string,
  captured?: CapturedContext,
  /**
   * W2.1 debt (a) — force the downgrade (keep only the REAL Referer/Origin, drop the token)
   * REGARDLESS of whether there's a conflict. Used for the best-effort BACKGROUND fetch
   * (learnMasterChildren): a live sensitive background rule can make a REAL download of a DIFFERENT
   * asset (different token, same host) downgrade its own token and then 403 (MEASURED in e2e
   * dual-host-different-token). Still uses the capture's real Referer/Origin -> doesn't fabricate an
   * Origin (§2.11).
   */
  forceStripSensitive = false,
): Promise<void> {
  const host = hostFromUrl(targetUrl);
  if (!host) return;
  // W2.1 debt (a) — only downgrade when this host already has a sensitive rule from ANOTHER job that
  // sets a sensitive header with a CONFLICTING value (a different token) than what this job is about
  // to set. (MEASURED: when two rules both match, DNR lets the higher id win and applies it to EVERY
  // request to the origin -> the earlier job picks up the later job's token.)
  // 🔴 A VALUE conflict, not mere existence: two downloads on the same site usually share one session
  // token -> suppressing based on existence would wrongly 403 the same-token case (more common than
  // the different-token case). Same token -> no conflict -> do NOT suppress -> both still download
  // fine. Only checked when this job is ACTUALLY about to set a sensitive header (plan.hasSensitive);
  // the Referer/Origin fallback carries no sensitive header so no check is needed. Best-effort: two
  // jobs starting close together still have a narrow race window (both read the rule before either
  // gets to write) — narrow, acceptable for a debt that's already rare.
  let suppressSensitive = forceStripSensitive;
  if (!suppressSensitive && captured) {
    const plan = planHeaderReplay(captured.headers, {
      sameHost: host === captured.host,
    });
    if (plan.hasSensitive) {
      try {
        const existing =
          (await browser.declarativeNetRequest.getSessionRules()) as unknown as DnrRule[];
        suppressSensitive = hasConflictingSensitiveRule(
          existing,
          host,
          plan.headers,
        );
      } catch {
        // getSessionRules failed -> keep the old behavior (don't suppress); don't block the download.
      }
    }
  }
  const rule = buildSpoofRule(
    ruleId,
    host,
    targetUrl,
    pageUrl,
    captured,
    suppressSensitive,
  );
  if (!rule) return;
  try {
    // Cast: DnrRule (string literals) is structurally compatible with the API's Rule type.
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [rule.id],
      addRules: [rule],
    } as unknown as Parameters<
      typeof browser.declarativeNetRequest.updateSessionRules
    >[0]);
  } catch {
    // Missing host access or an API error -> ignore (still try downloading without the spoof).
  }
}

// Remove a spoof session rule by id (W2.4: a separate id per download). removeRuleIds skips ids that
// don't exist, so calling it redundantly is harmless.
async function removeSpoofRules(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: ids,
    } as unknown as Parameters<
      typeof browser.declarativeNetRequest.updateSessionRules
    >[0]);
  } catch {
    // ignore
  }
}

/**
 * W2.4 — reconcile & clean up leaked spoof rules: remove every session rule in the spoof range that
 * has NO live job/download still using it.
 *
 * Why this is REQUIRED: switching to a counter-based id lost the "re-adding the same host replaces
 * the old rule" property that the old host-hash scheme gave for free, so a dead job's rule (SW killed
 * mid-way, never got to clean up) would stay around until the browser restarts. Called on
 * `onStartup` (browser reopened) and every time the SW cold-starts mid-session.
 *
 * Safe for a running job: a live job sits in storage at a non-terminal phase -> its id is in the
 * "alive" set -> it is NOT swept. (The SW can die while offscreen keeps downloading; when the SW
 * revives, the job is still at 'fetching' in storage so its rule is kept.)
 */
async function sweepStaleSpoofRules(): Promise<void> {
  try {
    const rules = await browser.declarativeNetRequest.getSessionRules();
    const sessionIds = rules.map((r) => r.id);
    const alive = new Set<number>();
    const jobs = await getHlsJobs();
    for (const job of Object.values(jobs)) {
      if (!TERMINAL_PHASES.has(job.phase)) {
        for (const id of job.spoofRuleIds ?? []) alive.add(id);
      }
    }
    const downloads = await getDownloads();
    for (const d of Object.values(downloads)) {
      if (d.state === 'in_progress') {
        for (const id of d.spoofRuleIds ?? []) alive.add(id);
      }
    }
    const stale = staleSpoofRuleIds(sessionIds, alive);
    if (stale.length > 0) await removeSpoofRules(stale);
  } catch {
    // best-effort — the sweep is garbage collection, it must never be allowed to break anything.
  }
}

function isOffscreenTargeted(m: unknown): boolean {
  return (
    typeof m === 'object' &&
    m !== null &&
    (m as { target?: unknown }).target === 'offscreen'
  );
}

function isRuntimeMessage(m: unknown): m is RuntimeMessage {
  return typeof m === 'object' && m !== null && 'kind' in m;
}
