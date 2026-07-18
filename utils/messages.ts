// Giao thức message runtime giữa content script / popup / options / offscreen và background.
// Discriminated union theo trường `kind` để type-safe.

import type { DownloadEntry, HlsJob } from './storage';
import type { MediaType, VariantInfo } from './types';

export interface DomMediaCandidate {
  url: string;
  contentTypeHint?: string;
}

/** Chỉ HLS/DASH mới có manifest để liệt kê chất lượng. */
export type ManifestKind = Extract<MediaType, 'hls' | 'dash'>;

export type VariantsResponse =
  | { ok: true; isMaster: boolean; variants: VariantInfo[] }
  | { ok: false; error: string };

// W2.5 — progressive nay fetch bytes trong offscreen TRƯỚC khi có chrome downloadId, nên trả về
// `key` (jobId ổn định) thay vì downloadId. Popup dùng key để tra trạng thái + huỷ.
export type DownloadStartResponse =
  { ok: true; key: string } | { ok: false; error: string };

/** ACK cho 'download/progress' — offscreen await để giữ đúng thứ tự cập nhật (như hls/progress). */
export type DownloadProgressResponse = { ok: true };

export type FfmpegDemoResponse =
  { ok: true; size: number } | { ok: false; error: string };

export type HlsEstimateResponse =
  | {
      ok: true;
      protected: boolean;
      segmentCount: number;
      durationSec: number;
      /** dung lượng ước tính (byte) nếu biết bitrate. */
      estBytes?: number;
    }
  | { ok: false; error: string };

export type HlsDownloadResponse =
  { ok: true; jobId: string } | { ok: false; error: string };

/** ACK cho 'hls/progress' — offscreen await để giữ đúng thứ tự cập nhật. */
export type HlsProgressResponse = { ok: true };

