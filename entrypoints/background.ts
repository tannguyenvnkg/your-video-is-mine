import { buildMediaItem, mediaId, type BuildMediaInput } from '@/utils/detect';
import { describeError } from '@/utils/errors';
import { buildDownloadFilename } from '@/utils/filename';
import {
  addTabMedia,
  clearTabMedia,
  getConcurrency,
  getDownloadById,
  getDownloadFolder,
  getTabMedia,
  putDownload,
  putHlsJob,
  resetTab,
  updateDownload,
  updateHlsJob,
  type DownloadEntry,
  type DownloadState,
  type HlsJob,
} from '@/utils/storage';
import { parseHlsManifest, parseHlsSegments } from '@/utils/hls';
import { parseDashManifest } from '@/utils/dash';
import {
  buildRefererSpoofRule,
  hostFromUrl,
  originFromUrl,
  spoofRuleId,
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
  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      sender,
    ):
      | undefined
      | Promise<
          | VariantsResponse
          | DownloadStartResponse
          | FfmpegDemoResponse
          | HlsEstimateResponse
          | HlsDownloadResponse
          | HlsProgressResponse
        > => {
      if (isOffscreenTargeted(message)) return undefined;
      if (!isRuntimeMessage(message)) return undefined;

      if (message.kind === 'manifest/variants') {
        return handleVariants(message.url, message.mediaType);
      }
      if (message.kind === 'download/progressive') {
        return handleDownload(message.url, message.tabId);
      }
      if (message.kind === 'ffmpeg/demo') {
        return handleFfmpegDemo();
      }
      if (message.kind === 'hls/estimate') {
        return handleHlsEstimate(message.variantUrl, message.bandwidth);
      }
      if (message.kind === 'hls/download') {
        return handleHlsDownload(
          message.variantUrl,
          message.mediaUrl,
          message.tabId,
          message.height,
        );
      }
      // Offscreen báo tiến trình -> background ghi hộ vào storage.session.
      // Trả về promise để offscreen `await` được: nhờ vậy các bản cập nhật giữ ĐÚNG THỨ TỰ và
      // lỗi ghi không biến mất trong hư không.
      if (message.kind === 'hls/progress') {
        return updateHlsJob(message.jobId, message.patch).then(() => ({
          ok: true,
        }));
      }
      if (message.kind === 'download/blob') {
        void handleBlobDownload(
          message.blobUrl,
          message.filename,
          message.mediaUrl,
          message.tabId,
          message.jobId,
          message.spoofHost,
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
        // Xoá session rule spoof Referer/Origin cho host này (không để tồn suốt phiên).
        if (entry?.spoofHost) void removeSpoof(entry.spoofHost);
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
  const DONE_PHASES = new Set(['done', 'error', 'cancelled']);

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session' || !changes.hlsjobs) return;
    const oldJobs = (changes.hlsjobs.oldValue ?? {}) as Record<string, HlsJob>;
    const newJobs = (changes.hlsjobs.newValue ?? {}) as Record<string, HlsJob>;
    void (async () => {
      for (const [id, job] of Object.entries(newJobs)) {
        if (job.tabId == null) continue;
        const prevPhase = oldJobs[id]?.phase;
        if (ACTIVE_PHASES.has(job.phase)) {
          await setBadgePct(job.tabId, jobBadgePct(job));
        } else if (DONE_PHASES.has(job.phase) && prevPhase !== job.phase) {
          // Khôi phục badge số lượng media của tab.
          const count = (await getTabMedia(job.tabId)).length;
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
});

async function handleVariants(
  url: string,
  mediaType: ManifestKind,
): Promise<VariantsResponse> {
  try {
    const res = await fetch(url, { credentials: 'include' });
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
  try {
    const media = (await getTabMedia(tabId)).find((m) => m.url === url);
    // Spoof Referer/Origin để vượt hotlink-protection/403 (non-DRM).
    await applySpoof(url, media?.pageUrl);
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
      spoofHost: hostFromUrl(url) ?? undefined,
    });
    return { ok: true, downloadId };
  } catch {
    return {
      ok: false,
      error: 'Không bắt đầu tải được (URL có thể hết hạn/403 hoặc bị chặn).',
    };
  }
}

async function handleHlsEstimate(
  variantUrl: string,
  bandwidth?: number,
): Promise<HlsEstimateResponse> {
  try {
    const res = await fetch(variantUrl, { credentials: 'include' });
    if (!res.ok) return { ok: false, error: `Máy chủ trả mã ${res.status}.` };
    const parsed = parseHlsSegments(await res.text(), variantUrl);
    const estBytes =
      bandwidth && bandwidth > 0
        ? Math.round((bandwidth / 8) * parsed.totalDuration)
        : undefined;
    return {
      ok: true,
      protected: parsed.isProtected,
      segmentCount: parsed.segments.length,
      durationSec: parsed.totalDuration,
      estBytes,
    };
  } catch {
    return {
      ok: false,
      error: 'Không tải/parse được playlist (mạng hoặc CORS).',
    };
  }
}

async function handleHlsDownload(
  variantUrl: string,
  mediaUrl: string,
  tabId: number,
  height?: number,
): Promise<HlsDownloadResponse> {
  try {
    const media = (await getTabMedia(tabId)).find((m) => m.url === mediaUrl);
    // Spoof Referer/Origin cho host chứa segment (vượt hotlink/403).
    await applySpoof(variantUrl, media?.pageUrl);
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
        filename,
        mediaUrl,
        tabId,
        spoofHost: hostFromUrl(variantUrl) ?? undefined,
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
  spoofHost?: string,
): Promise<void> {
  // Segment đã fetch xong -> xoá rule spoof cho host chứa segment.
  if (spoofHost) void removeSpoof(spoofHost);
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

// Áp session rule DNR spoof Referer/Origin cho host của media (vượt hotlink/403 non-DRM).
async function applySpoof(targetUrl: string, pageUrl?: string): Promise<void> {
  const host = hostFromUrl(targetUrl);
  if (!host) return;
  const refererBase =
    pageUrl && pageUrl.startsWith('http') ? pageUrl : targetUrl;
  const origin = originFromUrl(refererBase);
  if (!origin) return;
  const rule = buildRefererSpoofRule(host, refererBase, origin);
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

// Xoá session rule spoof Referer/Origin của một host.
async function removeSpoof(host: string): Promise<void> {
  try {
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [spoofRuleId(host)],
    } as unknown as Parameters<
      typeof browser.declarativeNetRequest.updateSessionRules
    >[0]);
  } catch {
    // ignore
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
