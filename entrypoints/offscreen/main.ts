// Offscreen document — chạy việc nặng cần DOM/WASM: ffmpeg.wasm (ghép/remux HLS),
// fetch + giải mã segment, tạo blob URL để tải. Service worker MV3 KHÔNG làm được các việc này.
//
// ffmpeg.wasm dùng @ffmpeg/core SINGLE-THREAD -> KHÔNG cần SharedArrayBuffer.
// Core (.js + .wasm) đóng gói LOCAL trong public/ffmpeg/, load qua chrome.runtime.getURL
// (KHÔNG CDN — CSP MV3 chặn).

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { decryptAes128Cbc, hlsSegmentIv } from '@/utils/crypto';
import { describeError } from '@/utils/errors';
import type { HlsSegmentsResult } from '@/utils/hls';
// ⚠️ `utils/dash` chỉ kéo theo mpd-parser + types + hls + drm — TOÀN BỘ không đụng chrome.storage
// và declarativeNetRequest, nên an toàn cho offscreen (nơi CHỈ có chrome.runtime). Giữ nguyên
// tính chất đó: thêm một import storage/dnr vào chuỗi này là TypeError lúc chạy mà mọi cổng tĩnh
// đều không thấy — đúng con bug từng làm HLS chết câm nhiều commit đầu.
import { parseTrackSegments } from '@/utils/dash';
// An toàn với ràng buộc "offscreen KHÔNG có chrome.storage": liveness.ts chỉ import KIỂU từ
// storage.ts (bị xoá lúc biên dịch) nên không kéo theo một dòng chrome.storage nào.
import { HEARTBEAT_INTERVAL_MS } from '@/utils/liveness';
import { CancelledError, fetchWithRetry, timeoutSignal } from '@/utils/retry';
import {
  CHUNK_THRESHOLD_BYTES,
  DEFAULT_CHUNK_BYTES,
  MAX_PROGRESSIVE_BYTES,
  parseContentRangeTotal,
  planRangeChunks,
  tooLargeMessage,
} from '@/utils/progressive';
import type { DownloadEntry, HlsJob } from '@/utils/storage';
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

// W2.6 — mỗi job một AbortController. TRƯỚC W2.6 đây là `Set<string>` cờ huỷ, mà cờ thì chỉ đọc
// được GIỮA hai bước: worker đang kẹt trong `await fetch` không bao giờ nhìn thấy nó, nên "Huỷ"
// không giật nổi request đang bay -> popup báo đã huỷ trong khi mạng vẫn chạy. Controller thì
// abort thẳng vào request.
const jobAborts = new Map<string, AbortController>();

// Job đang mux hiện tại (để nối sự kiện progress của ffmpeg vào đúng job). Job chạy tuần tự
// nên chỉ có 1 mux tại một thời điểm.
let currentMuxJobId: string | null = null;
let lastMuxPct = -1;

// Các blob URL đang giữ (thu hồi khi background báo tải xong, hoặc sau timeout dự phòng).
const activeBlobUrls = new Set<string>();
const BLOB_TTL_MS = 10 * 60 * 1000;

// W2.5 — AbortController của từng lượt fetch progressive đang bay (huỷ = .abort() giật request ngay).
const progressiveAborts = new Map<string, AbortController>();

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

// W2.6: vòng retry (timeout mỗi lượt + backoff mũ huỷ được + fail-fast + huỷ giật request đang
// bay) nay nằm ở `utils/retry.ts` — thuần, tiêm được fetch, CÓ TEST. Trước W2.6 nó nằm inline ở
// đây nên không một test nào chạm tới được (file này import ffmpeg.wasm).

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
/**
 * Tải NGUYÊN VĂN một manifest (m3u8 hoặc mpd) với timeout + kiểm status.
 *
 * Tách khỏi `loadPlaylist` cho W1.5: DASH cần chính đoạn text đó để parse NHIỀU track (hình +
 * tiếng nằm chung một .mpd), nên phần "tải" phải dùng lại được mà không kèm phần "parse".
 */