/** Message gửi tới BACKGROUND (từ content/popup/options/offscreen). */
export type RuntimeMessage =
  | { kind: 'media/dom'; candidates: DomMediaCandidate[] }
  | { kind: 'media/mse'; url: string }
  // W7.1 — content script báo trang xin DRM/EME. `keySystem` rỗng = biết có DRM nhưng không rõ hãng
  // (tín hiệu đến từ sự kiện 'encrypted', chỗ đó không lộ tên hệ thống).
  | { kind: 'media/drm'; keySystem: string }
  // content script sniff được manifest HLS/DASH bị nguỵ trang (đọc #EXTM3U/<MPD từ body).
  | { kind: 'media/manifest'; url: string; mediaType: ManifestKind }
  // W2.2: `tabId` để background tra `media.pageUrl` -> spoof Referer ÔM SÁT cú fetch manifest.
  // Không có nó thì cú fetch đầu tiên trần trụi và site chống hotlink 403 ngay ở bước chọn chất lượng.
  | {
      kind: 'manifest/variants';
      url: string;
      mediaType: ManifestKind;
      tabId?: number;
    }
  | { kind: 'download/progressive'; url: string; tabId: number }
  | { kind: 'ffmpeg/demo' }
  // popup -> background: ước tính dung lượng + kiểm tra DRM trước khi tải HLS.
  | {
      kind: 'hls/estimate';
      variantUrl: string;
      bandwidth?: number;
      /** W1.1: playlist tiếng tách rời — job sẽ tải CẢ nó, nên ước lượng phải tính cả. */
      audioUrl?: string;
      /** W2.2: tra `media.pageUrl` để spoof Referer trước khi fetch playlist ước lượng. */
      tabId?: number;
      /**
       * W1.5 — định dạng manifest. Vắng = 'hls' (mọi lượt tải trước W1.5).
       *
       * 🔴 URL KHÔNG định danh nổi track của DASH: với SegmentTemplate thì `resolvedUri` của MỌI
       * representation (kể cả tiếng) đều là chính file `.mpd`. Vì vậy phải kèm `variantId`/`audioId`
       * — thiếu chúng thì tầng dưới bốc đại representation đầu tiên: user chọn 1080p nhận về 240p,
       * hoặc tải nhầm tiếng làm hình, KHÔNG một dòng lỗi nào.
       */
      mediaType?: ManifestKind;
      /** W1.5 — id representation hình (DASH). Xem `VariantInfo.id`. */
      variantId?: string;
      /** W1.5 — id representation tiếng (DASH). Xem `RenditionInfo.id`. */
      audioId?: string;
    }
  // popup -> background: bắt đầu tải & ghép HLS.
  | {
      kind: 'hls/download';
      variantUrl: string;
      mediaUrl: string;
      tabId: number;
      height?: number;
      /**
       * URL playlist TIẾNG tách rời (W1.1) — lấy từ rendition `selected` của variant.
       * Vắng = tiếng đã nằm trong variant -> đường một-input.
       * W4.4 (chọn ngôn ngữ) chỉ việc gửi URL khác vào đây, KHÔNG phải đổi giao thức lần nữa.
       */
      audioUrl?: string;
      /**
       * W1.5 — định dạng manifest. Vắng = 'hls' (mọi lượt tải trước W1.5).
       *
       * 🔴 URL KHÔNG định danh nổi track của DASH: với SegmentTemplate thì `resolvedUri` của MỌI
       * representation (kể cả tiếng) đều là chính file `.mpd`. Vì vậy phải kèm `variantId`/`audioId`
       * — thiếu chúng thì tầng dưới bốc đại representation đầu tiên: user chọn 1080p nhận về 240p,
       * hoặc tải nhầm tiếng làm hình, KHÔNG một dòng lỗi nào.
       */
      mediaType?: ManifestKind;
      /** W1.5 — id representation hình (DASH). Xem `VariantInfo.id`. */
      variantId?: string;
      /** W1.5 — id representation tiếng (DASH). Xem `RenditionInfo.id`. */
      audioId?: string;
    }
  // offscreen -> background: cập nhật tiến trình job HLS.
  // Offscreen KHÔNG ghi thẳng chrome.storage được (chỉ có chrome.runtime) -> mọi thay đổi state
  // phải đi qua đây để background ghi hộ. Đây là ràng buộc của Chrome, không phải lựa chọn.
  | { kind: 'hls/progress'; jobId: string; patch: Partial<HlsJob> }
  // offscreen -> background: đã có file (HLS ghép, hoặc progressive fetch xong), nhờ background LƯU.
  | {
      kind: 'download/blob';
      blobUrl: string;
      filename: string;
      mediaUrl: string;
      tabId: number;
      jobId: string;
      /**
       * W2.4 — id MỌI session rule spoof đã áp cho job này (một id cho mỗi host: hình + tiếng +
       * segment/key/init khác host). Offscreen chỉ mang hộ để gửi ngược cho background DỌN đúng
       * những rule đó — offscreen KHÔNG có chrome.declarativeNetRequest nên tự nó không xoá được.
       */
      spoofRuleIds?: number[];
      /**
       * W2.5 — có mặt khi blob này là của một lượt PROGRESSIVE (không phải HLS). Là khoá của
       * DownloadEntry in-flight để background gắn chromeDownloadId vào đúng entry đó (không tạo mới).
       * Vắng = luồng HLS cũ -> background tạo DownloadEntry keyed theo jobId.
       */
      downloadKey?: string;
    }
  // offscreen -> background: tiến trình fetch progressive (W2.5). Offscreen không ghi storage được
  // (chỉ có chrome.runtime) nên báo qua đây; background updateDownload hộ. ACK để giữ đúng thứ tự.
  | { kind: 'download/progress'; key: string; patch: Partial<DownloadEntry> }
  | { kind: 'hls/cancel'; jobId: string }
  // W2.5 — huỷ theo KHOÁ (jobId) thay vì downloadId: lúc đang fetch trong offscreen chưa có
  // chromeDownloadId. Background tự chọn: có chromeDownloadId -> chrome.downloads.cancel; chưa có
  // -> báo offscreen abort cú fetch.
  | { kind: 'download/cancel'; key: string };

