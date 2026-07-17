// Bọc chrome.storage cho:
// - Danh sách media theo tab (session): NGUỒN SỰ THẬT, không giữ trong biến toàn cục SW.
// - Trạng thái tải progressive (session): map theo downloadId.
// - Tiến trình job HLS (session): map theo jobId.
// - Cài đặt (local): chất lượng ưa thích, thư mục tải, ngưỡng cảnh báo dung lượng.
// - Cache kiểm tra bản mới trên GitHub Releases (local): tag + link + lúc kiểm tra.

import type { MediaItem, MediaType } from './types';
import { upsertMedia } from './detect';

const MEDIA_KEY_PREFIX = 'media:';
const DOWNLOADS_KEY = 'downloads';
const HLS_JOBS_KEY = 'hlsjobs';
const PREFERRED_HEIGHT_KEY = 'settings:preferredHeight';
const DOWNLOAD_FOLDER_KEY = 'settings:downloadFolder';
const SIZE_WARN_KEY = 'settings:sizeWarnBytes';
const CONCURRENCY_KEY = 'settings:concurrency';
const ENABLED_TYPES_KEY = 'settings:enabledTypes';
const UPDATE_CHECK_KEY = 'settings:updateCheck';

// Tuần tự hoá ghi storage (downloads/hlsjobs) trong 1 context để tránh race read-modify-write.
let writeChain: Promise<unknown> = Promise.resolve();
function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Ngưỡng cảnh báo dung lượng mặc định: 1.5 GB. */
export const DEFAULT_SIZE_WARN_BYTES = 1.5 * 1024 * 1024 * 1024;

export interface TabMediaState {
  /** epoch ms của lần điều hướng main_frame gần nhất. */
  navStartedAt: number;
  items: MediaItem[];
}

function mediaKey(tabId: number): string {
  return `${MEDIA_KEY_PREFIX}${tabId}`;
}

export async function getTabState(tabId: number): Promise<TabMediaState> {
  const key = mediaKey(tabId);
  const res = await browser.storage.session.get(key);
  const val = res[key] as Partial<TabMediaState> | undefined;
  return {
    navStartedAt: typeof val?.navStartedAt === 'number' ? val.navStartedAt : 0,
    items: Array.isArray(val?.items) ? val.items : [],
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
): Promise<void> {
  await setTabState(tabId, { navStartedAt, items: [] });
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
  const { list, changed } = upsertMedia(state.items, item);
  if (!changed) return null;
  await setTabState(tabId, { navStartedAt: state.navStartedAt, items: list });
  return list.length;
}

// --- Trạng thái tải progressive (session), keyed theo downloadId ---

export type DownloadState = 'in_progress' | 'complete' | 'interrupted';

export interface DownloadEntry {
  id: number;
  mediaUrl: string;
  filename?: string;
  state: DownloadState;
  error?: string;
  /** blob URL (nếu tải file ghép từ offscreen) -> thu hồi khi tải xong. */
  blobUrl?: string;
  /** host đã áp session rule spoof Referer/Origin -> xoá rule khi tải xong. */
  spoofHost?: string;
}

export async function getDownloads(): Promise<Record<string, DownloadEntry>> {
  const res = await browser.storage.session.get(DOWNLOADS_KEY);
  const v = res[DOWNLOADS_KEY];
  return v && typeof v === 'object' ? (v as Record<string, DownloadEntry>) : {};
}

export async function putDownload(entry: DownloadEntry): Promise<void> {
  await serializeWrite(async () => {
    const all = await getDownloads();
    // Merge (không ghi đè cứng) để không mất patch của onChanged nếu nó chạy trước.
    all[String(entry.id)] = { ...all[String(entry.id)], ...entry };
    await browser.storage.session.set({ [DOWNLOADS_KEY]: all });
  });
}

export async function updateDownload(
  id: number,
  patch: Partial<DownloadEntry>,
): Promise<void> {
  await serializeWrite(async () => {
    const all = await getDownloads();
    const cur = all[String(id)];
    // Upsert: nếu chưa có entry (race onChanged trước putDownload) thì tạo tối thiểu,
    // tránh mất trạng thái khiến popup kẹt ở "Đang tải…".
    const base: DownloadEntry = cur ?? {
      id,
      mediaUrl: '',
      state: 'in_progress',
    };
    all[String(id)] = { ...base, ...patch };
    await browser.storage.session.set({ [DOWNLOADS_KEY]: all });
  });
}

export async function getDownloadById(
  id: number,
): Promise<DownloadEntry | undefined> {
  return (await getDownloads())[String(id)];
}

// --- Tiến trình job HLS (session), keyed theo jobId ---

// 'queued'  = background đã tạo job, ĐÃ gửi sang offscreen, offscreen CHƯA nhận (hoặc đang xếp hàng).
// 'loading' = offscreen ĐÃ nhận việc và bắt đầu chạy (tải playlist + nạp ffmpeg song song).
// Tách 2 phase này ra là CÓ CHỦ Ý: gộp làm một thì "job kẹt" không phân biệt được là message rớt
// hay playlist treo — đúng ca đã ngốn 2 tiếng debug mà không có lấy một dòng manh mối.
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
  filename?: string;
  // MỚI (tiến trình chi tiết):
  /** tab phát hiện media -> background đặt badge % đúng tab. */
  tabId?: number;
  /** epoch ms lúc vào 'fetching' -> popup tính tốc độ/ETA. */
  startedAt?: number;
  /** tổng byte segment đã tải -> tính MB/s. */
  bytesDownloaded?: number;
  /** dung lượng ước tính (bandwidth × duration) -> dự phòng. */
  bytesTotal?: number;
  /** tiến trình ghép/remux 0..1 từ sự kiện progress ffmpeg. */
  muxProgress?: number;
}

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
    all[id] = { ...cur, ...patch };
    await browser.storage.session.set({ [HLS_JOBS_KEY]: all });
  });
}

