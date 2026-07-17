// Offscreen document — chạy việc nặng cần DOM/WASM: ffmpeg.wasm (ghép/remux HLS),
// fetch + giải mã segment, tạo blob URL để tải. Service worker MV3 KHÔNG làm được các việc này.
//
// ffmpeg.wasm dùng @ffmpeg/core SINGLE-THREAD -> KHÔNG cần SharedArrayBuffer.
// Core (.js + .wasm) đóng gói LOCAL trong public/ffmpeg/, load qua chrome.runtime.getURL
// (KHÔNG CDN — CSP MV3 chặn).

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { decryptAes128Cbc, hlsSegmentIv } from '@/utils/crypto';
import { describeError } from '@/utils/errors';
import { parseHlsSegments, type HlsByteRange } from '@/utils/hls';
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

// Vòng đệm log ffmpeg gần nhất. LÝ DO TỒN TẠI (lỗi #30): ffmpeg.wasm KHÔNG ném khi mux hỏng —
// nó chỉ trả mã ≠ 0 và in lý do thật ra log. Không giữ log lại thì lỗi thật bốc hơi và user nhận
// một thông báo vô nghĩa ở tận khâu sau (`FS error` từ readFile của file chưa từng được tạo).
const ffmpegLog: string[] = [];
const FFMPEG_LOG_KEEP = 40;

/** Vài dòng log ffmpeg cuối — đính vào lỗi để còn chẩn đoán được. */
function recentFfmpegLog(): string {
  const tail = ffmpegLog.slice(-6).filter((l) => l.trim() !== '');
  return tail.length ? ` Log ffmpeg: ${tail.join(' | ')}` : '';
}

class CancelledError extends Error {}