/** Message gửi TỪ background TỚI offscreen (có `target: 'offscreen'` để phân biệt). */
export type OffscreenRequest =
  | { target: 'offscreen'; kind: 'ffmpeg/demo' }
  | {
      target: 'offscreen';
      kind: 'hls/run';
      jobId: string;
      variantUrl: string;
      filename: string;
      mediaUrl: string;
      tabId: number;
      /** W2.4 — id mọi rule spoof của job -> offscreen gửi ngược lại để background dọn đúng rule. */
      spoofRuleIds?: number[];
      /** W1.1: playlist tiếng tách rời. Có -> offscreen tải 2 bộ segment rồi ghép 2 input. */
      audioUrl?: string;
      /**
       * Số luồng tải song song. PHẢI do background đọc từ settings rồi truyền vào:
       * offscreen KHÔNG có `chrome.storage` (chỉ có `chrome.runtime`) nên không tự đọc được.
       */
      concurrency: number;
      /**
       * W1.5 — định dạng manifest. Vắng = 'hls' (mọi lượt tải trước W1.5).
       *
       * 🔴 URL KHÔNG định danh nổi track của DASH: với SegmentTemplate thì `resolvedUri` của MỌI
       * representation (kể cả tiếng) đều là chính file `.mpd`. Vì vậy phải kèm `variantId`/`audioId`
       * — thiếu chúng thì tầng dưới bốc đại representation đầu tiên: user chọn 1080p nhận về 240p,
       * hoặc tải nhầm tiếng làm hình, KHÔNG một dòng lỗi nào.
       */
      mediaType?: ManifestKind;
      /** W1.5 — id representation hình (DASH). Xem `VariantInfo.id`. */
      variantId?: string;
      /** W1.5 — id representation tiếng (DASH). Xem `RenditionInfo.id`. */
      audioId?: string;
    }
  | { target: 'offscreen'; kind: 'revoke'; url: string }
  | { target: 'offscreen'; kind: 'hls/cancel'; jobId: string }
  // W2.5 — tải progressive qua offscreen: fetch bytes (Range chunk cho file lớn) với rule spoof đang
  // bật, dựng Blob, gửi ngược download/blob. `chrome.downloads.download` do đó CHỈ nhận blob: URL.
  | {
      target: 'offscreen';
      kind: 'download/run';
      key: string;
      url: string;
      filename: string;
      mediaUrl: string;
      tabId: number;
      /** id rule spoof đã áp -> mang hộ để gửi lại cho background dọn (offscreen không đụng DNR). */
      spoofRuleIds?: number[];
    }
  // W2.5 — huỷ một lượt fetch progressive đang bay trong offscreen (abort AbortController).
  | { target: 'offscreen'; kind: 'download/abort'; key: string };

export async function sendRuntimeMessage(msg: RuntimeMessage): Promise<void> {
  try {
    await browser.runtime.sendMessage(msg);
  } catch {
    // background có thể chưa sẵn sàng; bỏ qua an toàn.
  }
}

export async function requestVariants(
  url: string,
  mediaType: ManifestKind,
  tabId?: number,
): Promise<VariantsResponse> {
  try {
    const res = await browser.runtime.sendMessage({
      kind: 'manifest/variants',
      url,
      mediaType,
      tabId,
    });
    return res as VariantsResponse;
  } catch {
    return { ok: false, error: 'Không kết nối được background.' };
  }
}

export async function requestDownload(
  url: string,
  tabId: number,
): Promise<DownloadStartResponse> {
  try {
    const res = await browser.runtime.sendMessage({
      kind: 'download/progressive',
      url,
      tabId,
    });
    return res as DownloadStartResponse;
  } catch {
    return { ok: false, error: 'Không kết nối được background.' };
  }
}

export async function requestFfmpegDemo(): Promise<FfmpegDemoResponse> {
  try {
    const res = await browser.runtime.sendMessage({ kind: 'ffmpeg/demo' });
    return res as FfmpegDemoResponse;
  } catch {
    return { ok: false, error: 'Không kết nối được background.' };
  }
}

export async function requestHlsEstimate(
  variantUrl: string,
  bandwidth?: number,
  audioUrl?: string,
  tabId?: number,
  mediaType?: ManifestKind,
  variantId?: string,
  audioId?: string,
): Promise<HlsEstimateResponse> {
  try {
    const res = await browser.runtime.sendMessage({
      kind: 'hls/estimate',
      variantUrl,
      bandwidth,
      audioUrl,
      tabId,
      mediaType,
      variantId,
      audioId,
    });
    return res as HlsEstimateResponse;
  } catch {
    return { ok: false, error: 'Không kết nối được background.' };
  }
}

export async function requestHlsDownload(
  variantUrl: string,
  mediaUrl: string,
  tabId: number,
  height?: number,
  audioUrl?: string,
  mediaType?: ManifestKind,
  variantId?: string,
  audioId?: string,
): Promise<HlsDownloadResponse> {
  try {
    const res = await browser.runtime.sendMessage({
      kind: 'hls/download',
      variantUrl,
      mediaUrl,
      tabId,
      height,
      audioUrl,
      mediaType,
      variantId,
      audioId,
    });
    return res as HlsDownloadResponse;
  } catch {
    return { ok: false, error: 'Không kết nối được background.' };
  }
}

/** Huỷ một job HLS đang chạy. */
export async function requestHlsCancel(jobId: string): Promise<void> {
  try {
    await browser.runtime.sendMessage({ kind: 'hls/cancel', jobId });
  } catch {
    // ignore
  }
}

/** Huỷ một lượt tải progressive đang chạy (theo khoá jobId — W2.5). */
export async function requestDownloadCancel(key: string): Promise<void> {
  try {
    await browser.runtime.sendMessage({ kind: 'download/cancel', key });
  } catch {
    // ignore
  }
}
