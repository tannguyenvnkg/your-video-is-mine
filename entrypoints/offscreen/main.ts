// Offscreen document — chạy việc nặng cần DOM/WASM: ffmpeg.wasm (ghép/remux HLS),
// fetch + giải mã segment, tạo blob URL để tải. Service worker MV3 KHÔNG làm được các việc này.
//
// ffmpeg.wasm dùng @ffmpeg/core SINGLE-THREAD -> KHÔNG cần SharedArrayBuffer.
// Core (.js + .wasm) đóng gói LOCAL trong public/ffmpeg/, load qua chrome.runtime.getURL
// (KHÔNG CDN — CSP MV3 chặn).

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { decryptAes128Cbc, hlsSegmentIv } from '@/utils/crypto';
import { parseHlsSegments } from '@/utils/hls';
import { getConcurrency, updateHlsJob } from '@/utils/storage';
import type { FfmpegDemoResponse, OffscreenRequest } from '@/utils/messages';

// Offscreen là trang bền (không phải service worker) -> giữ singleton trong biến module được.
let ffmpeg: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;

// Xếp hàng job HLS TUẦN TỰ: chỉ có 1 instance ffmpeg -> KHÔNG chạy 2 job song song
// (tránh đụng độ tên file trong FS ảo dùng chung).
let jobChain: Promise<void> = Promise.resolve();
const cancelledJobs = new Set<string>();

// Các blob URL đang giữ (thu hồi khi background báo tải xong, hoặc sau timeout dự phòng).
const activeBlobUrls = new Set<string>();
const BLOB_TTL_MS = 10 * 60 * 1000;

class CancelledError extends Error {}

async function ensureFfmpeg(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;
  if (!loading) {
    loading = (async () => {
      const ff = new FFmpeg();
      ff.on('log', ({ message }) => console.debug('[ffmpeg]', message));
      ff.on('progress', ({ progress }) =>
        console.debug('[ffmpeg] mux', Math.round(progress * 100), '%'),
      );
      const coreURL = browser.runtime.getURL('/ffmpeg/ffmpeg-core.js');
      const wasmURL = browser.runtime.getURL('/ffmpeg/ffmpeg-core.wasm');
      await ff.load({ coreURL, wasmURL });
      console.log('[offscreen] ffmpeg loaded');
      ffmpeg = ff;
      return ff;
    })().catch((e: unknown) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function fetchWithRetry(url: string, retries = 3): Promise<ArrayBuffer> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.arrayBuffer();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `Tải segment lỗi sau ${retries + 1} lần thử: ${describeError(lastErr)}`,
  );
}

/** Chạy các task async với số luồng đồng thời tối đa `limit`. */
async function runLimited(
  tasks: Array<() => Promise<void>>,
  limit: number,
): Promise<void> {
  let next = 0;
  let failed: unknown = null;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), tasks.length) },
    async () => {
      // Dừng lấy task mới khi có lỗi -> KHÔNG để worker "mồ côi" chạy nền ghi đè file job sau.
      while (next < tasks.length && failed === null) {
        const cur = next++;
        try {
          await tasks[cur]!();
        } catch (e) {
          failed = e;
        }
      }
    },
  );
  await Promise.all(workers); // đợi TẤT CẢ worker kết thúc trước khi trả về
  if (failed !== null) throw failed;
}

