// Offscreen document — chạy việc nặng cần DOM/WASM: ffmpeg.wasm (ghép/remux HLS),
// fetch + giải mã segment, tạo blob URL để tải. Service worker MV3 KHÔNG làm được các việc này.
//
// ffmpeg.wasm dùng @ffmpeg/core SINGLE-THREAD -> KHÔNG cần SharedArrayBuffer.
// Core (.js + .wasm) đóng gói LOCAL trong public/ffmpeg/, load qua chrome.runtime.getURL
// (KHÔNG CDN — CSP MV3 chặn).

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { decryptAes128Cbc, hlsSegmentIv } from '@/utils/crypto';
import { describeError } from '@/utils/errors';
import { parseHlsSegments } from '@/utils/hls';
import type { HlsJob } from '@/utils/storage';
import type { FfmpegDemoResponse, OffscreenRequest } from '@/utils/messages';

// RÀNG BUỘC NỀN TẢNG (đo được, không phải suy đoán): offscreen document CHỈ được cấp
// `chrome.runtime` — `chrome.storage` là UNDEFINED ở đây (`Object.keys(chrome)` = loadTimes,csi,runtime).
// => TUYỆT ĐỐI không import hàm đọc/ghi storage vào file này: nó sẽ ném TypeError lúc chạy mà mọi
// cổng tĩnh (tsc/eslint/vitest) đều không thấy. Mọi state đi qua background bằng runtime message.
//
// KHÔNG NÉM RA NGOÀI (W0.1): hàm này được gọi ~mọi bước của một job có thể chạy 30 phút, và cả
// trong khối `catch` báo lỗi ở cuối runHlsJob. Nếu nó ném thì (1) một trục trặc nhắn tin nhất
// thời giết trọn job, và (2) khối catch tự ném -> LỖI GỐC BỊ XOÁ, user nhận job treo không lời
// giải thích. Nuốt lỗi ở đây là CÓ CHỦ ĐÍCH — nhưng không im lặng: vẫn phải log ra.
async function updateHlsJob(
  jobId: string,
  patch: Partial<HlsJob>,
): Promise<void> {
  try {
    await browser.runtime.sendMessage({ kind: 'hls/progress', jobId, patch });
  } catch (e) {
    console.warn(
      '[offscreen] không gửi được tiến trình về background:',
      describeError(e),
    );
  }
}

// Offscreen là trang bền (không phải service worker) -> giữ singleton trong biến module được.
let ffmpeg: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;

// Xếp hàng job HLS TUẦN TỰ: chỉ có 1 instance ffmpeg -> KHÔNG chạy 2 job song song
// (tránh đụng độ tên file trong FS ảo dùng chung).
let jobChain: Promise<void> = Promise.resolve();
const cancelledJobs = new Set<string>();

// Job đang mux hiện tại (để nối sự kiện progress của ffmpeg vào đúng job). Job chạy tuần tự
// nên chỉ có 1 mux tại một thời điểm.
let currentMuxJobId: string | null = null;
let lastMuxPct = -1;

// Các blob URL đang giữ (thu hồi khi background báo tải xong, hoặc sau timeout dự phòng).
const activeBlobUrls = new Set<string>();
const BLOB_TTL_MS = 10 * 60 * 1000;

// Trần thời gian tải playlist (manifest chỉ vài KB -> 30s là quá rộng rãi).
const PLAYLIST_TIMEOUT_MS = 30_000;

class CancelledError extends Error {}

