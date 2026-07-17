import {
  buildMediaItem,
  mediaId,
  visibleMedia,
  type BuildMediaInput,
} from '@/utils/detect';
import { describeError } from '@/utils/errors';
import { buildDownloadFilename } from '@/utils/filename';
import {
  addChildUrls,
  addTabMedia,
  allocateSpoofRuleId,
  claimMasterParse,
  clearTabMedia,
  getConcurrency,
  getDownloadById,
  getDownloadFolder,
  getDownloads,
  getHlsJobs,
  getTabMedia,
  getTabState,
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
  parseHlsSegments,
  spoofTargetsFromSegments,
} from '@/utils/hls';
import { parseDashManifest } from '@/utils/dash';
import {
  buildRefererSpoofRule,
  hostFromUrl,
  originFromUrl,
  staleSpoofRuleIds,
} from '@/utils/dnr';
import type { MediaItem } from '@/utils/types';
import type {
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
          ),
        );
      }
      // Offscreen báo tiến trình -> background ghi hộ vào storage.session.
      // ACK để offscreen `await` được: nhờ vậy các bản cập nhật giữ ĐÚNG THỨ TỰ và lỗi ghi không
      // biến mất trong hư không. ACK này PHẢI đi qua `respond` — trả Promise ở đây thì trên
      // Chrome <148 nó resolve `undefined` NGAY, và thứ tự ghi storage âm thầm mất.
      if (message.kind === 'hls/progress') {
        return respond(
          updateHlsJob(message.jobId, message.patch).then(
            (): HlsProgressResponse => ({ ok: true }),
          ),
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
        );
        return undefined;
      }
      if (message.kind === 'hls/cancel') {
        void browser.runtime.sendMessage({
          target: 'offscreen',
          kind: 'hls/cancel',
          jobId: message.jobId,
        });
        void updateHlsJob(message.jobId, {
          phase: 'cancelled',
          error: 'Đã huỷ',
        });
        return undefined;
      }
      if (message.kind === 'download/cancel') {
        void browser.downloads
          .cancel(message.downloadId)
          .catch(() => undefined);
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

  // Theo dõi trạng thái tải -> cập nhật storage + thu hồi blob URL khi xong.
  browser.downloads.onChanged.addListener((delta) => {
    void (async () => {
      const patch: Partial<DownloadEntry> = {};
      if (delta.state) patch.state = delta.state.current as DownloadState;
      if (delta.error?.current) patch.error = delta.error.current;
      if (delta.filename?.current) patch.filename = delta.filename.current;
      if (Object.keys(patch).length > 0) await updateDownload(delta.id, patch);

      const finished =
        delta.state?.current === 'complete' ||
        delta.state?.current === 'interrupted';
      if (finished) {
        const entry = await getDownloadById(delta.id);
        if (entry?.blobUrl) {
          void browser.runtime.sendMessage({
            target: 'offscreen',
            kind: 'revoke',
            url: entry.blobUrl,
          });
        }
        // Xoá session rule spoof cho lượt tải này (không để tồn suốt phiên). W2.4: theo id riêng.
        if (entry?.spoofRuleIds?.length)
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
});

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
  // Hoist ra ngoài try để nhánh catch còn dọn được: rule đã áp TRƯỚC downloads.download(); nếu cú
  // đó ném (Chrome từ chối tên/URL, policy chặn, hết đĩa) thì putDownload không chạy -> id không
  // được lưu vào download nào -> chỉ sweep cold-start mới dọn. Gỡ ngay ở catch để không rò rỉ phiên.
  let ruleId: number | undefined;
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
    const downloadId = await browser.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    await putDownload({
      id: downloadId,
      mediaUrl: url,
      filename,
      state: 'in_progress',
      spoofRuleIds: [ruleId],
    });
    return { ok: true, downloadId };
  } catch {
    // Dọn rule đã áp nhưng chưa kịp gán chủ (id chưa vào download nào) — tránh rò rỉ nguyên phiên.
    if (ruleId !== undefined) await removeSpoofRules([ruleId]);
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

async function handleHlsEstimate(
  variantUrl: string,
  bandwidth?: number,
  audioUrl?: string,
  tabId?: number,
): Promise<HlsEstimateResponse> {
  // W2.2: spoof Referer/Origin quanh cú fetch ước lượng — cùng lý do §2.3 như handleVariants.
  // Ước lượng thường trỏ cùng host với hình; host tiếng khác (nếu có) là phần W2.3 phủ đầy đủ.
  const pageUrl = await pageUrlFor(tabId, variantUrl);
  try {
    return await withSpoofedFetch(variantUrl, pageUrl, () =>
      estimateFromPlaylists(variantUrl, bandwidth, audioUrl),
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
): Promise<HlsEstimateResponse> {
  // Mã HTTP PHẢI sống sót tới tay user: "Máy chủ trả mã 403." chỉ thẳng vào chống hotlink,
  // còn "mạng hoặc CORS" chỉ sai hướng hoàn toàn — đúng kiểu "lý do thật bốc hơi" mà chính
  // phiên này vừa vá ở khâu ffmpeg. Ném HttpError riêng để khối catch phân biệt được.
  const fetchParse = async (url: string) => {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new HttpError(res.status);
    return parseHlsSegments(await res.text(), url);
  };
  // W1.1: job sẽ tải CẢ playlist tiếng -> ước lượng phải soi cả nó, nếu không popup báo
  // "10 segment" rồi thanh tiến trình chạy tới 21 — trông như lỗi.
  //
  // ⚠️ Playlist tiếng hỏng KHÔNG được chặn đường tải: đây chỉ là bước ƯỚC LƯỢNG. Host tiếng có
  // thể khác host hình nên spoof của estimate (chỉ phủ host hình) không tới nó -> trên site chống
  // hotlink, playlist tiếng rất dễ 403 ở đây rồi vẫn tải ngon ở handleHlsDownload. Để Promise.all
  // reject thì user mất luôn nút tải vì một con số ước lượng — đổi một phiền toái nhỏ lấy ngõ cụt.
  const [parsed, audio] = await Promise.all([
    fetchParse(variantUrl),
    audioUrl ? fetchParse(audioUrl).catch(() => null) : Promise.resolve(null),
  ]);
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
): Promise<HlsDownloadResponse> {
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
    for (const pl of audioUrl ? [variantUrl, audioUrl] : [variantUrl]) {
      try {
        const res = await fetch(pl, { credentials: 'include' });
        if (!res.ok) continue;
        const parsed = parseHlsSegments(await res.text(), pl);
        for (const url of spoofTargetsFromSegments(parsed.segments)) {
          await spoof(url);
        }
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
): Promise<void> {
  // Segment đã fetch xong -> xoá rule spoof của MỌI host của job (hình + tiếng nếu khác host).
  if (spoofRuleIds?.length) void removeSpoofRules(spoofRuleIds);
  try {
    const downloadId = await browser.downloads.download({
      url: blobUrl,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    await putDownload({
      id: downloadId,
      mediaUrl,
      filename,
      state: 'in_progress',
      blobUrl,
    });
  } catch (e) {
    // Không tải được -> báo job lỗi (nếu không popup kẹt ở "đang lưu về máy").
    await updateHlsJob(jobId, {
      phase: 'error',
      error: e instanceof Error ? e.message : 'Không lưu được file về máy.',
    });
  }
}

async function handleFfmpegDemo(): Promise<FfmpegDemoResponse> {
  try {
    await ensureOffscreen();
    const res = await browser.runtime.sendMessage({
      target: 'offscreen',
      kind: 'ffmpeg/demo',
    });
    return res as FfmpegDemoResponse;
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Không chạy được offscreen.',
    };
  }
}

async function ensureOffscreen(): Promise<void> {
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
}

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
