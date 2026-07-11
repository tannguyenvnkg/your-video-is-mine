// Giao thức message runtime giữa content script / popup / options / offscreen và background.
// Discriminated union theo trường `kind` để type-safe.

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

/** Message gửi tới BACKGROUND (từ content/popup/options/offscreen). */
export type RuntimeMessage =
  | { kind: 'media/dom'; candidates: DomMediaCandidate[] }
  | { kind: 'media/mse'; url: string }
  | { kind: 'manifest/variants'; url: string; mediaType: ManifestKind }
  | { kind: 'download/progressive'; url: string; tabId: number }
  | { kind: 'ffmpeg/demo' }
  // popup -> background: ước tính dung lượng + kiểm tra DRM trước khi tải HLS.
  | { kind: 'hls/estimate'; variantUrl: string; bandwidth?: number }
  // popup -> background: bắt đầu tải & ghép HLS.
  | {
      kind: 'hls/download';
      variantUrl: string;
      mediaUrl: string;
      tabId: number;
      height?: number;
    }
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
): Promise<HlsEstimateResponse> {
  try {
    const res = await browser.runtime.sendMessage({
      kind: 'hls/estimate',
      variantUrl,
      bandwidth,
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
): Promise<HlsDownloadResponse> {
  try {
    const res = await browser.runtime.sendMessage({
      kind: 'hls/download',
      variantUrl,
      mediaUrl,
      tabId,
      height,
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