async function ensureFfmpeg(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;
  if (!loading) {
    loading = (async () => {
      const ff = new FFmpeg();
      ff.on('log', ({ message }) => console.debug('[ffmpeg]', message));
      // Nối tiến trình remux vào job đang mux (throttle theo bước 1% để không spam storage).
      ff.on('progress', ({ progress }) => {
        if (!currentMuxJobId) return;
        const pct = Math.floor(progress * 100);
        if (pct !== lastMuxPct) {
          lastMuxPct = pct;
          void updateHlsJob(currentMuxJobId, { muxProgress: progress });
        }
      });
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
//
// Tối ưu tốc độ (v0.5.0): tách FETCH (mạng, song song) khỏi WRITE (FS ảo, cần ffmpeg) để
// chồng lấn việc tải segment với việc nạp ffmpeg.wasm. Prefetch CÓ TRẦN RAM (MAX_BUFFERED)
// để không giữ toàn bộ video trong bộ nhớ.

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
    await updateHlsJob(jobId, { phase: 'loading' });

    // Khởi động nạp ffmpeg SONG SONG với tải playlist (chưa await vội).
    const ffPromise = ensureFfmpeg();

    // Playlist PHẢI có timeout + kiểm status. Không có timeout thì một request treo = job treo
    // VĨNH VIỄN ở 'loading', không lỗi, không cách nào biết. Không kiểm status thì body của trang
    // lỗi (403/404) lọt xuống parser và báo sai thành "playlist không có segment".
    let playlistText: string;
    try {
      const res = await fetch(variantUrl, {
        credentials: 'include',
        signal: AbortSignal.timeout(PLAYLIST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      playlistText = await res.text();
    } catch (e) {
      throw new Error(`Không tải được playlist: ${describeError(e)}`, {
        cause: e,
      });
    }
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

    const concurrency = req.concurrency;
    const total = parsed.segments.length;
    const ext = parsed.hasInit ? 'm4s' : 'ts';

    // Vào 'fetching' NGAY (dù ffmpeg còn đang nạp) -> KHÔNG còn khoảng "chết".
    await updateHlsJob(jobId, {
      phase: 'fetching',
      segmentsTotal: total,
      segmentsDone: 0,
      bytesDownloaded: 0,
      startedAt: Date.now(),
    });

    const keyCache = new Map<string, ArrayBuffer>();
    const getKey = async (keyUri: string): Promise<ArrayBuffer> => {
      const cached = keyCache.get(keyUri);
      if (cached) return cached;
      const kb = await fetchWithRetry(keyUri);
      keyCache.set(keyUri, kb);
      return kb;
    };

    // Tải + giải mã 1 segment thành bytes (CHƯA ghi FS). Đếm tiến trình theo segment FETCH xong.
    let done = 0;
    let bytesDownloaded = 0;
    const step = Math.max(1, Math.floor(total / 33));
    const fetchSegmentBytes = async (i: number): Promise<Uint8Array> => {
      throwIfCancelled();
      const seg = parsed.segments[i]!;
      // An toàn: segment giữa chừng dùng mã hoá khác AES-128 (mixed method) -> DỪNG.
      const method = seg.keyMethod;
      if (method && method !== 'NONE' && method !== 'AES-128') {
        throw new Error(`Segment dùng mã hoá không hỗ trợ: ${method}`);
      }
      let buf = await fetchWithRetry(seg.uri);
      bytesDownloaded += buf.byteLength; // byte thô đã tải (trước giải mã)
      if (method === 'AES-128' && seg.keyUri) {
        const key = await getKey(seg.keyUri);
        const iv = hlsSegmentIv(seg.seq, seg.iv);
        buf = await decryptAes128Cbc(buf, key, iv);
      }
      done++;
      if (done % step === 0 || done === total) {
        await updateHlsJob(jobId, { segmentsDone: done, bytesDownloaded });
      }
      return new Uint8Array(buf);
    };

    // Tải init segment (fMP4) SONG SONG với prefetch bên dưới.
    const firstInit = parsed.segments.find((s) => s.initUri)?.initUri;
    const initPromise: Promise<Uint8Array | null> = firstInit
      ? fetchWithRetry(firstInit).then((b) => new Uint8Array(b))
      : Promise.resolve(null);

    // Prefetch CÓ TRẦN RAM: tối đa MAX_BUFFERED segment chưa-ghi nằm trong bộ nhớ (backpressure).
    const MAX_BUFFERED = Math.min(2 * concurrency, 12);
    const names = new Array<string>(total);
    const buffers = new Array<Uint8Array | undefined>(total);
    let nextFetch = 0; // chỉ số segment kế tiếp cần fetch
    let nextWrite = 0; // chỉ số segment kế tiếp cần ghi FS
    let failed: unknown = null;

    const ffmpegRef = await ffPromise; // chờ engine trước khi ghi FS
    ff = ffmpegRef;

    const initBytes = await initPromise;
    let initName: string | undefined;
    if (initBytes) {
      initName = 'init.mp4';
      await ffmpegRef.writeFile(initName, initBytes);
      writtenFiles.add(initName);
    }

    // Vòng writer: ghi tuần tự theo thứ tự index để giải phóng RAM sớm.
    //
    // PHẢI "xí phần" chỉ số (nextWrite++) TRƯỚC khi await. writeReady() được gọi từ NHIỀU worker
    // fetch song song; nếu tăng sau await thì worker B đọc lại đúng nextWrite mà worker A đang ghi
    // dở -> ghi trùng một buffer. Mà writeFile của ffmpeg TRANSFER (detach) ArrayBuffer, nên lần
    // ghi thứ hai nổ "ArrayBuffer is detached and could not be cloned".
    const writeReady = async (): Promise<void> => {
      while (nextWrite < total && buffers[nextWrite] !== undefined) {
        throwIfCancelled();
        const i = nextWrite;
        nextWrite++;
        const name = `seg${String(i).padStart(5, '0')}.${ext}`;
        const bytes = buffers[i]!;
        buffers[i] = undefined; // nhả tham chiếu ngay: buffer sắp bị transfer đi worker ffmpeg
        writtenFiles.add(name); // ghi tên TRƯỚC khi await -> lỗi giữa chừng vẫn dọn được file
        await ffmpegRef.writeFile(name, bytes);
        names[i] = name;
      }
    };

    // Worker fetch có backpressure: dừng lấy segment mới khi bộ đệm đầy.
    const worker = async (): Promise<void> => {
      while (failed === null) {
        if (nextFetch - nextWrite >= MAX_BUFFERED) {
          await writeReady();
          if (nextFetch - nextWrite >= MAX_BUFFERED) {
            await new Promise((r) => setTimeout(r, 5));
            continue;
          }
        }
        const i = nextFetch;
        if (i >= total) return;
        nextFetch++;
        try {
          buffers[i] = await fetchSegmentBytes(i);
          await writeReady();
        } catch (e) {
          failed = e;
          return;
        }
      }
    };

    const workerCount = Math.min(Math.max(1, concurrency), total);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (failed !== null) throw failed;
    await writeReady(); // ghi nốt phần còn lại
    throwIfCancelled();

    // Ghép: concat: protocol nối byte các segment (+ init) rồi remux sang mp4 (-c copy).
    await updateHlsJob(jobId, { phase: 'muxing', muxProgress: 0 });
    const concatList = (initName ? [initName, ...names] : names).join('|');
    const outName = 'output.mp4';
    currentMuxJobId = jobId;
    lastMuxPct = -1;
    try {
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
    } finally {
      currentMuxJobId = null;
    }
    writtenFiles.add(outName);

    await updateHlsJob(jobId, { phase: 'saving' });
    const out = await ffmpegRef.readFile(outName);
    const outBytes =
      typeof out === 'string' ? new TextEncoder().encode(out) : out;

    // Nếu user đã huỷ trong lúc mux/lưu -> DỪNG, không tải file về (tránh "hoàn tất giả").
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
      segmentsDone: total,
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

// Hợp đồng giống background (xem chú thích ở entrypoints/background.ts): `true` ĐỒNG BỘ cho
// nhánh async, KHÔNG trả Promise. Message không phải của offscreen -> trả `undefined` để KHÔNG
// cướp kênh trả lời của background.
browser.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender: unknown,
    sendResponse: (response?: unknown) => void,
  ): true | undefined => {
    const req = asOffscreenRequest(message);
    if (!req) return undefined;
    switch (req.kind) {
      case 'ffmpeg/demo':
        void runFfmpegDemo()
          .then(
            (res: FfmpegDemoResponse) => sendResponse(res),
            (e: unknown) =>
              sendResponse({ ok: false, error: describeError(e) }),
          )
          .catch(() => undefined);
        return true;
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

// Prewarm: nạp ffmpeg NGAY khi offscreen document được tạo -> job đầu tiên không phải chờ nạp
// (offscreen chỉ được tạo khi cần ffmpeg/hls/demo nên không lãng phí).
// Lỗi prewarm KHÔNG ném ra ngoài (ensureFfmpeg đã reset `loading` về null nên job sau vẫn thử lại
// được), nhưng PHẢI log: nuốt im lặng ở đây từng khiến ffmpeg hỏng suốt nhiều tháng mà không ai thấy.
void ensureFfmpeg().catch((e: unknown) => {
  console.error('[offscreen] prewarm ffmpeg thất bại:', describeError(e), e);
});

console.debug('[offscreen] ready');