async function loadPlaylistText(
  url: string,
  label: string,
  jobSignal?: AbortSignal,
): Promise<string> {
  let text: string;
  // W2.6: ghép timeout với signal huỷ của job -> bấm Huỷ trong lúc đang tải playlist cũng đứt ngay
  // (trước đây chỉ có timeout: huỷ phải chờ hết 30s mới có tác dụng).
  const { signal, dispose } = timeoutSignal(PLAYLIST_TIMEOUT_MS, jobSignal);
  try {
    // Playlist PHẢI có timeout + kiểm status. Không timeout thì một request treo = job treo VĨNH
    // VIỄN ở 'loading', không lỗi, không cách nào biết.
    const res = await fetch(url, {
      credentials: 'include',
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    // Huỷ KHÔNG phải lỗi tải: bọc nó thành "Không tải được playlist" sẽ báo cho user một thông
    // báo lỗi đỏ trong khi thứ vừa xảy ra là chính họ bấm Huỷ.
    if (jobSignal?.aborted) throw new CancelledError('Đã huỷ');
    throw new Error(`Không tải được playlist ${label}: ${describeError(e)}`, {
      cause: e,
    });
  } finally {
    dispose();
  }
  return text;
}

/** Tải + parse một media playlist theo ĐÚNG định dạng của nó. */
async function loadPlaylist(
  url: string,
  label: string,
  jobSignal?: AbortSignal,
  mediaType?: 'hls' | 'dash',
  trackId?: string,
): Promise<HlsSegmentsResult> {
  const text = await loadPlaylistText(url, label, jobSignal);
  return parseTrackSegments(text, url, mediaType, trackId);
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
  parsed: HlsSegmentsResult;
  prefix: string;
  concurrency: number;
  writtenFiles: Set<string>;
  throwIfCancelled: () => void;
  /** W2.6 — signal huỷ của JOB: abort giật mọi request đang bay ra ngay, không chờ vòng lặp. */
  signal: AbortSignal;
  /** Báo 1 segment vừa fetch xong (byte thô, trước giải mã) -> gộp tiến trình mọi track. */
  onSegment: (bytes: number) => Promise<void>;
  /** W2.6 — báo "đang thử lại" để popup không đứng hình câm suốt cả phút. */
  onRetry?: (info: { attempt: number; total: number; reason: string }) => void;
}): Promise<TrackFiles> {
  const {
    ff,
    parsed,
    prefix,
    concurrency,
    writtenFiles,
    throwIfCancelled,
    signal,
  } = o;
  const total = parsed.segments.length;
  const ext = parsed.hasInit ? 'm4s' : 'ts';

  // ⚠️ Cache key AES RIÊNG mỗi track: rendition tiếng thường có #EXT-X-KEY riêng, dùng chung cache
  // theo URI vẫn đúng nhưng để riêng thì không có đường lẫn key giữa hai playlist.
  const keyCache = new Map<string, ArrayBuffer>();
  const getKey = async (keyUri: string): Promise<ArrayBuffer> => {
    const cached = keyCache.get(keyUri);
    if (cached) return cached;
    const kb = await fetchWithRetry(keyUri, {
      signal,
      label: 'khoá giải mã (AES-128)',
      onRetry: o.onRetry,
    });
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
    let buf = await fetchWithRetry(seg.uri, {
      signal,
      label: `${prefix === 'a' ? 'segment tiếng' : 'segment'} #${i + 1}/${total}`,
      onRetry: o.onRetry,
      ...(seg.byterange ? { range: seg.byterange } : {}),
    });
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
    ? fetchWithRetry(firstInitSeg.initUri, {
        signal,
        label: 'phần đầu tệp (init)',
        onRetry: o.onRetry,
        ...(firstInitSeg.initByterange
          ? { range: firstInitSeg.initByterange }
          : {}),
      }).then((b) => new Uint8Array(b))
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

  // W2.6 — TRẦN 6 worker: Chrome chỉ mở tối đa 6 kết nối đồng thời tới MỘT host, request thứ 7
  // trở đi nằm XẾP HÀNG trong pool. Mà đồng hồ chờ-header của ta bấm giờ từ lúc GỌI fetch, nên
  // thời gian nằm xếp hàng bị tính oan -> mạng chậm + concurrency cao (cho phép tới 16) = segment
  // bị giết dù server hoàn toàn khoẻ. Trên >6 cũng KHÔNG nhanh hơn thật (Chrome vẫn xếp hàng),
  // nên trần này không mất tốc độ, chỉ bỏ đi phần chờ vô hình.
  const MAX_INFLIGHT_PER_HOST = 6;
  const workerCount = Math.min(
    Math.max(1, concurrency),
    total,
    MAX_INFLIGHT_PER_HOST,
  );
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
  const {
    jobId,
    variantUrl,
    audioUrl,
    filename,
    mediaUrl,
    tabId,
    spoofRuleIds,
  } = req;
  // W2.6 — controller của job này. `hls/cancel` gọi .abort() -> request đang bay đứt NGAY, và
  // `abortableSleep` trong backoff cũng thức dậy ngay thay vì ngồi hết 8 giây.
  // Huỷ có thể tới TRƯỚC khi job rời hàng đợi (job xếp tuần tự): giữ lại controller đã có sẵn.
  const ac = jobAborts.get(jobId) ?? new AbortController();
  jobAborts.set(jobId, ac);
  const throwIfCancelled = () => {
    if (ac.signal.aborted) throw new CancelledError('Đã huỷ');
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
    // W1.5 — DASH để CẢ hình lẫn tiếng trong MỘT file .mpd: tải một lần rồi parse hai track theo
    // id. Gọi loadPlaylist hai lần ở đây sẽ tải nguyên manifest hai lượt và, tệ hơn, không có
    // cách nào phân biệt track vì `resolvedUri` của mọi representation đều là chính file .mpd.
    const mediaType = req.mediaType;
    let parsed: HlsSegmentsResult;
    let parsedAudio: HlsSegmentsResult | null = null;
    if (mediaType === 'dash') {
      const mpdText = await loadPlaylistText(variantUrl, 'DASH', ac.signal);
      parsed = parseTrackSegments(mpdText, variantUrl, 'dash', req.variantId);
      parsedAudio = req.audioId
        ? parseTrackSegments(mpdText, variantUrl, 'dash', req.audioId)
        : null;
    } else {
      [parsed, parsedAudio] = await Promise.all([
        loadPlaylist(variantUrl, 'hình', ac.signal),
        audioUrl
          ? loadPlaylist(audioUrl, 'tiếng', ac.signal)
          : Promise.resolve(null),
      ]);
    }

    // Ranh giới cứng: SAMPLE-AES/EME -> DỪNG. Phải kiểm CẢ HAI playlist: tiếng có thể được bảo vệ
    // trong khi hình thì không.
    if (parsed.isProtected || parsedAudio?.isProtected) {
      await updateHlsJob(jobId, {
        phase: 'error',
        error: 'Không hỗ trợ nội dung được bảo vệ (SAMPLE-AES/DRM).',
      });
      return;
    }
    // W1.5 — ta parse ĐƯỢC nhưng CỐ Ý không ghép (vd DASH đa Period, mỗi Period một init khác
    // nhau): ghép mù thì ffmpeg vẫn nhận, job vẫn báo "xong", file thì hỏng. Nói thẳng lý do.
    const refuse = parsed.unsupportedReason ?? parsedAudio?.unsupportedReason;
    if (refuse) {
      await updateHlsJob(jobId, { phase: 'error', error: refuse });
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
      signal: ac.signal,
      onSegment,
      // Không await: đây chỉ là ghi chú hiển thị, không được chặn vòng tải.
      onRetry: (info: { attempt: number; total: number; reason: string }) => {
        void updateHlsJob(jobId, {
          note: `Mạng trục trặc (${info.reason}) — đang thử lại lần ${info.attempt}/${info.total}…`,
        });
      },
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
    // Xoá ghi chú "đang thử lại": đã qua khâu tải, để lại thì user tưởng vẫn đang trục trặc.
    await updateHlsJob(jobId, { phase: 'muxing', muxProgress: 0, note: '' });
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
      spoofRuleIds,
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
    jobAborts.delete(jobId);
  }
}

function enqueueHlsJob(
  req: Extract<OffscreenRequest, { kind: 'hls/run' }>,
): void {
  // W2.7 — NHỊP TIM. Offscreen có thể bị Chrome giết bất cứ lúc nào (Task Manager, hết RAM, crash)
  // và nó chết IM LẶNG: không sự kiện nào báo về background, job nằm lại 'fetching' vĩnh viễn.
  // Nhịp này là bằng chứng SỐNG duy nhất. Patch RỖNG là cố ý — background chỉ cần biết "vẫn còn
  // tiếng", nó tự đóng dấu `lastSeenAt` bằng đồng hồ của chính nó.
  //
  // 🔴 ĐẬP TỪ LÚC XẾP HÀNG, KHÔNG PHẢI TỪ LÚC CHẠY — đã ĐO bằng e2e `queued-not-reaped`: job chạy
  // TUẦN TỰ (chỉ 1 instance ffmpeg), nên job #2 nằm im trong hàng đợi suốt thời gian job #1 tải.
  // Đặt nhịp tim trong `runHlsJob` thì job #2 im >60s và bị tick W2.7 **GIẾT OAN sau 61,2s** dù
  // offscreen hoàn toàn khoẻ. Giết oan một lượt tải khoẻ còn TỆ HƠN cái treo mà W2.7 sinh ra để
  // chữa — đúng bẫy "trần theo tổng thời gian" mà W2.5/W2.6 đã trả giá hai lần. Đừng dời vào trong.
  const heartbeat = setInterval(() => {
    void updateHlsJob(req.jobId, {});
  }, HEARTBEAT_INTERVAL_MS);
  jobChain = jobChain
    .then(() => runHlsJob(req))
    .catch(() => undefined)
    // Dọn ở ĐÂY chứ không trong `runHlsJob`: nhịp tim sinh ra trước khi job chạy nên phải chết sau
    // khi job kết thúc. Còn đập tiếp = mỗi 5 giây một message rác, và một job đã chốt 'error' sẽ bị
    // nhịp tim lỡ tay hồi sinh mốc thời gian.
    .finally(() => clearInterval(heartbeat));
}

function revokeBlob(url: string): void {
  if (activeBlobUrls.has(url)) {
    URL.revokeObjectURL(url);
    activeBlobUrls.delete(url);
  }
}

// --- W2.5: tải progressive qua offscreen ---
//
// VÌ SAO (đã ĐO 2026-07-18): `chrome.downloads.download({url})` phát request KHÔNG nhận rule DNR
// modifyHeaders -> server chống hotlink nhận `Referer: NONE` -> 403. `fetch()` của extension ở đây
// là `xmlhttprequest` tab-less -> KHỚP rule spoof (W2.4) -> qua 403. `chrome.downloads.download` do
// đó chỉ còn là công cụ LƯU (nhận blob: URL), đúng bất biến của VDH.

/** Báo tiến trình/kết thúc một lượt fetch progressive về background. KHÔNG ném (như updateHlsJob). */
async function updateProgressiveDownload(
  key: string,
  patch: Partial<DownloadEntry>,
): Promise<void> {
  try {
    await browser.runtime.sendMessage({
      kind: 'download/progress',
      key,
      patch,
    });
  } catch (e) {
    console.warn(
      '[offscreen] không gửi được tiến trình tải progressive:',
      describeError(e),
    );
  }
}

/** Bước report byte tối thiểu (~1MB) — stream trả nhiều mảnh nhỏ, đừng spam storage mỗi mảnh. */
const PROGRESS_REPORT_STEP = 1024 * 1024;

/**
 * Đọc trọn `res.body` (stream) thành Blob, báo tiến trình theo bước. Fallback arrayBuffer nếu không
 * có body. `heartbeat()` gọi mỗi lần nhận byte -> reset watchdog chống treo. Chặn cứng khi vượt trần
 * (server nói dối content-length / không gửi) để offscreen không OOM câm.
 */
async function readBodyToBlob(o: {
  res: Response;
  type: string;
  total: number | null;
  key: string;
  heartbeat: () => void;
}): Promise<Blob> {
  const { res, type, total, key, heartbeat } = o;
  if (!res.body) {
    // Không đọc được stream -> ôm cả file một lần (chấp nhận, file nhỏ).
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_PROGRESSIVE_BYTES) {
      throw new Error(tooLargeMessage(buf.byteLength));
    }
    return new Blob([buf], { type });
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  let lastReport = 0;
  if (total != null) {
    await updateProgressiveDownload(key, {
      bytesTotal: total,
      bytesReceived: 0,
    });
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    heartbeat();
    received += value.byteLength;
    // Chặn trước khi RAM phình vỡ: tổng có thể không biết trước (không content-length) nên phải
    // canh ngay trong lúc đọc. Huỷ reader để nhả kết nối.
    if (received > MAX_PROGRESSIVE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(tooLargeMessage(received));
    }
    parts.push(value);
    if (received - lastReport >= PROGRESS_REPORT_STEP) {
      lastReport = received;
      await updateProgressiveDownload(key, { bytesReceived: received });
    }
  }
  await updateProgressiveDownload(key, { bytesReceived: received });
  return new Blob(parts as BlobPart[], { type });
}

/**
 * Tải file theo Range chunk. Server PHẢI trả 206 ĐÚNG độ dài mỗi đoạn.
 * ⚠️ KHÔNG bó RAM: Blob cuối vẫn ôm trọn file (xem chú thích progressive.ts). Lợi ích: tiến trình +
 * bắt server không tôn trọng Range. `heartbeat()` reset watchdog chống treo.
 */
async function fetchByRangeChunks(o: {
  url: string;
  type: string;
  total: number;
  key: string;
  signal: AbortSignal;
  heartbeat: () => void;
}): Promise<Blob> {
  const { url, type, total, key, signal, heartbeat } = o;
  const parts: Uint8Array[] = [];
  let received = 0;
  await updateProgressiveDownload(key, { bytesTotal: total, bytesReceived: 0 });
  for (const c of planRangeChunks(total, DEFAULT_CHUNK_BYTES)) {
    const r = await fetch(url, {
      credentials: 'include',
      headers: { Range: `bytes=${c.start}-${c.end}` },
      signal,
    });
    // Server PHẢI tôn trọng Range: 200 = trả nguyên file cho mỗi đoạn -> ôm N lần cả file (đúng bẫy
    // W1.3). Thà FAIL LỚN TIẾNG hơn là ghép byte rác.
    if (r.status !== 206) {
      throw new Error(
        `Máy chủ không hỗ trợ tải theo đoạn (Range): trả HTTP ${r.status} thay vì 206.`,
      );
    }
    const buf = new Uint8Array(await r.arrayBuffer());
    heartbeat();
    // 206 NGẮN HƠN range yêu cầu (RFC cho phép; proxy/CDN cap range) -> cộng theo kích thước KẾ HOẠCH
    // sẽ nhảy cóc phần đuôi, ghép Blob thiếu byte mà vẫn 'complete'. Kiểm độ dài THẬT, fail lớn tiếng.
    const want = c.end - c.start + 1;
    if (buf.byteLength !== want) {
      throw new Error(
        `Máy chủ trả đoạn ngắn hơn yêu cầu (${buf.byteLength}/${want} byte) — dừng để tránh file hỏng.`,
      );
    }
    parts.push(buf);
    received += buf.byteLength;
    await updateProgressiveDownload(key, { bytesReceived: received });
  }
  return new Blob(parts as BlobPart[], { type });
}

/**
 * Không có byte mới trong ngần này = coi như server treo -> abort. Reset mỗi lần nhận byte (heartbeat)
 * nên KHÔNG cắt oan download chậm-nhưng-đang-chạy; chỉ cắt khi đứng im. Đường HLS đã có bất biến này
 * (PLAYLIST_TIMEOUT_MS); progressive từng đánh rơi -> job kẹt 'in_progress' mãi + rule spoof leak.
 */
const PROGRESSIVE_STALL_MS = 60_000;

async function runProgressiveDownload(
  req: Extract<OffscreenRequest, { kind: 'download/run' }>,
): Promise<void> {
  const { key, url, filename, mediaUrl, tabId, spoofRuleIds } = req;
  const ac = new AbortController();
  progressiveAborts.set(key, ac);

  // W2.7 — NHỊP TIM LIVENESS (khác hẳn `heartbeat` watchdog bên dưới: cái đó canh SERVER câm, cái
  // này chứng minh OFFSCREEN còn sống). W2.5 đưa .mp4 qua offscreen nên đường này phụ thuộc offscreen
  // y như HLS; offscreen bị giết ⇒ `finally` không chạy ⇒ không ai gửi 'interrupted' ⇒ entry kẹt
  // `in_progress` vĩnh viễn (ĐÃ ĐO: e2e `progressive-offscreen-death` kẹt >150s trước bản vá này).
  const livenessPing = setInterval(() => {
    void updateProgressiveDownload(key, {});
  }, HEARTBEAT_INTERVAL_MS);

  // Watchdog chống treo: không tiến triển trong PROGRESSIVE_STALL_MS -> abort. `stalled` phân biệt
  // với user-cancel để báo lỗi đúng (treo mạng vs bấm Hủy).
  let stalled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const heartbeat = (): void => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      ac.abort();
    }, PROGRESSIVE_STALL_MS);
  };

  try {
    heartbeat(); // canh cả cú probe: server không trả headers trong 60s -> abort.
    // Probe Range 1 byte: (1) đo tổng file + server có hỗ trợ Range không; (2) là cú fetch ĐẦU tiên
    // qua rule spoof -> 403 ở đây = spoof không áp (báo lỗi rõ thay vì tải byte rác).
    const probe = await fetch(url, {
      credentials: 'include',
      headers: { Range: 'bytes=0-0' },
      signal: ac.signal,
    });
    heartbeat();
    if (!probe.ok && probe.status !== 206) {
      throw new Error(`Máy chủ trả mã ${probe.status}.`);
    }
    const contentType = probe.headers.get('content-type') || 'video/mp4';
    const total =
      probe.status === 206
        ? parseContentRangeTotal(probe.headers.get('content-range'))
        : Number(probe.headers.get('content-length')) || null;

    // Trần cứng: file quá lớn -> BÁO LỖI RÕ, đừng để offscreen OOM-crash câm (mất cả nhánh catch dưới
    // -> job kẹt mãi + rule leak). Bó RAM thật là Đợt 3 (OPFS). Tổng không biết -> canh mid-stream.
    if (total != null && total > MAX_PROGRESSIVE_BYTES) {
      throw new Error(tooLargeMessage(total));
    }

    let blob: Blob;
    if (
      probe.status === 206 &&
      total != null &&
      total > CHUNK_THRESHOLD_BYTES
    ) {
      // File LỚN + server hỗ trợ Range -> chunk. Bỏ body probe (1 byte).
      await probe.body?.cancel().catch(() => undefined);
      blob = await fetchByRangeChunks({
        url,
        type: contentType,
        total,
        key,
        signal: ac.signal,
        heartbeat,
      });
    } else if (probe.status === 200) {
      // Server phớt Range -> body probe LÀ nguyên file, đọc luôn (không fetch lại).
      blob = await readBodyToBlob({
        res: probe,
        type: contentType,
        total,
        key,
        heartbeat,
      });
    } else {
      // File nhỏ (206) hoặc tổng không rõ -> một GET nguyên file, stream body.
      await probe.body?.cancel().catch(() => undefined);
      const res = await fetch(url, {
        credentials: 'include',
        signal: ac.signal,
      });
      heartbeat();
      if (!res.ok) throw new Error(`Máy chủ trả mã ${res.status}.`);
      const streamTotal =
        total ?? (Number(res.headers.get('content-length')) || null);
      blob = await readBodyToBlob({
        res,
        type: contentType,
        total: streamTotal,
        key,
        heartbeat,
      });
    }

    // Giao blob về background để LƯU qua chrome.downloads (chỉ nhận blob: URL — bất biến VDH).
    const blobUrl = URL.createObjectURL(blob);
    activeBlobUrls.add(blobUrl);
    setTimeout(() => revokeBlob(blobUrl), BLOB_TTL_MS);
    await browser.runtime.sendMessage({
      kind: 'download/blob',
      blobUrl,
      filename,
      mediaUrl,
      tabId,
      // Không phải job HLS: dùng downloadKey để background gắn vào ĐÚNG DownloadEntry đang fetch.
      jobId: key,
      downloadKey: key,
      spoofRuleIds,
    });
  } catch (e) {
    const userCancelled =
      !stalled &&
      (ac.signal.aborted || (e instanceof Error && e.name === 'AbortError'));
    await updateProgressiveDownload(key, {
      state: 'interrupted',
      error: stalled
        ? 'Máy chủ không phản hồi (quá thời gian chờ).'
        : userCancelled
          ? 'Đã huỷ'
          : describeError(e),
    });
  } finally {
    if (watchdog) clearTimeout(watchdog);
    clearInterval(livenessPing);
    progressiveAborts.delete(key);
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
        // Huỷ có thể tới TRƯỚC khi job rời hàng đợi (jobChain tuần tự) -> tạo sẵn controller đã
        // abort để runHlsJob nhặt lên và thoát ngay, thay vì tải xong rồi mới biết mình bị huỷ.
        {
          const existing = jobAborts.get(req.jobId);
          if (existing) existing.abort();
          else {
            const pre = new AbortController();
            pre.abort();
            jobAborts.set(req.jobId, pre);
            // Huỷ một job đã kết thúc (hoặc chưa từng tồn tại) sẽ để lại entry này VĨNH VIỄN —
            // offscreen là trang bền nên Map chỉ phình lên. Hẹn giờ dọn: nếu job có thật thì nó
            // đã nhặt controller lên và runHlsJob tự xoá trong finally, xoá lại là vô hại.
            setTimeout(() => {
              if (jobAborts.get(req.jobId) === pre) jobAborts.delete(req.jobId);
            }, 60_000);
          }
        }
        return undefined;
      case 'revoke':
        revokeBlob(req.url);
        return undefined;
      case 'download/run':
        // Progressive KHÔNG dùng ffmpeg/FS ảo -> chạy ĐỘC LẬP với jobChain (không cần tuần tự như
        // HLS). runProgressiveDownload tự bắt lỗi + báo về background, nên chỉ cần nuốt rejection thừa.
        void runProgressiveDownload(req).catch((e: unknown) =>
          console.warn(
            '[offscreen] tải progressive lỗi ngoài dự kiến:',
            describeError(e),
          ),
        );
        return undefined;
      case 'download/abort':
        progressiveAborts.get(req.key)?.abort();
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