// --- Cài đặt (local) ---

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

/** Ngưỡng (byte) cảnh báo dung lượng trước khi tải HLS. */
export async function getSizeWarnBytes(): Promise<number> {
  const res = await browser.storage.local.get(SIZE_WARN_KEY);
  const v = res[SIZE_WARN_KEY];
  return typeof v === 'number' && v > 0 ? v : DEFAULT_SIZE_WARN_BYTES;
}

export async function setSizeWarnBytes(bytes: number): Promise<void> {
  await browser.storage.local.set({ [SIZE_WARN_KEY]: bytes });
}

/** Số luồng fetch segment đồng thời (1..16). Mặc định 6. */
export const DEFAULT_CONCURRENCY = 6;

export async function getConcurrency(): Promise<number> {
  const res = await browser.storage.local.get(CONCURRENCY_KEY);
  const v = res[CONCURRENCY_KEY];
  return typeof v === 'number' && v >= 1 && v <= 16 ? v : DEFAULT_CONCURRENCY;
}

export async function setConcurrency(n: number): Promise<void> {
  await browser.storage.local.set({ [CONCURRENCY_KEY]: n });
}

/** Bật/tắt hiển thị theo loại media. */
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

/** TTL cache kiểm tra bản mới: 6 giờ (GitHub giới hạn 60 request/giờ/IP). */
export const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Kết quả kiểm tra GitHub Releases đã cache.
 * Lưu TAG THÔ chứ KHÔNG lưu cờ "có bản mới": phải so với version đang chạy lúc render,
 * nếu không banner sẽ còn báo mãi sau khi người dùng đã cập nhật (tới khi hết TTL).
 */
export interface UpdateCheck {
  /** Tag GitHub, dạng "v0.6.0". */
  latestTag: string;
  /** Link trang Release để mở cho người dùng tải tay. */
  releaseUrl: string;
  /** epoch ms lúc gọi API thành công. */
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
    return null; // thiếu/hỏng -> coi như chưa kiểm tra, sẽ gọi lại API.
  }
  // Giá trị đến từ mạng và sẽ được mở bằng tabs.create -> chỉ nhận link github.com.
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