async function ensureFfmpeg(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;
  if (!loading) {
    loading = (async () => {
      const ff = new FFmpeg();
      ff.on('log', ({ message }) => {
        console.debug('[ffmpeg]', message);
        ffmpegLog.push(message);
        if (ffmpegLog.length > FFMPEG_LOG_KEEP) ffmpegLog.shift();
      });
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

/** Lỗi KHÔNG thử lại được — thử lại chỉ tốn băng thông mà kết quả y hệt. */
class FatalFetchError extends Error {}

/**
 * Tải một segment. `range` có mặt (W1.3) -> gửi header `Range` thay vì tải nguyên file.
 */
async function fetchWithRetry(
  url: string,
  retries = 3,
  range?: HlsByteRange,
): Promise<ArrayBuffer> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        credentials: 'include',
        ...(range
          ? {
              // HTTP Range là ĐÓNG hai đầu: byte cuối = offset + length - 1.
              headers: {
                Range: `bytes=${range.offset}-${range.offset + range.length - 1}`,
              },
            }
          : {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // ⚠️ BẪY W1.3: server PHỚT LỜ Range trả 200 + TOÀN BỘ file. Ghi cả file vào chỗ của một
      // segment = file ra hỏng mà im lặng. Và vì playlist byterange cho cả trăm segment trỏ CÙNG
      // một file, âm thầm chấp nhận còn nghĩa là tải nguyên file đó cả trăm lần (đo thật trên
      // Apple fMP4: 27MB x 101 = ~2.8GB). Thà FAIL LỚN TIẾNG.
      if (range && res.status !== 206) {
        throw new FatalFetchError(
          `máy chủ không hỗ trợ tải theo đoạn (Range): trả HTTP ${res.status} thay vì 206`,
        );
      }
      return await res.arrayBuffer();
    } catch (e) {
      // Thử lại vô nghĩa: server sẽ lại phớt lờ Range, và mỗi lần thử kéo về NGUYÊN file lớn.
      if (e instanceof FatalFetchError) throw e;
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
    // Mã trả về PHẢI kiểm: exec KHÔNG ném khi ffmpeg hỏng (xem chú thích ffmpegLog).
    const code = await ff.exec([
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
    if (code !== 0) {
      throw new Error(`ffmpeg trả mã ${code}.${recentFfmpegLog()}`);
    }
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

/** Tải + parse một media playlist. Ném lỗi RÕ thay vì để body trang lỗi (403/404) lọt vào parser. */
async function loadPlaylist(
  url: string,
  label: string,
): Promise<ReturnType<typeof parseHlsSegments>> {
  let text: string;
  try {
    // Playlist PHẢI có timeout + kiểm status. Không timeout thì một request treo = job treo VĨNH
    // VIỄN ở 'loading', không lỗi, không cách nào biết.
    const res = await fetch(url, {
      credentials: 'include',
      signal: AbortSignal.timeout(PLAYLIST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    throw new Error(`Không tải được playlist ${label}: ${describeError(e)}`, {
      cause: e,
    });
  }
  return parseHlsSegments(text, url);
}

/** Kết quả tải một track: tên file segment trong FS ảo, theo ĐÚNG thứ tự phát. */
interface TrackFiles {
  names: string[];
  initName?: string;
}

/**
 * Tải trọn segment của MỘT playlist vào FS ảo của ffmpeg.
 *
 * W1.1 tách hàm này ra khỏi runHlsJob để dùng lại cho luồng TIẾNG tách rời: hình và tiếng là hai
 * playlist độc lập, mỗi bên có #EXT-X-KEY, #EXT-X-MAP và SỐ SEGMENT riêng (đo trên fixture thật:
 * hình 10 segment, tiếng 11) -> mọi giả định "hai bên giống nhau" đều sai.
 *
 * `prefix` tách không gian tên file trong FS ảo dùng chung (`vseg00000.ts` vs `aseg00000.ts`).
 */
async function downloadTrack(o: {
  ff: FFmpeg;
  parsed: ReturnType<typeof parseHlsSegments>;
  prefix: string;
  concurrency: number;
  writtenFiles: Set<string>;
  throwIfCancelled: () => void;
  /** Báo 1 segment vừa fetch xong (byte thô, trước giải mã) -> gộp tiến trình mọi track. */
  onSegment: (bytes: number) => Promise<void>;
}): Promise<TrackFiles> {
  const { ff, parsed, prefix, concurrency, writtenFiles, throwIfCancelled } = o;
  const total = parsed.segments.length;
  const ext = parsed.hasInit ? 'm4s' : 'ts';

  // ⚠️ Cache key AES RIÊNG mỗi track: rendition tiếng thường có #EXT-X-KEY riêng, dùng chung cache
  // theo URI vẫn đúng nhưng để riêng thì không có đường lẫn key giữa hai playlist.
  const keyCache = new Map<string, ArrayBuffer>();
  const getKey = async (keyUri: string): Promise<ArrayBuffer> => {
    const cached = keyCache.get(keyUri);
    if (cached) return cached;
    const kb = await fetchWithRetry(keyUri);
    keyCache.set(keyUri, kb);
    return kb;
  };

  const fetchSegmentBytes = async (i: number): Promise<Uint8Array> => {
    throwIfCancelled();
    const seg = parsed.segments[i]!;
    // An toàn: segment giữa chừng dùng mã hoá khác AES-128 (mixed method) -> DỪNG.
    const method = seg.keyMethod;
    if (method && method !== 'NONE' && method !== 'AES-128') {
      throw new Error(`Segment dùng mã hoá không hỗ trợ: ${method}`);
    }
    // W1.3: có byterange -> chỉ kéo đúng đoạn của segment này, KHÔNG kéo cả file.
    let buf = await fetchWithRetry(seg.uri, 3, seg.byterange);
    const raw = buf.byteLength;
    if (method === 'AES-128' && seg.keyUri) {
      const key = await getKey(seg.keyUri);
      const iv = hlsSegmentIv(seg.seq, seg.iv);
      buf = await decryptAes128Cbc(buf, key, iv);
    }
    await o.onSegment(raw);
    return new Uint8Array(buf);
  };

  // Tải init segment (fMP4) SONG SONG với prefetch bên dưới.
  // W1.3: init cũng có thể là một ĐOẠN của file lớn (#EXT-X-MAP:BYTERANGE) — Apple fMP4 để init
  // ở 719 byte ĐẦU của chính file 27MB chứa mọi segment. Bỏ qua byterange ở đây = nạp 27MB byte
  // rác làm "header" -> ffmpeg "error reading header".
  const firstInitSeg = parsed.segments.find((s) => s.initUri);
  const initPromise: Promise<Uint8Array | null> = firstInitSeg?.initUri
    ? fetchWithRetry(firstInitSeg.initUri, 3, firstInitSeg.initByterange).then(
        (b) => new Uint8Array(b),
      )
    : Promise.resolve(null);

  // Prefetch CÓ TRẦN RAM: tối đa MAX_BUFFERED segment chưa-ghi nằm trong bộ nhớ (backpressure).
  const MAX_BUFFERED = Math.min(2 * concurrency, 12);
  const names = new Array<string>(total);
  const buffers = new Array<Uint8Array | undefined>(total);
  let nextFetch = 0; // chỉ số segment kế tiếp cần fetch
  let nextWrite = 0; // chỉ số segment kế tiếp cần ghi FS
  let failed: unknown = null;

  const initBytes = await initPromise;
  let initName: string | undefined;
  if (initBytes) {
    initName = `${prefix}init.mp4`;
    await ff.writeFile(initName, initBytes);
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
      const name = `${prefix}seg${String(i).padStart(5, '0')}.${ext}`;
      const bytes = buffers[i]!;
      buffers[i] = undefined; // nhả tham chiếu ngay: buffer sắp bị transfer đi worker ffmpeg
      writtenFiles.add(name); // ghi tên TRƯỚC khi await -> lỗi giữa chừng vẫn dọn được file
      await ff.writeFile(name, bytes);
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

  // W1.2: ném LỚN TIẾNG thay vì mux một danh sách có lỗ. `names.join('|')` render một ô trống
  // thành chuỗi rỗng -> `concat:a.ts||c.ts` -> ffmpeg nuốt lỗ hổng và ra file THIẾU ĐOẠN mà không
  // báo gì. Chính cái nuốt im lặng đó biến lỗi race từ "crash" thành "file hỏng" — tệ hơn nhiều.
  const missing = names.findIndex((n) => n === undefined);
  if (nextWrite !== total || missing >= 0) {
    throw new Error(
      `Thiếu segment sau khi tải (đã ghi ${nextWrite}/${total}` +
        `${missing >= 0 ? `, hổng ở #${missing}` : ''}) — không ghép để tránh ra file hỏng.`,
    );
  }

  return { names, ...(initName !== undefined ? { initName } : {}) };
}

async function runHlsJob(
  req: Extract<OffscreenRequest, { kind: 'hls/run' }>,
): Promise<void> {
  const { jobId, variantUrl, audioUrl, filename, mediaUrl, tabId, spoofHosts } =
    req;
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

    // W1.1: tải SONG SONG playlist hình và playlist tiếng (nếu master khai tiếng tách rời).
    const [parsed, parsedAudio] = await Promise.all([
      loadPlaylist(variantUrl, 'hình'),
      audioUrl ? loadPlaylist(audioUrl, 'tiếng') : Promise.resolve(null),
    ]);

    // Ranh giới cứng: SAMPLE-AES/EME -> DỪNG. Phải kiểm CẢ HAI playlist: tiếng có thể được bảo vệ
    // trong khi hình thì không.
    if (parsed.isProtected || parsedAudio?.isProtected) {
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
    // Playlist tiếng rỗng = ghép ra file CÂM. Thà báo lỗi còn hơn im lặng giao file hỏng — đó
    // chính là căn bệnh §2.1 mà W1.1 sinh ra để chữa.
    if (parsedAudio && parsedAudio.segments.length === 0) {
      await updateHlsJob(jobId, {
        phase: 'error',
        error: 'Playlist tiếng không có segment nào.',
      });
      return;
    }

    const concurrency = req.concurrency;
    const total = parsed.segments.length + (parsedAudio?.segments.length ?? 0);

    // Vào 'fetching' NGAY (dù ffmpeg còn đang nạp) -> KHÔNG còn khoảng "chết".
    await updateHlsJob(jobId, {
      phase: 'fetching',
      segmentsTotal: total,
      segmentsDone: 0,
      bytesDownloaded: 0,
      startedAt: Date.now(),
    });

    // Tiến trình GỘP mọi track: user chỉ quan tâm "còn bao nhiêu", không quan tâm hình hay tiếng.
    let done = 0;
    let bytesDownloaded = 0;
    const step = Math.max(1, Math.floor(total / 33));
    const onSegment = async (bytes: number): Promise<void> => {
      bytesDownloaded += bytes;
      done++;
      if (done % step === 0 || done === total) {
        await updateHlsJob(jobId, { segmentsDone: done, bytesDownloaded });
      }
    };

    const ffmpegRef = await ffPromise; // chờ engine trước khi ghi FS
    ff = ffmpegRef;

    const shared = {
      ff: ffmpegRef,
      concurrency,
      writtenFiles,
      throwIfCancelled,
      onSegment,
    };
    // Tuần tự hình rồi tiếng: dùng lại đúng vòng tải đã chứng minh chạy được, và tiếng nhẹ hơn
    // hình cả chục lần nên phần thêm vào không đáng kể.
    const video = await downloadTrack({
      ...shared,
      parsed,
      prefix: parsedAudio ? 'v' : '',
    });
    const audio = parsedAudio
      ? await downloadTrack({ ...shared, parsed: parsedAudio, prefix: 'a' })
      : null;

    // Ghép: concat: protocol nối byte các segment (+ init) rồi remux sang mp4 (-c copy).
    await updateHlsJob(jobId, { phase: 'muxing', muxProgress: 0 });
    const listOf = (t: TrackFiles) =>
      `concat:${(t.initName ? [t.initName, ...t.names] : t.names).join('|')}`;
    const outName = 'output.mp4';
    // Hai input + map TƯỜNG MINH khi tiếng tách rời; giữ NGUYÊN nhánh một-input khi không, vì đó
    // là đường duy nhất đã được chứng minh chạy (e2e 184 segment) — không đụng vào thứ đang chạy.
    const args = audio
      ? [
          '-i',
          listOf(video),
          '-i',
          listOf(audio),
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          '-y',
          outName,
        ]
      : [
          '-i',
          listOf(video),
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          '-y',
          outName,
        ];
    currentMuxJobId = jobId;
    lastMuxPct = -1;
    let code: number;
    try {
      code = await ffmpegRef.exec(args);
    } finally {
      currentMuxJobId = null;
    }
    // Lỗi #30: exec KHÔNG ném khi ffmpeg hỏng, chỉ trả mã ≠ 0. Bỏ qua mã này thì code chạy tiếp
    // tới readFile('output.mp4') — file CHƯA TỪNG được tạo — và user nhận `FS error` cụt lủn
    // trong khi lý do thật đã bị vứt mất. Kiểm mã ở đây là chỗ DUY NHẤT còn giữ được lý do đó.
    if (code !== 0) {
      throw new Error(
        `Ghép video thất bại (ffmpeg mã ${code}).${recentFfmpegLog()}`,
      );
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
      spoofHosts,
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
