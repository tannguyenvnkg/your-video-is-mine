import {
  buildMediaItem,
  mediaId,
  visibleMedia,
  type BuildMediaInput,
} from '@/utils/detect';
import { describeError } from '@/utils/errors';
import { DRM_UNSUPPORTED_ERROR, drmNameFromKeySystem } from '@/utils/drm';
import { buildDownloadFilename } from '@/utils/filename';
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
  getHlsJobs,
  getTabMedia,
  getTabState,
  markTabDrm,
  putDownload,
  putHlsJob,
  resetTab,
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
  hostFromUrl,
  originFromUrl,
  staleSpoofRuleIds,
} from '@/utils/dnr';
import type { MediaItem } from '@/utils/types';
import type {
  DownloadProgressResponse,
  DownloadStartResponse,
  FfmpegDemoResponse,
  HlsDownloadResponse,
  HlsEstimateResponse,
  HlsProgressResponse,
  ManifestKind,
  RuntimeMessage,
  VariantsResponse,
} from '@/utils/messages';

// Phase kết thúc của job HLS (done/error/cancelled) — dùng cho cả badge lẫn đối soát rule spoof.
const TERMINAL_PHASES = new Set<HlsPhase>(['done', 'error', 'cancelled']);

export default defineBackground(() => {
  // Serialize ghi storage để tránh race read-modify-write giữa nhiều event.
  // ĐIỀU PHỐI TẠM THỜI trong 1 vòng đời SW; chrome.storage.session mới là NGUỒN SỰ THẬT.
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
      // tab có thể đã đóng.
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
    // W4.2 — mọi .m3u8 đều có thể là master; chỉ đọc nó ra mới biết con của nó là ai.
    if (item.type === 'hls') void learnMasterChildren(input.tabId, item.url);
  }

  /**
   * W4.2 — đọc một master để biết playlist con của nó, rồi ẩn các dòng con khỏi popup.
   *
   * ĐO THẬT (Edge + extension, fixture tách tiếng): một video = 3 dòng "HLS" y hệt nhau
   * (master + video.m3u8 + audio.m3u8) vì webRequest thấy mọi request .m3u8 của player.
   *
   * Vì sao FETCH LẠI master (player vừa fetch rồi): body của request không đọc được từ MV3
   * webRequest — đó là hạn chế của API, không phải lựa chọn. Cú fetch này thường trúng HTTP cache
   * của trình duyệt. Best-effort hoàn toàn: 403/mạng hỏng -> không học được gì -> popup về đúng
   * hành vi cũ (hiện cả 3 dòng), KHÔNG bao giờ chặn đường tải.
   * ⚠️ Hàm này chưa spoof Referer (§2.3, để W2.2 sửa) -> trên site chống hotlink nó sẽ 403 và
   * W4.2 im lặng không có tác dụng. Đó là giới hạn ĐÃ BIẾT, không phải lỗi ẩn.
   */
  async function learnMasterChildren(
    tabId: number,
    url: string,
  ): Promise<void> {
    try {
      // Đã biết là con của master khác -> chắc chắn không phải master -> khỏi tốn một cú fetch.
      const state = await getTabState(tabId);
      if (state.childUrls?.[url]) return;
      // Xí phần TRƯỚC khi fetch: cùng một URL được onBeforeRequest và onHeadersReceived báo hai
      // lần, không xí thì fetch đôi.
      if (!(await serialize(() => claimMasterParse(tabId, url)))) return;

      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return;
      const children = childUrlsOfMaster(
        parseHlsManifest(await res.text(), url),
      );
      if (children.length === 0) return; // media playlist -> không có con.
      const count = await serialize(() => addChildUrls(tabId, url, children));
      if (count !== null) await updateBadge(tabId, count);
    } catch {
      // best-effort: ẩn dòng rác là tiện nghi, không được phép làm hỏng phát hiện.
    }
  }

  // Ghi media dạng blob/MSE (URL blob: không qua classify -> tạo item type 'blob' trực tiếp).
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

  // Ghi manifest HLS/DASH bị nguỵ trang (content script sniff từ body). URL có thể mang đuôi giả
  // (.jpg) nên KHÔNG qua classifyMedia -> tạo item type 'hls'/'dash' TRỰC TIẾP theo mediaType đã nhận.
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
        await resetTab(details.tabId, navAt);
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

  // Router message.
  //
  // HỢP ĐỒNG: trả `true` ĐỒNG BỘ cho mọi nhánh async, rồi gọi `sendResponse` sau.
  // TUYỆT ĐỐI KHÔNG trả Promise: đó là hợp đồng của webextension-polyfill (dự án KHÔNG dùng).
  // Chrome chỉ nhận Promise từ bản 148 và còn "rolling out gradually" -> máy dev (Edge 150) chạy
  // ngon trong khi máy user cũ hơn nhận về `undefined` — KHÔNG phải lỗi, nên `catch` ở
  // utils/messages.ts không bao giờ bắn: popup chỉ lặng lẽ nhận undefined rồi nổ chỗ khác.
  // Chrome docs: `return true` chạy "whether this capability is enabled or not".
  // Ghim bằng tests/background-messaging.test.ts (KHÔNG đặt test trong entrypoints/ — WXT coi mọi
  // file ở đó là entrypoint và `pnpm build` sẽ chết vì trùng tên). Listener KHÔNG được là `async`:
  // hàm `async` LUÔN trả Promise, tức là quay lại đúng lỗi này mà tsc/lint không hề kêu.
  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      sender,
      sendResponse: (response?: unknown) => void,
    ): true | undefined => {
      if (isOffscreenTargeted(message)) return undefined;
      if (!isRuntimeMessage(message)) return undefined;

      // Giữ kênh mở rồi trả lời khi promise xong. Handler tự bắt lỗi và trả {ok:false}, nhưng
      // vẫn phải có nhánh reject: sót một lỗi ngoài dự kiến là popup quay spinner vĩnh viễn.
      const respond = (p: Promise<unknown>): true => {
        void p
          .then(
            (res) => sendResponse(res),
            (e: unknown) =>
              sendResponse({ ok: false, error: describeError(e) }),
          )
          // Kênh đã đóng (user đóng popup giữa chừng) -> sendResponse ném. Không có gì để làm,
          // nhưng không được để unhandled rejection.
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
      if (message.kind === 'ffmpeg/demo') {
        return respond(handleFfmpegDemo());
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
      // Offscreen báo tiến trình -> background ghi hộ vào storage.session.
      // ACK để offscreen `await` được: nhờ vậy các bản cập nhật giữ ĐÚNG THỨ TỰ và lỗi ghi không
      // biến mất trong hư không. ACK này PHẢI đi qua `respond` — trả Promise ở đây thì trên
      // Chrome <148 nó resolve `undefined` NGAY, và thứ tự ghi storage âm thầm mất.
      if (message.kind === 'hls/progress') {
        // W2.7 — MỌI tin từ offscreen đều là một nhịp tim: nghe thấy tiếng nó tức là nó còn sống.
        // Đóng dấu bằng đồng hồ CỦA BACKGROUND (một đồng hồ duy nhất -> không lệch giờ giữa hai
        // ngữ cảnh, và offscreen chết thì dấu tự nhiên ngừng tiến).
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
      // W2.5 — offscreen báo tiến trình/lỗi fetch progressive; background ghi hộ (offscreen không có
      // chrome.storage). ACK qua respond để giữ ĐÚNG THỨ TỰ cập nhật (cùng lý do hls/progress).
      if (message.kind === 'download/progress') {
        const { key, patch } = message;
        // W2.7 — như hls/progress: mọi tin từ offscreen là bằng chứng nó còn sống.
        return respond(
          updateDownload(key, { ...patch, lastSeenAt: Date.now() }).then(
            async (): Promise<DownloadProgressResponse> => {
              // Fetch LỖI (403 giữa chừng/mạng) -> handleBlobDownload KHÔNG bao giờ chạy nên rule
              // spoof của lượt này sẽ RÒ RỈ nguyên phiên nếu không gỡ ở đây (cùng lớp lỗi W2.4).
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
        // W2.7 — TRƯỚC: bắn tin rồi ghi 'cancelled' NGAY, không chờ ai. Tin rớt (offscreen chết/chưa
        // đăng ký listener) thì popup báo "Đã huỷ" trong khi job VẪN CHẠY và vẫn tải file về —
        // đúng nghĩa nói dối người dùng. NAY: chỉ chốt sau khi offscreen xác nhận đã nhận.
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
          // Offscreen KHÔNG nhận được -> nó đã chết, nghĩa là job cũng chết theo (mọi việc tải nằm
          // trong đó). Vẫn phải chốt về trạng thái kết thúc, nếu không job kẹt 'fetching' mãi —
          // nhưng nói ĐÚNG lý do, đừng vờ như huỷ êm đẹp.
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
      // W7.1 — trang xin DRM/EME -> gắn cờ cho tab (ranh giới cứng §7). KHÔNG chặn trang phát video:
      // ta chỉ từ chối TẢI, không phá trải nghiệm xem.
      if (message.kind === 'media/drm') {
        const name = drmNameFromKeySystem(message.keySystem) ?? 'DRM không rõ';
        void markTabDrm(tabId, name).then((isNew) => {
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

  // Theo dõi trạng thái LƯU (chrome.downloads) -> cập nhật storage + thu hồi blob URL khi xong.
  // W2.5: DownloadEntry keyed theo jobId, nên tra NGƯỢC entry qua chromeDownloadId (delta.id là id
  // chrome, không phải khoá). Entry chỉ có chromeDownloadId ở phase LƯU nên chắc chắn tra ra ở đây.
  browser.downloads.onChanged.addListener((delta) => {
    void (async () => {
      const entry = await getDownloadByChromeId(delta.id);
      if (!entry) return; // download không phải của ta (hoặc chưa kịp gắn id — onChanged sớm sẽ bỏ qua).
      const patch: Partial<DownloadEntry> = {};
      if (delta.state) patch.state = delta.state.current as DownloadState;
      if (delta.error?.current) patch.error = delta.error.current;
      if (delta.filename?.current) patch.filename = delta.filename.current;
      if (Object.keys(patch).length > 0) await updateDownload(entry.key, patch);

      const finished =
        delta.state?.current === 'complete' ||
        delta.state?.current === 'interrupted';
      if (finished) {
        // W2.7 — qua helper: offscreen chết thì blob URL cũng chết theo nó, không có gì để thu hồi
        // và cũng không được để lại unhandled rejection.
        if (entry.blobUrl)
          void sendToOffscreen({ kind: 'revoke', url: entry.blobUrl });
        // Xoá session rule spoof cho lượt tải này (không để tồn suốt phiên). W2.4: theo id riêng.
        // (Progressive đã gỡ ở handleBlobDownload khi fetch xong; trùng nhau vô hại.)
        if (entry.spoofRuleIds?.length)
          void removeSpoofRules(entry.spoofRuleIds);
      }
    })();
  });

  // --- Tiến trình HLS -> badge % trên icon + thông báo khi xong/lỗi (v0.5.0) ---

  // % tổng hợp để hiện lên badge theo phase.
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
      // tab có thể đã đóng.
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
      // notifications có thể không khả dụng.
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
        // W2.3/W2.4: dọn MỌI rule spoof của job ở nhánh kết thúc (done/error/cancelled) — KHÔNG phụ
        // thuộc tabId (badge cần tabId, gỡ rule thì không). Nhánh thành công còn dọn thêm ở
        // handleBlobDownload; trùng nhau vô hại (removeRuleIds bỏ qua id không tồn tại).
        if (justFinished && job.spoofRuleIds?.length) {
          void removeSpoofRules(job.spoofRuleIds);
        }
        if (job.tabId == null) continue;
        if (ACTIVE_PHASES.has(job.phase)) {
          await setBadgePct(job.tabId, jobBadgePct(job));
        } else if (justFinished) {
          // Khôi phục badge = số dòng CÒN HIỆN (W4.2: không đếm playlist con đã ẩn).
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

  // W2.4 — đối soát rule spoof rò rỉ. `onStartup` bắn khi mở lại trình duyệt; lời gọi top-level
  // bắn mỗi lần SW cold-start giữa phiên (bắt rule của job đã chết trước đó mà chưa kịp dọn). Job
  // còn sống thì id của nó nằm trong tập "còn sống" nên KHÔNG bị quét nhầm.
  browser.runtime.onStartup.addListener(() => {
    void sweepStaleSpoofRules();
  });
  void sweepStaleSpoofRules();

  // W2.7 — tick dò "bộ xử lý video đã chết". Alarm chứ KHÔNG setInterval: service worker MV3 bị ngủ
  // bất cứ lúc nào và timer chết theo nó, còn alarm thì đánh thức SW dậy để chạy. Chu kỳ 0.5 phút =
  // mức dày nhất Chrome cho phép; ngưỡng chết 60s nên tệ nhất user chờ thêm ~30s.
  browser.alarms.create(DEAD_JOB_ALARM, { periodInMinutes: 0.5 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== DEAD_JOB_ALARM) return;
    void reapDeadHlsJobs();
    void reapDeadDownloads();
  });
  // Chạy luôn một lượt lúc SW cold-start: nếu SW vừa hồi sinh sau khi cả nó lẫn offscreen bị giết,
  // job mồ côi phải được chốt NGAY chứ không đợi hết chu kỳ alarm.
  void reapDeadHlsJobs();
  void reapDeadDownloads();
});

const DEAD_JOB_ALARM = 'w27-dead-job-tick';

/**
 * W2.7 — chốt LỖI cho job mà offscreen đã chết giữa chừng (§2.14).
 *
 * Vì sao cần: offscreen chết IM LẶNG — Chrome không bắn sự kiện nào về background. Không có tick
 * này thì job nằm lại 'fetching' VĨNH VIỄN và popup quay spinner không lời giải thích, đúng kết cục
 * tệ nhất của một app tải: user không biết nên chờ tiếp hay bấm lại.
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
      // Rule spoof của job chết là rác: nó không tự dọn được nữa (nhánh kết thúc bình thường không
      // bao giờ chạy). Cùng lớp lỗi rò rỉ W2.4.
      const ids = jobs[id]?.spoofRuleIds;
      if (ids?.length) await removeSpoofRules(ids);
    }
    console.warn(`[bg] W2.7: chốt lỗi ${dead.length} job do offscreen đã chết`);
  } catch (e) {
    // Tick định kỳ KHÔNG được phép ném: ném ở đây là unhandled rejection mỗi 30 giây.
    console.warn('[bg] tick dò job chết lỗi:', describeError(e));
  }
}

/**
 * W2.7 — chốt LỖI cho lượt tải PROGRESSIVE mà offscreen đã chết giữa lúc fetch.
 *
 * Vì sao đường này cũng cần (dễ bỏ sót): W2.5 chuyển .mp4 sang fetch trong offscreen để mang được
 * Referer spoof — từ đó nó phụ thuộc offscreen y như HLS, nhưng lưới liveness ban đầu chỉ phủ HLS.
 * ĐÃ ĐO bằng e2e `progressive-offscreen-death`: entry kẹt `in_progress` >150s.
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
      // Rule spoof của lượt chết không tự dọn được nữa: nhánh kết thúc bình thường (handleBlobDownload
      // / download/progress 'interrupted') không bao giờ chạy. Cùng lớp rò rỉ W2.4.
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
 * W2.2 — bật spoof Referer/Origin ÔM SÁT một cú fetch rồi gỡ ngay trong `finally`.
 *
 * §2.3: `handleVariants`/`handleHlsEstimate` là HAI cú fetch ĐẦU TIÊN của flow, mà trước đây chúng
 * fetch trần ⇒ site chống hotlink 403 ngay bước "Chất lượng", `handleHlsDownload` (hàm CÓ spoof)
 * không bao giờ được gọi tới ⇒ tính năng vượt 403 là code chết đúng trên site cần nó nhất.
 *
 * `pageUrl` (từ `media.pageUrl` tra theo tabId) là Referer THẬT của trang — quan trọng vì hotlink
 * thường kiểm Referer khớp domain site, không phải domain CDN. Thiếu pageUrl thì applySpoof tự lùi
 * về dùng chính targetUrl (đủ qua cổng "thiếu Referer", nhưng kém khớp trên site kiểm domain).
 *
 * W2.4: cấp id RIÊNG cho mỗi cú fetch (allocateSpoofRuleId) rồi gỡ đúng id đó -> hai lượt tải/ước
 * lượng trên CÙNG host không còn giật rule của nhau (giới hạn W2.2 cũ đã hết).
 */
async function withSpoofedFetch<T>(
  targetUrl: string,
  pageUrl: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const ruleId = await allocateSpoofRuleId();
  await applySpoof(ruleId, targetUrl, pageUrl);
  try {
    return await fn();
  } finally {
    await removeSpoofRules([ruleId]);
  }
}

/**
 * pageUrl để dựng Referer thật. Ưu tiên item khớp `url` (master); nếu không (vd estimate chỉ có
 * URL variant, không khớp media nào) thì lùi về pageUrl của item bất kỳ trên tab — pageUrl thực chất
 * là của cả TRANG (resetTab xoá sạch khi điều hướng nên mọi item cùng một trang). undefined khi
 * không có tabId hoặc tab chưa có media nào.
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

async function handleVariants(
  url: string,
  mediaType: ManifestKind,
  tabId?: number,
): Promise<VariantsResponse> {
  try {
    const pageUrl = await pageUrlFor(tabId, url);
    // W2.2: spoof TRƯỚC khi fetch — 403 không được giết bước chọn chất lượng.
    const res = await withSpoofedFetch(url, pageUrl, () =>
      fetch(url, { credentials: 'include' }),
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
  // W7.1 — RANH GIỚI CỨNG §7: chặn cả đường progressive, không chỉ HLS.
  const drmBlocked = await drmBlockReason(tabId);
  if (drmBlocked) return { ok: false, error: drmBlocked };
  // W2.5 — ĐỊNH TUYẾN QUA OFFSCREEN thay vì chrome.downloads.download({url}) thẳng.
  // ĐO 2026-07-18: cú download thẳng KHÔNG nhận rule DNR modifyHeaders (server nhận Referer:NONE ->
  // 403 trên site chống hotlink). fetch() của offscreen là xmlhttprequest tab-less -> KHỚP rule spoof
  // -> qua 403. chrome.downloads.download từ nay chỉ nhận blob: URL (bất biến VDH).
  //
  // Hoist ra ngoài try để catch dọn được: rule áp TRƯỚC ensureOffscreen; nếu ném trước khi putDownload
  // thì id chưa lưu ở đâu -> chỉ sweep cold-start dọn. Gỡ ngay ở catch để không rò rỉ nguyên phiên.
  let ruleId: number | undefined;
  const key = crypto.randomUUID();
  try {
    const media = (await getTabMedia(tabId)).find((m) => m.url === url);
    // Spoof Referer/Origin để vượt hotlink-protection/403 (non-DRM). Id riêng cho lượt tải này (W2.4).
    ruleId = await allocateSpoofRuleId();
    await applySpoof(ruleId, url, media?.pageUrl);
    const folder = await getDownloadFolder();
    const filename = buildDownloadFilename({
      url,
      title: media?.title,
      height: media?.height,
      contentType: media?.contentType,
      folder,
    });
    // Entry in-flight (phase FETCH trong offscreen) — chưa có chromeDownloadId, popup hiện "Đang tải…".
    await putDownload({
      key,
      mediaUrl: url,
      filename,
      state: 'in_progress',
      startedAt: Date.now(),
      // W2.7 — nhịp tim đầu tiên: phủ cả ca "offscreen chết trước khi kịp nhận việc".
      lastSeenAt: Date.now(),
      spoofRuleIds: [ruleId],
    });
    await ensureOffscreen();
    // KHÔNG await: offscreen fetch có thể chạy lâu, báo tiến trình qua download/progress. NHƯNG phải
    // bắt lỗi gửi (offscreen chưa đăng ký listener) -> nếu không entry kẹt 'in_progress' vĩnh viễn.
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
    // Dọn rule đã áp nhưng chưa kịp giao offscreen — tránh rò rỉ nguyên phiên.
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

/** Máy chủ trả mã lỗi — giữ lại `status` để thông báo còn chỉ đúng hướng (403 = chống hotlink). */
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/**
 * W7.1 — RANH GIỚI CỨNG §7. Tab đã lộ dùng DRM/EME thì mọi đường TẢI đóng lại, báo rõ lý do.
 *
 * Trả câu lỗi nếu phải chặn, `null` nếu sạch. Đặt ở background (không phải popup) vì popup chỉ là
 * một trong các đường vào — chặn ở đây thì mọi đường đều bịt.
 *
 * 🔴 Đây là mã TỪ CHỐI, không phải mã giải mã: ta chỉ nhận diện để nói "không hỗ trợ".
 */
async function drmBlockReason(tabId?: number): Promise<string | null> {
  if (tabId === undefined || tabId < 0) return null;
  try {
    const systems = (await getTabState(tabId)).drmSystems ?? [];
    if (systems.length === 0) return null;
    // Bỏ mục chung nếu đã biết đích danh hãng -> thông báo nói đúng tên thay vì "không rõ".
    const named = systems.filter((s) => s !== 'DRM không rõ');
    return DRM_UNSUPPORTED_ERROR(
      named.length > 0 ? named.join(', ') : undefined,
    );
  } catch {
    return null; // đọc storage hỏng -> đừng chặn oan.
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
  // W7.1 — cờ DRM của TAB (EME) là tín hiệu ĐỘC LẬP với playlist: SAMPLE-AES lộ trong playlist,
  // còn Widevine/PlayReady KHÔNG để lại dấu nào ở đó mà chỉ lộ qua EME. Biết trước thì trả lời
  // ngay, khỏi tốn một request nào.
  const drmBlocked = await drmBlockReason(tabId);
  if (drmBlocked) {
    return {
      ok: true,
      protected: true,
      segmentCount: 0,
      durationSec: 0,
    };
  }
  // W2.2: spoof Referer/Origin quanh cú fetch ước lượng — cùng lý do §2.3 như handleVariants.
  // Ước lượng thường trỏ cùng host với hình; host tiếng khác (nếu có) là phần W2.3 phủ đầy đủ.
  const pageUrl = await pageUrlFor(tabId, variantUrl);
  try {
    return await withSpoofedFetch(variantUrl, pageUrl, () =>
      estimateFromPlaylists(
        variantUrl,
        bandwidth,
        audioUrl,
        mediaType,
        variantId,
        audioId,
      ),
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
  // Mã HTTP PHẢI sống sót tới tay user: "Máy chủ trả mã 403." chỉ thẳng vào chống hotlink,
  // còn "mạng hoặc CORS" chỉ sai hướng hoàn toàn — đúng kiểu "lý do thật bốc hơi" mà chính
  // phiên này vừa vá ở khâu ffmpeg. Ném HttpError riêng để khối catch phân biệt được.
  const fetchParse = async (url: string) => {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new HttpError(res.status);
    return parseTrackSegments(await res.text(), url, mediaType, variantId);
  };
  // W1.1: job sẽ tải CẢ playlist tiếng -> ước lượng phải soi cả nó, nếu không popup báo
  // "10 segment" rồi thanh tiến trình chạy tới 21 — trông như lỗi.
  //
  // ⚠️ Playlist tiếng hỏng KHÔNG được chặn đường tải: đây chỉ là bước ƯỚC LƯỢNG. Host tiếng có
  // thể khác host hình nên spoof của estimate (chỉ phủ host hình) không tới nó -> trên site chống
  // hotlink, playlist tiếng rất dễ 403 ở đây rồi vẫn tải ngon ở handleHlsDownload. Để Promise.all
  // reject thì user mất luôn nút tải vì một con số ước lượng — đổi một phiền toái nhỏ lấy ngõ cụt.
  // W1.5 — DASH để hình VÀ tiếng trong CÙNG một file .mpd, nên `variantUrl === audioUrl`. Gọi
  // fetchParse hai lần sẽ tải nguyên manifest hai lượt cho đúng một con số ước lượng; tải một lần
  // rồi parse hai track là đủ và không đụng mạng thêm.
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
  // Thời lượng là MAX chứ KHÔNG phải tổng: hình và tiếng chạy SONG SONG, không nối đuôi.
  const durationSec = Math.max(parsed.totalDuration, audio?.totalDuration ?? 0);
  // BANDWIDTH của #EXT-X-STREAM-INF đã gồm cả rendition tiếng (RFC 8216 §4.3.4.2) -> KHÔNG
  // cộng thêm, cộng nữa là đếm đôi.
  const estBytes =
    bandwidth && bandwidth > 0
      ? Math.round((bandwidth / 8) * durationSec)
      : undefined;
  return {
    ok: true,
    protected: parsed.isProtected || (audio?.isProtected ?? false),
    segmentCount: parsed.segments.length + (audio?.segments.length ?? 0),
    durationSec,
    estBytes,
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
  // W7.1 — RANH GIỚI CỨNG §7: từ chối NGAY, trước khi áp một rule spoof hay bắn một request nào.
  const drmBlocked = await drmBlockReason(tabId);
  if (drmBlocked) return { ok: false, error: drmBlocked };
  // Hoist ra ngoài try để catch còn dọn được: nếu throw xảy ra TRƯỚC putHlsJob thì id chưa lưu ở
  // đâu; nếu ensureOffscreen ném SAU putHlsJob thì job kẹt 'queued' (storage.onChanged không có
  // nhánh terminal để dọn) -> gỡ thẳng theo id đang giữ là chắc chắn nhất.
  const spoofRuleIds: number[] = [];
  try {
    const media = (await getTabMedia(tabId)).find((m) => m.url === mediaUrl);
    const pageUrl = media?.pageUrl;
    // Mọi rule đã spoof PHẢI được theo dõi để còn DỌN: rule DNR session sống hết phiên trình duyệt
    // (§2.10) -> sót một cái là rác tới lúc đóng trình duyệt. W2.4: mỗi host một id RIÊNG (không
    // suy từ host) nên hai download cùng host không giật rule của nhau. `spoofedHosts` chỉ để DEDUPE
    // (một host một rule cho job này), còn `spoofRuleIds` là thứ đem đi dọn.
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
      await applySpoof(ruleId, url, pageUrl);
      spoofedHosts.add(host);
      spoofRuleIds.push(ruleId);
    };
    // Spoof host playlist hình + tiếng (tiếng có thể ở CDN riêng — W1.1).
    await spoof(variantUrl);
    if (audioUrl) await spoof(audioUrl);
    // W2.3: parse playlist TRƯỚC rồi spoof MỌI host của segment/key/init. Chúng rất hay ở CDN khác
    // host với playlist (key AES gần như LUÔN khác, lại là thứ hay kiểm Referer nhất) -> bỏ sót là
    // job tới 'fetching' rồi mọi segment 403. Rule áp XONG ở đây, TRƯỚC khi offscreen tải segment.
    // Best-effort: playlist 403 ở bước này thì offscreen vẫn tự thử lại; ta chỉ mất phần "khác host".
    //
    // W1.5 — parse theo ĐÚNG định dạng: nạp .mpd vào parser HLS thì ra 0 segment mà KHÔNG ném lỗi
    // -> 0 host segment được spoof -> job chạy tới 'fetching' rồi 403 sạch, im lặng.
    // DASH để cả hình lẫn tiếng trong một .mpd nên dedupe theo URL: cùng một tài liệu, hai track.
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
        // DASH SegmentBase: cả representation chỉ là MỘT file .mp4 tải thẳng được -> không có
        // segment nào để ghép. Đẩy sang luồng progressive (W2.5) thay vì để offscreen báo
        // "playlist không có segment nào" — đúng chữ nhưng sai hẳn nguyên nhân.
        if (parsed.directUrl) await spoof(parsed.directUrl);
      } catch {
        // best-effort — không được để việc dò host làm hỏng đường tải.
      }
    }
    const folder = await getDownloadFolder();
    const filename = buildDownloadFilename({
      url: variantUrl,
      title: media?.title,
      height: height ?? media?.height,
      folder,
    });
    const jobId = crypto.randomUUID();
    await putHlsJob({
      id: jobId,
      mediaUrl,
      variantUrl,
      // 'queued' chứ KHÔNG phải 'loading': offscreen chưa chạy dòng nào. Chỉ offscreen mới được
      // đặt 'loading' (main.ts), nhờ vậy job kẹt ở 'queued' = message không tới nơi.
      phase: 'queued',
      segmentsTotal: 0,
      segmentsDone: 0,
      filename,
      tabId,
      // W2.7 — nhịp tim ĐẦU TIÊN đặt ngay lúc sinh job. Nhờ vậy ca "offscreen chết trước khi kịp
      // nhận việc" (job kẹt 'queued') cũng có mốc thời gian để tick dò ra, chứ không nằm ngoài lưới.
      lastSeenAt: Date.now(),
      // Lưu để DỌN ở MỌI nhánh kết thúc (done/error/cancelled), không chỉ nhánh thành công qua
      // handleBlobDownload — W2.3 mở rộng tập host nên rò rỉ khi lỗi sẽ nặng hơn nếu không dọn.
      spoofRuleIds,
    });
    await ensureOffscreen();
    // KHÔNG await: job chạy dài, offscreen báo tiến trình qua storage chứ không qua response.
    // NHƯNG phải bắt lỗi — nuốt ở đây thì message rớt (vd offscreen chưa đăng ký listener) sẽ khiến
    // job kẹt 'queued' VĨNH VIỄN mà không một dòng lỗi nào hiện ra.
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
        // W1.5 — thiếu 3 trường này thì offscreen nạp .mpd vào parser HLS và job chết câm.
        mediaType,
        variantId,
        audioId,
        // Offscreen không đọc được settings (không có chrome.storage) -> đọc hộ rồi truyền vào.
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
    // Dọn mọi rule đã áp trước khi throw (xem chú thích hoist ở đầu hàm) — nếu không, id mồ côi
    // chỉ được sweep cold-start dọn.
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
  // Bytes đã lấy xong -> xoá rule spoof của MỌI host (HLS: hình/tiếng/segment; progressive: 1 host).
  if (spoofRuleIds?.length) void removeSpoofRules(spoofRuleIds);
  // W2.5: progressive giao qua downloadKey -> GẮN chromeDownloadId vào ĐÚNG entry đang fetch (đừng
  // tạo mới, kẻo popup thấy 2 dòng). HLS không có downloadKey -> tạo entry keyed theo jobId.
  const key = downloadKey ?? jobId;
  try {
    const downloadId = await browser.downloads.download({
      url: blobUrl,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    if (downloadKey) {
      // User đã HUỶ trong lúc fetch->save (entry 'interrupted' rồi, lúc đó chưa có chromeDownloadId nên
      // handleDownloadCancel chỉ abort offscreen — vô hại vì fetch xong) -> huỷ luôn download blob vừa
      // tạo + thu hồi, ĐỪNG ghi 'complete' đè lên cancel của user.
      const cur = (await getDownloads())[key];
      if (cur?.state === 'interrupted') {
        void browser.downloads.cancel(downloadId).catch(() => undefined);
        void sendToOffscreen({ kind: 'revoke', url: blobUrl });
        return;
      }
      // Entry đã có (phase fetch) -> merge id thật + blobUrl; state giữ in_progress (onChanged flip).
      await updateDownload(key, { chromeDownloadId: downloadId, blobUrl });
      // Chống race: blob nhỏ có thể COMPLETE trước khi downloads.onChanged khớp được entry (lúc đó
      // chromeDownloadId chưa persist -> onChanged bỏ qua -> entry kẹt 'in_progress'). Đọc lại state
      // NGAY: nếu đã terminal thì ghi luôn + thu hồi blob (khỏi phụ thuộc timing của onChanged).
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
    // Không lưu được -> báo lỗi ĐÚNG nơi popup đang nhìn: progressive nhìn DownloadEntry, HLS nhìn job.
    const msg = e instanceof Error ? e.message : 'Không lưu được file về máy.';
    if (downloadKey) {
      await updateDownload(key, { state: 'interrupted', error: msg });
    } else {
      await updateHlsJob(jobId, { phase: 'error', error: msg });
    }
  }
}

/**
 * W2.5 — huỷ một lượt tải progressive theo KHOÁ. Hai phase, hai cách huỷ:
 * - đã có chromeDownloadId (đang LƯU) -> chrome.downloads.cancel;
 * - chưa (đang FETCH trong offscreen) -> báo offscreen abort cú fetch + gỡ rule spoof + đánh dấu huỷ.
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

async function handleFfmpegDemo(): Promise<FfmpegDemoResponse> {
  try {
    await ensureOffscreen();
    const res = await browser.runtime.sendMessage({
      target: 'offscreen',
      kind: 'ffmpeg/demo',
    });
    // W2.7 — offscreen chết/chưa đăng ký listener thì `sendMessage` resolve UNDEFINED chứ không ném.
    // Trả thẳng cái đó ra là đưa `undefined` cho popup -> nút "Kiểm tra ffmpeg" im lìm không nói gì.
    // Hợp đồng của hàm này là LUÔN trả một object đọc được.
    if (!res || typeof res !== 'object') {
      return {
        ok: false,
        error:
          'Bộ xử lý video không trả lời (có thể đã bị trình duyệt thu hồi).',
      };
    }
    return res as FfmpegDemoResponse;
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Không chạy được offscreen.',
    };
  }
}

/**
 * W2.7 — offscreen document có đang SỐNG không?
 *
 * `getContexts` là câu hỏi trực tiếp tới trình duyệt, khác hẳn cách cũ "cứ gửi rồi xem có ném
 * không": offscreen chết là một NHÁNH BÌNH THƯỜNG cần xử lý, không phải một rejection bất ngờ.
 * (API có từ Chrome 116; thiếu thì trả `true` để giữ nguyên hành vi cũ thay vì chặn oan.)
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
    return true; // API lỗi -> đừng chặn oan, cứ thử gửi như cũ.
  }
}

/**
 * W2.7 — gửi tin sang offscreen, KHÔNG BAO GIỜ ném và không bao giờ tạo unhandled rejection.
 *
 * Trả `true` nếu offscreen thực sự nhận được. Trước W2.7 hai chỗ (`hls/cancel`, `revoke`) gọi
 * `sendMessage` trần không `.catch` -> offscreen chết thì sinh unhandled rejection, mà tệ hơn là
 * caller vẫn đinh ninh tin đã tới nơi.
 */
async function sendToOffscreen(msg: Record<string, unknown>): Promise<boolean> {
  if (!(await isOffscreenAlive())) return false;
  try {
    await browser.runtime.sendMessage({ target: 'offscreen', ...msg });
    return true;
  } catch (e) {
    // Ca thường gặp: offscreen vừa chết GIỮA lúc dò và lúc gửi (đua nhau), hoặc chưa kịp đăng ký
    // listener. Không phải lỗi chí mạng — caller tự quyết dựa vào `false`.
    console.warn('[bg] không gửi được tin sang offscreen:', describeError(e));
    return false;
  }
}

/**
 * W2.7 — `singleFlight` diệt race "hai job cùng gọi createDocument".
 *
 * Trước W2.7: hai `handleHlsDownload` gọi sát nhau -> cả hai vào `createDocument`; cái thứ hai ném
 * "single offscreen document" rồi bị NUỐT như thể bình thường, nên nó bắn `hls/run` vào một
 * document CÓ THỂ chưa đăng ký listener xong -> job kẹt 'queued' vĩnh viễn, không một dòng lỗi.
 * Nay lượt thứ hai chờ ĐÚNG promise của lượt đầu, nên khi nó chạy tiếp thì document đã sẵn sàng.
 */
const ensureOffscreen = singleFlight(async (): Promise<void> => {
  // Dò trước: đã sống thì khỏi cần đụng createDocument (khỏi phải bắt lỗi "đã tồn tại" cho vui).
  if (await isOffscreenAlive()) return;
  try {
    await browser.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification:
        'Chạy ffmpeg.wasm để ghép/remux video và tạo blob URL để tải.',
    });
  } catch (e) {
    // Mỗi extension chỉ được 1 offscreen document -> "đã tồn tại" là BÌNH THƯỜNG, bỏ qua.
    // Mọi lỗi khác (tạo document hỏng thật) PHẢI ném lên: nuốt hết thì caller tưởng offscreen sống
    // và job sẽ treo mãi không lời giải thích.
    if (!/single offscreen document/i.test(describeError(e))) throw e;
  }
});

// Trần số host được spoof cho một job (VDH cap tổng ~750 rule; ở đây một job hiếm khi quá vài host,
// đặt trần để một manifest dị dạng không sinh hàng trăm rule).
const MAX_SPOOF_HOSTS = 64;

// Áp session rule DNR spoof Referer/Origin cho host của media (vượt hotlink/403 non-DRM).
// W2.4: `ruleId` do caller cấp (allocateSpoofRuleId) — id riêng mỗi (download, host) nên hai lượt
// tải cùng host không giật rule của nhau.
async function applySpoof(
  ruleId: number,
  targetUrl: string,
  pageUrl?: string,
): Promise<void> {
  const host = hostFromUrl(targetUrl);
  if (!host) return;
  const refererBase =
    pageUrl && pageUrl.startsWith('http') ? pageUrl : targetUrl;
  const origin = originFromUrl(refererBase);
  if (!origin) return;
  const rule = buildRefererSpoofRule(ruleId, host, refererBase, origin);
  try {
    // Cast: DnrRule (string literals) tương thích cấu trúc với kiểu Rule của API.
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [rule.id],
      addRules: [rule],
    } as unknown as Parameters<
      typeof browser.declarativeNetRequest.updateSessionRules
    >[0]);
  } catch {
    // Thiếu host access hoặc API lỗi -> bỏ qua (vẫn thử tải không spoof).
  }
}

// Xoá session rule spoof theo id (W2.4: id riêng mỗi download). removeRuleIds bỏ qua id không tồn
// tại nên gọi trùng vô hại.
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
 * W2.4 — đối soát & dọn rule spoof rò rỉ: xoá mọi session rule trong dải spoof mà KHÔNG còn
 * job/download nào sống dùng tới.
 *
 * Vì sao BẮT BUỘC: id theo bộ đếm mất tính "re-add cùng host thay thế rule cũ" mà hash-host từng
 * cho, nên rule của một job chết (SW bị giết giữa chừng, không kịp dọn) sẽ nằm lại tới lúc restart
 * trình duyệt. Gọi lúc `onStartup` (mở lại trình duyệt) và mỗi lần SW cold-start giữa phiên.
 *
 * An toàn với job đang chạy: job còn sống nằm trong storage ở phase chưa kết thúc -> id của nó vào
 * tập "còn sống" -> KHÔNG bị quét. (SW có thể chết trong khi offscreen vẫn tải; khi SW hồi sinh,
 * job vẫn ở 'fetching' trong storage nên rule của nó được giữ.)
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
    // best-effort — sweep là dọn rác, không được để nó làm hỏng gì.
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