async function runFfmpegDemo(): Promise<FfmpegDemoResponse> {
  try {
    const ff = await ensureFfmpeg();
    await ff.exec([
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=128x72:rate=5',
      '-pix_fmt',
      'yuv420p',
      '-t',
      '1',
      '-y',
      'demo.mp4',
    ]);
    const data = await ff.readFile('demo.mp4');
    const size = typeof data === 'string' ? data.length : data.byteLength;
    return { ok: true, size };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

// --- G5: tải & ghép HLS (chạy tuần tự qua jobChain) ---

async function runHlsJob(
  req: Extract<OffscreenRequest, { kind: 'hls/run' }>,
): Promise<void> {
  const { jobId, variantUrl, filename, mediaUrl, tabId, spoofHost } = req;
  const throwIfCancelled = () => {
    if (cancelledJobs.has(jobId)) throw new CancelledError();
  };
  // Theo dõi mọi file đã ghi vào FS ảo để DỌN trong finally (cả khi lỗi/huỷ).
  const writtenFiles = new Set<string>();
  let ff: FFmpeg | null = null;

  try {
    throwIfCancelled();
    const playlistText = await (
      await fetch(variantUrl, { credentials: 'include' })
    ).text();
    const parsed = parseHlsSegments(playlistText, variantUrl);

    // Ranh giới cứng: SAMPLE-AES/EME -> DỪNG.
    if (parsed.isProtected) {
      await updateHlsJob(jobId, {
        phase: 'error',
        error: 'Không hỗ trợ nội dung được bảo vệ (SAMPLE-AES/DRM).',
      });
      return;
    }
    if (parsed.segments.length === 0) {
      await updateHlsJob(jobId, {
        phase: 'error',
        error: 'Playlist không có segment nào.',
      });
      return;
    }

    ff = await ensureFfmpeg();
    const ffmpegRef = ff;
    const concurrency = await getConcurrency();
    await updateHlsJob(jobId, {
      phase: 'fetching',
      segmentsTotal: parsed.segments.length,
      segmentsDone: 0,
    });

    const keyCache = new Map<string, ArrayBuffer>();
    const getKey = async (keyUri: string): Promise<ArrayBuffer> => {
      const cached = keyCache.get(keyUri);
      if (cached) return cached;
      const kb = await fetchWithRetry(keyUri);
      keyCache.set(keyUri, kb);
      return kb;
    };

    const ext = parsed.hasInit ? 'm4s' : 'ts';
    const firstInit = parsed.segments.find((s) => s.initUri)?.initUri;
    let initName: string | undefined;
    if (firstInit) {
      const initBuf = await fetchWithRetry(firstInit);
      initName = 'init.mp4';
      await ffmpegRef.writeFile(initName, new Uint8Array(initBuf));
      writtenFiles.add(initName);
    }

    const names: string[] = new Array<string>(parsed.segments.length);
    let done = 0;
    const step = Math.max(1, Math.floor(parsed.segments.length / 33));

    const processSegment = async (i: number): Promise<void> => {
      throwIfCancelled();
      const seg = parsed.segments[i]!;
      // An toàn: nếu segment giữa chừng dùng mã hoá khác AES-128 (mixed method) -> DỪNG.
      const method = seg.keyMethod;
      if (method && method !== 'NONE' && method !== 'AES-128') {
        throw new Error(`Segment dùng mã hoá không hỗ trợ: ${method}`);
      }
      let buf = await fetchWithRetry(seg.uri);
      if (method === 'AES-128' && seg.keyUri) {
        const key = await getKey(seg.keyUri);
        const iv = hlsSegmentIv(seg.seq, seg.iv);
        buf = await decryptAes128Cbc(buf, key, iv);
      }
      const name = `seg${String(i).padStart(5, '0')}.${ext}`;
      await ffmpegRef.writeFile(name, new Uint8Array(buf));
      writtenFiles.add(name);
      names[i] = name;
      done++;
      if (done % step === 0 || done === parsed.segments.length) {
        await updateHlsJob(jobId, { segmentsDone: done });
      }
    };

    await runLimited(
      parsed.segments.map((_, i) => () => processSegment(i)),
      concurrency,
    );
    throwIfCancelled();

    // Ghép: concat: protocol nối byte các segment (+ init) rồi remux sang mp4 (-c copy).
    await updateHlsJob(jobId, { phase: 'muxing' });
    const concatList = (initName ? [initName, ...names] : names).join('|');
    const outName = 'output.mp4';
    await ffmpegRef.exec([
      '-i',
      `concat:${concatList}`,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '-y',
      outName,
    ]);
    writtenFiles.add(outName);

    const out = await ffmpegRef.readFile(outName);
    const outBytes =
      typeof out === 'string' ? new TextEncoder().encode(out) : out;

    // Nếu user đã huỷ trong lúc mux -> DỪNG, không tải file về (tránh "hoàn tất giả").
    throwIfCancelled();

    // Blob .mp4 + nhờ background tải về máy. Cast BlobPart an toàn (single-thread, no SAB).
    const blob = new Blob([outBytes as BlobPart], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    activeBlobUrls.add(blobUrl);
    // Dự phòng chống rò rỉ: tự thu hồi sau TTL nếu background chưa báo revoke.
    setTimeout(() => revokeBlob(blobUrl), BLOB_TTL_MS);
    await browser.runtime.sendMessage({
      kind: 'download/blob',
      blobUrl,
      filename,
      mediaUrl,
      tabId,
      jobId,
      spoofHost,
    });
    await updateHlsJob(jobId, {
      phase: 'done',
      segmentsDone: parsed.segments.length,
    });
  } catch (e) {
    if (e instanceof CancelledError) {
      await updateHlsJob(jobId, { phase: 'cancelled', error: 'Đã huỷ' });
    } else {
      await updateHlsJob(jobId, { phase: 'error', error: describeError(e) });
    }
  } finally {
    // Dọn FS ảo dù thành công/lỗi/huỷ -> tránh tích luỹ bộ nhớ WASM.
    if (ff) {
      for (const n of writtenFiles) {
        try {
          await ff.deleteFile(n);
        } catch {
          // ignore
        }
      }
    }
    cancelledJobs.delete(jobId);
  }
}

function enqueueHlsJob(
  req: Extract<OffscreenRequest, { kind: 'hls/run' }>,
): void {
  jobChain = jobChain.then(() => runHlsJob(req)).catch(() => undefined);
}

function revokeBlob(url: string): void {
  if (activeBlobUrls.has(url)) {
    URL.revokeObjectURL(url);
    activeBlobUrls.delete(url);
  }
}

function asOffscreenRequest(m: unknown): OffscreenRequest | null {
  if (
    typeof m === 'object' &&
    m !== null &&
    (m as { target?: unknown }).target === 'offscreen'
  ) {
    return m as OffscreenRequest;
  }
  return null;
}

browser.runtime.onMessage.addListener(
  (message: unknown): undefined | Promise<FfmpegDemoResponse> => {
    const req = asOffscreenRequest(message);
    if (!req) return undefined;
    switch (req.kind) {
      case 'ffmpeg/demo':
        return runFfmpegDemo();
      case 'hls/run':
        enqueueHlsJob(req);
        return undefined;
      case 'hls/cancel':
        cancelledJobs.add(req.jobId);
        return undefined;
      case 'revoke':
        revokeBlob(req.url);
        return undefined;
    }
  },
);

console.debug('[offscreen] ready');
