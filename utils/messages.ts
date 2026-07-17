// Giao thức message runtime giữa content script / popup / options / offscreen và background.
// Discriminated union theo trường `kind` để type-safe.

import type { HlsJob } from './storage';
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

export type DownloadStartResponse =
  { ok: true; downloadId: number } | { ok: false; error: string };

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
  // content script sniff được manifest HLS/DASH bị nguỵ trang (đọc #EXTM3U/<MPD từ body).
  | { kind: 'media/manifest'; url: string; mediaType: ManifestKind }
  | { kind: 'manifest/variants'; url: string; mediaType: ManifestKind }
  | { kind: 'download/progressive'; url: string; tabId: number }
  | { kind: 'ffmpeg/demo' }
  // popup -> background: ước tính dung lượng + kiểm tra DRM trước khi tải HLS.
  | {
      kind: 'hls/estimate';
      variantUrl: string;
      bandwidth?: number;
      /** W1.1: playlist tiếng tách rời — job sẽ tải CẢ nó, nên ước lượng phải tính cả. */
      audioUrl?: string;
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
    }
  // offscreen -> background: cập nhật tiến trình job HLS.
  // Offscreen KHÔNG ghi thẳng chrome.storage được (chỉ có chrome.runtime) -> mọi thay đổi state
  // phải đi qua đây để background ghi hộ. Đây là ràng buộc của Chrome, không phải lựa chọn.
  | { kind: 'hls/progress'; jobId: string; patch: Partial<HlsJob> }
  // offscreen -> background: đã ghép xong, nhờ background tải blob về máy.
  | {
      kind: 'download/blob';
      blobUrl: string;
      filename: string;
      mediaUrl: string;
      tabId: number;
      jobId: string;
      spoofHost?: string;
    }
  | { kind: 'hls/cancel'; jobId: string }
  | { kind: 'download/cancel'; downloadId: number };

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
      spoofHost?: string;
      /** W1.1: playlist tiếng tách rời. Có -> offscreen tải 2 bộ segment rồi ghép 2 input. */
      audioUrl?: string;
      /**
       * Số luồng tải song song. PHẢI do background đọc từ settings rồi truyền vào:
       * offscreen KHÔNG có `chrome.storage` (chỉ có `chrome.runtime`) nên không tự đọc được.
       */
      concurrency: number;
    }
  | { target: 'offscreen'; kind: 'revoke'; url: string }
  | { target: 'offscreen'; kind: 'hls/cancel'; jobId: string };

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
): Promise<VariantsResponse> {
  try {
    const res = await browser.runtime.sendMessage({
      kind: 'manifest/variants',
      url,
      mediaType,
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
): Promise<HlsEstimateResponse> {
  try {
    const res = await browser.runtime.sendMessage({
      kind: 'hls/estimate',
      variantUrl,
      bandwidth,
      audioUrl,
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
): Promise<HlsDownloadResponse> {
  try {
    const res = await browser.runtime.sendMessage({
      kind: 'hls/download',
      variantUrl,
      mediaUrl,
      tabId,
      height,
      audioUrl,
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

/** Huỷ một lượt tải progressive đang chạy. */
export async function requestDownloadCancel(downloadId: number): Promise<void> {
  try {
    await browser.runtime.sendMessage({ kind: 'download/cancel', downloadId });
  } catch {
    // ignore
  }
}
