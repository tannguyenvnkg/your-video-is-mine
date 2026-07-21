import {
  buildMediaItem,
  mediaId,
  visibleMedia,
  type BuildMediaInput,
} from '@/utils/detect';
import { describeError } from '@/utils/errors';
import { drmNameFromKeySystem } from '@/utils/drm';
import {
  addChildUrls,
  addTabMedia,
  claimMasterParse,
  clearTabMedia,
  getDownloadByChromeId,
  getDownloads,
  getTabMedia,
  getTabState,
  markTabDrm,
  resetTab,
  setTabNavUrl,
  updateDownload,
  updateHlsJob,
  type DownloadEntry,
  type DownloadState,
  type HlsJob,
} from '@/utils/storage';
import { childUrlsOfMaster, parseHlsManifest } from '@/utils/hls';
import {
  capturedFromHeaderList,
  filterCapturable,
  shouldCaptureRequest,
} from '@/utils/headers';
import type { MediaItem } from '@/utils/types';
import type {
  DownloadProgressResponse,
  HlsProgressResponse,
  ManifestKind,
} from '@/utils/messages';
import { TERMINAL_PHASES } from '@/background/constants';
import { removeSpoofRules, sweepStaleSpoofRules } from '@/background/spoof';
import { withSpoofedFetch, pageUrlFor, capturedFor } from '@/background/net';
import {
  sendToOffscreen,
  handleEngineSelfTest,
} from '@/background/offscreen-bridge';
import { seedNavUrls } from '@/background/title';
import {
  DEAD_JOB_ALARM,
  reapDeadHlsJobs,
  reapDeadDownloads,
} from '@/background/reaper';
import {
  handleVariants,
  handleDownload,
  handleHlsEstimate,
  handleHlsDownload,
  handleBlobDownload,
  handleDownloadCancel,
} from '@/background/handlers';
import { isOffscreenTargeted, isRuntimeMessage } from '@/background/messages';

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
