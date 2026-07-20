// Offscreen document — chạy việc nặng cần DOM/WASM: ghép/remux HLS bằng libav.js,
// fetch + giải mã segment, tạo blob URL để tải. Service worker MV3 KHÔNG làm được các việc này.
//
// W3.1 — @ffmpeg/core (GPL, 32,2 MB, gom cả video vào RAM) ĐÃ ĐƯỢC GỠ, thay bằng bản libav.js
// tự dựng (variant `ts2mp4d`, LGPL-2.1, 1,56 MB wasm, 0 encoder) chạy trong một Worker và
// truyền byte qua OPFS. Ba lý do, theo đúng thứ tự quan trọng:
//   1. PHÁP LÝ: @ffmpeg/core dựng với --enable-gpl nên là GPL, trong khi dự án khai MIT.
//   2. Bộ nhớ: bản cũ giữ cả video trong RAM; bản này RAM PHẲNG (đo tới input 1,19 GB).
//   3. Kích thước bundle: 34,8 MB -> ~2,4 MB.
// Việc ghép nằm ở `mux-worker.ts` (nơi duy nhất có FileSystemSyncAccessHandle); lõi thuần
// ở `utils/remux-core.ts` + `utils/remux-time.ts` để chạy test được dưới node.
import {
  MuxCancelledError,
  MuxSession,
  removeOpfsFile,
  sweepOrphanOpfsFiles,
} from './libav-mux';
import type { MuxTrackSpec } from './mux-worker';
import { decryptAes128Cbc, segmentIv } from '@/utils/crypto';
import { DRM_UNSUPPORTED_ERROR } from '@/utils/drm';
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
import {
  CancelledError,
  FatalFetchError,
  fetchWithRetry,
  timeoutSignal,
} from '@/utils/retry';
import {
  CHUNK_THRESHOLD_BYTES,
  DEFAULT_CHUNK_BYTES,
  MAX_PROGRESSIVE_BYTES,
  parseContentRangeTotal,
  planRangeChunks,
  tooLargeMessage,
} from '@/utils/progressive';
import type { DownloadEntry, HlsJob } from '@/utils/storage';
import type {
  EngineSelfTestResponse,
  OffscreenRequest,
} from '@/utils/messages';

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

// Xếp hàng job HLS TUẦN TỰ: chỉ có 1 instance ffmpeg -> KHÔNG chạy 2 job song song
// (tránh đụng độ tên file trong FS ảo dùng chung).
let jobChain: Promise<void> = Promise.resolve();

// W2.6 — mỗi job một AbortController. TRƯỚC W2.6 đây là `Set<string>` cờ huỷ, mà cờ thì chỉ đọc
// được GIỮA hai bước: worker đang kẹt trong `await fetch` không bao giờ nhìn thấy nó, nên "Huỷ"
// không giật nổi request đang bay -> popup báo đã huỷ trong khi mạng vẫn chạy. Controller thì
// abort thẳng vào request.
const jobAborts = new Map<string, AbortController>();

// Phần trăm mux đã báo gần nhất — throttle theo bước 1% để không spam storage.
// (Job chạy TUẦN TỰ nên chỉ có 1 mux tại một thời điểm; không cần khoá theo jobId.)
let lastMuxPct = -1;

// Các blob URL đang giữ (thu hồi khi background báo tải xong, hoặc sau timeout dự phòng).
const activeBlobUrls = new Set<string>();
const BLOB_TTL_MS = 10 * 60 * 1000;

/**
 * blob URL -> tên file OPFS đứng sau nó.
 *
 * 🔴 KHÔNG xoá file OPFS ngay sau khi gửi `download/blob`: background xử lý tin đó theo kiểu
 * bắn-rồi-quên (`background.ts:405-416` trả `undefined`, không ACK), nên offscreen KHÔNG biết
 * `chrome.downloads.download()` đã được gọi hay chưa. ĐO ĐƯỢC là xoá SAU khi `download()` trả
 * id thì an toàn tuyệt đối (tải xong đủ byte kể cả khi xoá file, giết offscreen, hay nạp lại
 * cả extension giữa chừng) — nhưng "sau khi trả id" là mốc mà chỉ background nhìn thấy.
 * Nên bám vào tín hiệu đã có sẵn trong giao thức: background gửi `revoke` khi lượt tải kết
 * thúc. Kèm hạn chót TTL và lượt quét lúc khởi động để không bao giờ rò rỉ file.
 */
const opfsByBlobUrl = new Map<string, string>();

// W2.5 — AbortController của từng lượt fetch progressive đang bay (huỷ = .abort() giật request ngay).
const progressiveAborts = new Map<string, AbortController>();

// Trần thời gian tải playlist (manifest chỉ vài KB -> 30s là quá rộng rãi).
const PLAYLIST_TIMEOUT_MS = 30_000;

/**
 * Tự kiểm bộ ghép video.
 *
 * Chạy ĐÚNG đường thật: nạp libav trong Worker, nối một segment MPEG-TS thật (18 KB, kèm
 * trong bundle) vào OPFS, ghép ra mp4, đọc lại kích thước. Không phải "đã nạp được wasm" —
 * nó đi trọn demux -> chỉnh timestamp -> muxer -> writer device -> OPFS.
 *
 * Bản ffmpeg cũ dựng video test bằng `-f lavfi testsrc`, tức là dùng ENCODER. Bản libav.js
 * này CỐ Ý không có encoder nào (đó là lý do nó nhỏ 1,56 MB và không dính GPL), nên phép thử
 * phải đổi sang remux — và remux mới đúng là việc extension làm thật.
 */
async function runEngineSelfTest(): Promise<EngineSelfTestResponse> {
  let session: MuxSession | null = null;
  try {
    session = await MuxSession.start('selftest');
    // ⚠️ Đuôi `.bin` chứ KHÔNG phải `.ts`: đây là MPEG-TS, mà `tsc` thấy đuôi .ts là coi nó
    // như TypeScript và cả `pnpm compile` gãy ngay ("File appears to be binary").
    const res = await fetch(browser.runtime.getURL('/libav/selftest.bin'));
    if (!res.ok)
      throw new Error(`Không đọc được tệp thử (HTTP ${res.status}).`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await session.appendSegment('', bytes);
    const outcome = await session.mux(
      [{ prefix: '', kind: 'any', adtsToAsc: true }],
      () => undefined,
    );
    if (outcome.outBytes <= 0) throw new Error('Ghép ra tệp rỗng.');
    return { ok: true, size: outcome.outBytes };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  } finally {
    if (session) {
      await session.cleanup(null);
      session.dispose();
    }
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

/** Kết quả tải một track: đã nối bao nhiêu segment và bao nhiêu byte vào file OPFS. */
interface TrackBytes {
  segments: number;
  /** Byte SAU giải mã — đúng số byte nằm trên đĩa. */
  bytes: number;
}

/**
 * Tải trọn segment của MỘT playlist vào FS ảo của ffmpeg.
 *
 * W1.1 tách hàm này ra khỏi runHlsJob để dùng lại cho luồng TIẾNG tách rời: hình và tiếng là hai
 * playlist độc lập, mỗi bên có #EXT-X-KEY, #EXT-X-MAP và SỐ SEGMENT riêng (đo trên fixture thật:
 * hình 10 segment, tiếng 11) -> mọi giả định "hai bên giống nhau" đều sai.
 *
 * `prefix` tách không gian tên file OPFS của hai track (`ymv-<job>-v.bin` vs `ymv-<job>-a.bin`).
 *
 * W3.1: byte KHÔNG còn đi vào FS ảo của ffmpeg nữa mà nối thẳng vào MỘT file OPFS mỗi track,
 * qua Worker. Đây chính là chỗ bỏ được trần RAM: trước đây mỗi segment tồn tại hai lần (buffer
 * vừa fetch + bản sao trong MEMFS), nay nó đi thẳng từ mạng xuống đĩa.
 */
async function downloadTrack(o: {
  session: MuxSession;
  parsed: HlsSegmentsResult;
  prefix: string;
  concurrency: number;
  throwIfCancelled: () => void;
  /** W2.6 — signal huỷ của JOB: abort giật mọi request đang bay ra ngay, không chờ vòng lặp. */
  signal: AbortSignal;
  /** Báo 1 segment vừa fetch xong (byte thô, trước giải mã) -> gộp tiến trình mọi track. */
  onSegment: (bytes: number) => Promise<void>;
  /** W2.6 — báo "đang thử lại" để popup không đứng hình câm suốt cả phút. */
  onRetry?: (info: { attempt: number; total: number; reason: string }) => void;
}): Promise<TrackBytes> {
  const { session, parsed, prefix, concurrency, throwIfCancelled, signal } = o;
  const total = parsed.segments.length;

  // ⚠️ Cache key AES RIÊNG mỗi track: rendition tiếng thường có #EXT-X-KEY riêng, dùng chung cache
  // theo URI vẫn đúng nhưng để riêng thì không có đường lẫn key giữa hai playlist.
  //
  // 🔴 Cache PROMISE chứ không cache KẾT QUẢ (đã ĐO 2026-07-19): vòng tải gọi `getKey` từ nhiều
  // segment SONG SONG, nên bản cache-kết-quả để mọi lượt cùng trượt cache rồi cùng fetch — đo
  // thật trên fixture 10 segment: **3-5 lượt tải khoá cho 1-2 khoá thật**, và con số còn đổi
  // giữa các lần chạy. Ngoài đời đó là N request thừa lên đúng endpoint mà CDN hay giới hạn nhịp.
  // Cache promise thì lượt sau bám vào lượt đầu -> đúng 1 request mỗi URI, và số đó TẤT ĐỊNH nên
  // ca e2e mới ghim được "xoay khoá phải lấy ĐÚNG 2 khoá".
  const keyCache = new Map<string, Promise<ArrayBuffer>>();
  const getKey = (keyUri: string): Promise<ArrayBuffer> => {
    const cached = keyCache.get(keyUri);
    if (cached) return cached;
    const p = fetchWithRetry(keyUri, {
      signal,
      label: 'khoá giải mã (AES-128)',
      onRetry: o.onRetry,
    }).catch((e: unknown) => {
      // Hỏng thì BỎ khỏi cache để lượt sau được thử lại — NHƯNG CHỈ với lỗi đáng thử lại.
      //
      // 🔴 Với 401/403/404/410 (`FatalFetchError`) thì KHÔNG được xoá: `fetchWithRetry` cố ý
      // không thử lại mấy mã đó, mà tới 6 worker fetch chạy song song đều gọi `getKey` sau khi
      // segment riêng của chúng về. Xoá cache = mỗi worker phát thêm một request lên đúng
      // endpoint khoá vừa từ chối dứt khoát -> tối đa 6 cú đập, đúng thứ nâng rủi ro từ throttle
      // mềm lên chặn IP cứng (xem chú thích isFatalHttpStatus ở utils/retry.ts).
      // Huỷ job (`CancelledError`) cũng vậy: không có lượt sau nào để mà phục vụ.
      if (!(e instanceof FatalFetchError) && !(e instanceof CancelledError)) {
        keyCache.delete(keyUri);
      }
      throw e;
    });
    keyCache.set(keyUri, p);
    return p;
  };

  /**
   * Giải mã một segment, và QUAN TRỌNG NHẤT: biến lỗi WebCrypto thành lời người đọc được.
   *
   * 🔴 ĐÃ ĐO trên bản trước bản vá này (2026-07-19, e2e `aes128-bad-key`): sai khoá -> WebCrypto
   * ném `DOMException(OperationError)` mà **`message` RỖNG** -> job kết thúc với `error: ""` ->
   * popup hiện một dòng đỏ TRỐNG KHÔNG. Khoá trả về không phải 16 byte (CDN chuyển hướng về trang
   * đăng nhập — rất hay gặp) thì được câu tiếng Anh `"AES key data must be 128 or 256 bits"`,
   * cũng vô nghĩa với người dùng. Cả hai đều là hỏng-âm-thầm: không phân biệt nổi với mất mạng.
   */
  const decryptSegment = async (
    data: ArrayBuffer,
    keyBytes: ArrayBuffer,
    iv: Uint8Array<ArrayBuffer>,
    label: string,
  ): Promise<ArrayBuffer> => {
    // Kiểm độ dài TRƯỚC: đây là ca "server trả HTML thay khoá", và nói thẳng ra thì hữu ích hơn
    // nhiều so với việc để importKey ném câu tiếng Anh về số bit.
    if (keyBytes.byteLength !== 16) {
      throw new Error(
        `Khoá giải mã AES-128 không hợp lệ: nhận ${keyBytes.byteLength} byte thay vì 16. ` +
          'Máy chủ có thể đã trả về trang đăng nhập/thông báo lỗi thay cho khoá.',
      );
    }
    try {
      return await decryptAes128Cbc(data, keyBytes, iv);
    } catch (e) {
      // KHÔNG chuyển tiếp e.message: nó rỗng ở đúng ca hay gặp nhất (sai khoá).
      const raw = e instanceof Error ? e.message.trim() : '';
      throw new Error(
        `Giải mã AES-128 thất bại ở ${label} — khoá không khớp với dữ liệu. ` +
          'Khoá có thể đã hết hạn hoặc máy chủ phát nhầm khoá.' +
          (raw ? ` (${raw})` : ''),
        { cause: e },
      );
    }
  };

  const fetchSegmentBytes = async (i: number): Promise<Uint8Array> => {
    throwIfCancelled();
    const seg = parsed.segments[i]!;
    // An toàn: segment giữa chừng dùng mã hoá khác AES-128 (mixed method) -> DỪNG.
    const method = seg.keyMethod;
    if (method && method !== 'NONE' && method !== 'AES-128') {
      throw new Error(`Segment dùng mã hoá không hỗ trợ: ${method}`);
    }
    // 🔴 Khai AES-128 mà KHÔNG có địa chỉ khoá (`#EXT-X-KEY` thiếu URI, hoặc URI rỗng bị
    // `utils/hls.ts` biến thành undefined): nhánh giải mã bên dưới có điều kiện `&& seg.keyUri`
    // nên nó sẽ ÂM THẦM BỎ QUA và ghi thẳng ciphertext xuống OPFS. Kết quả là file rác, hoặc một
    // lỗi demux khó hiểu đổ tội cho khâu ghép. Ném ở đây để lỗi nói đúng nguyên nhân.
    if (method === 'AES-128' && !seg.keyUri) {
      throw new Error(
        'Segment khai mã hoá AES-128 nhưng playlist không cho biết địa chỉ khoá ' +
          '(#EXT-X-KEY thiếu URI).',
      );
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
      const iv = segmentIv(seg);
      buf = await decryptSegment(
        buf,
        key,
        iv,
        `${prefix === 'a' ? 'segment tiếng' : 'segment'} #${i + 1}/${total}`,
      );
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

  let writtenBytes = 0;
  // init PHẢI nằm ĐẦU file, trước segment 0 — nó là phần header của cả track.
  let initBytes = await initPromise;
  // 🔴 RFC 8216 §4.3.2.5: khoá AES-128 áp cho MỌI Media Segment **VÀ** cho Media Initialization
  // Section khai bởi #EXT-X-MAP nằm trong tầm của #EXT-X-KEY đó (và chính vì vậy chuẩn BẮT BUỘC
  // khai IV tường minh cho ca này). Trước bản vá, init được ghi THẲNG không giải mã -> ciphertext
  // nằm đúng chỗ `ftyp`/`moov`, tức byte ĐẦU TIÊN của file, trong khi mọi segment phía sau lại
  // đúng -> libav không nhận ra định dạng và job chết với thông báo đổ tội cho khâu GHÉP.
  //
  // 🔴 NHƯNG PHẠM VI KHOÁ ĐI THEO VỊ TRÍ TAG, KHÔNG THEO SEGMENT (lỗi do review đối kháng bắt,
  // 2026-07-20). Dùng `firstInitSeg.keyMethod/keyUri` (khoá của SEGMENT) là SAI: playlist khai
  // `#EXT-X-MAP` TRƯỚC `#EXT-X-KEY` có init TRONG SÁNG — hình dạng hợp lệ và phổ biến, vì init
  // trong sáng cho player đọc codec trước khi đi xin khoá. Bản cũ đem giải mã init đó -> WebCrypto
  // ném lỗi padding -> **giết oan một stream khoẻ** kèm câu đổ tội máy chủ phát nhầm khoá. Nay đọc
  // khoá RIÊNG của init (`initKeyMethod/initKeyUri/initIv`, lấy từ `segment.map.key` — đã đo là
  // m3u8-parser mô hình đúng phạm vi). Ca `fmp4-clear-init` ghim chiều này, `fmp4-aes-init` ghim
  // chiều kia. **Đừng suy khoá init từ khoá segment nữa.**
  const initMethod = firstInitSeg?.initKeyMethod;
  if (initMethod && initMethod !== 'NONE' && initMethod !== 'AES-128') {
    throw new Error(`Init segment dùng mã hoá không hỗ trợ: ${initMethod}`);
  }
  // Khai AES-128 cho init mà thiếu URI khoá: ném thay vì âm thầm ghi ciphertext làm header.
  if (initMethod === 'AES-128' && !firstInitSeg?.initKeyUri) {
    throw new Error(
      'Phần đầu tệp (init) khai mã hoá AES-128 nhưng playlist không cho biết địa chỉ khoá ' +
        '(#EXT-X-KEY thiếu URI).',
    );
  }
  if (initBytes && initMethod === 'AES-128' && firstInitSeg?.initKeyUri) {
    const key = await getKey(firstInitSeg.initKeyUri);
    const iv = segmentIv({
      seq: firstInitSeg.seq,
      ...(firstInitSeg.initIv ? { iv: firstInitSeg.initIv } : {}),
    });
    initBytes = new Uint8Array(
      await decryptSegment(
        initBytes.buffer as ArrayBuffer,
        key,
        iv,
        'phần đầu tệp (init)',
      ),
    );
  }
  if (initBytes) {
    writtenBytes += initBytes.byteLength;
    await session.appendSegment(prefix, initBytes);
  }

  // Vòng writer: nối tuần tự theo thứ tự index để giải phóng RAM sớm.
  //
  // PHẢI "xí phần" chỉ số (nextWrite++) TRƯỚC khi await. writeReady() được gọi từ NHIỀU worker
  // fetch song song; nếu tăng sau await thì worker B đọc lại đúng nextWrite mà worker A đang ghi
  // dở -> ghi trùng một buffer. Mà `appendSegment` TRANSFER (detach) ArrayBuffer sang Worker —
  // y hệt `ffmpeg.writeFile` ngày trước — nên lần ghi thứ hai nổ "ArrayBuffer is detached".
  // Ràng buộc MỚI của W3.1: thứ tự cũng là thứ tự BYTE trên đĩa, nên vòng này còn là thứ giữ
  // cho segment nối đúng trình tự phát.
  const writeReady = async (): Promise<void> => {
    while (nextWrite < total && buffers[nextWrite] !== undefined) {
      throwIfCancelled();
      const i = nextWrite;
      nextWrite++;
      const bytes = buffers[i]!;
      buffers[i] = undefined; // nhả tham chiếu ngay: buffer sắp bị transfer sang Worker
      writtenBytes += bytes.byteLength;
      await session.appendSegment(prefix, bytes);
      names[i] = 'ok';
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

  return { segments: total, bytes: writtenBytes };
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

  let session: MuxSession | null = null;
  let deliveredOpfs: string | null = null;

  try {
    throwIfCancelled();
    await updateHlsJob(jobId, { phase: 'loading' });

    // Dựng Worker + nạp libav SONG SONG với việc tải playlist (chưa await vội).
    // `jobKey` làm mọi file OPFS của job này KHÔNG ĐỤNG job khác: ĐO ĐƯỢC là file OPFS sống
    // sót qua cả việc giết offscreen, nạp lại extension và khởi động lại trình duyệt, nên tên
    // cố định kiểu `in.ts`/`out.mp4` sẽ khiến job sau lặng lẽ dùng lại rác của job trước.
    const jobKey = jobId.replace(/[^a-zA-Z0-9_-]/g, '');
    const sessionPromise = MuxSession.start(jobKey);

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
        error: DRM_UNSUPPORTED_ERROR(parsed.drmName ?? parsedAudio?.drmName),
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

    session = await sessionPromise; // chờ Worker sẵn sàng trước khi ghi byte nào
    const activeSession = session;
    // Bấm Huỷ trong lúc ĐANG GHÉP: báo thẳng vào Worker để nó dừng ở lô packet kế tiếp.
    // Khác hẳn bản ffmpeg cũ — `exec` của ffmpeg.wasm KHÔNG ngắt được, huỷ chỉ có tác dụng
    // sau khi ghép xong. ĐO ĐƯỢC: postMessage tới Worker đang ghép tới nơi trong ~5ms.
    ac.signal.addEventListener('abort', () => void activeSession.cancel(), {
      once: true,
    });

    const shared = {
      session: activeSession,
      concurrency,
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

    // Cổng cuối trước khi ghép: track rỗng byte = chắc chắn ra file hỏng. Bản ffmpeg cũ dò
    // lỗ bằng ô `undefined` trong mảng tên file; nối byte vào một file thì dấu vết đó không
    // còn, nên phải đếm byte. (Worker còn đối chiếu lần nữa với `getSize()` trên đĩa.)
    if (video.bytes === 0 || (audio !== null && audio.bytes === 0)) {
      throw new Error(
        `Tải về 0 byte (hình ${video.bytes}, tiếng ${audio?.bytes ?? 0}) — không ghép để tránh ra file hỏng.`,
      );
    }

    // Ghép bằng libav.js trong Worker: đọc thẳng từ OPFS, ghi thẳng ra OPFS.
    // Xoá ghi chú "đang thử lại": đã qua khâu tải, để lại thì user tưởng vẫn đang trục trặc.
    await updateHlsJob(jobId, { phase: 'muxing', muxProgress: 0, note: '' });
    const tracks: MuxTrackSpec[] = audio
      ? [
          { prefix: 'v', kind: 'video', adtsToAsc: !parsed.hasInit },
          {
            prefix: 'a',
            kind: 'audio',
            adtsToAsc: !(parsedAudio?.hasInit ?? false),
          },
        ]
      : [{ prefix: '', kind: 'any', adtsToAsc: !parsed.hasInit }];

    lastMuxPct = -1;
    const outcome = await activeSession.mux(tracks, (fraction) => {
      const pct = Math.floor(fraction * 100);
      if (pct === lastMuxPct) return;
      lastMuxPct = pct;
      void updateHlsJob(jobId, { muxProgress: fraction });
    });
    if (!outcome.moovAtFront) {
      // Không phải lỗi: file vẫn đúng, chỉ là moov nằm cuối nên phát qua mạng sẽ phải tải
      // hết mới bắt đầu. Ghi log để còn biết đường lùi đã được dùng.
      console.warn('[offscreen] phải lùi về moov ở cuối file cho job', jobId);
    }

    await updateHlsJob(jobId, { phase: 'saving' });

    // Nếu user đã huỷ trong lúc mux/lưu -> DỪNG, không tải file về (tránh "hoàn tất giả").
    throwIfCancelled();

    // 🔬 ĐO ĐƯỢC (Edge 150, extension thật, file 1,2 GB): `getFile()` 0,0 ms +
    // `createObjectURL()` 0,1 ms, RSS PHẲNG, JS heap không đổi -> blob này là THAM CHIẾU tới
    // file trên đĩa, KHÔNG phải bản sao trong RAM. Nếu nó nạp hết vào RAM thì cả kiến trúc
    // OPFS của W3.1 vô nghĩa; vì vậy con số này là thứ cần đo lại nếu Chrome đổi hành vi.
    const outFile = await MuxSession.openOutput(outcome.outName);
    const blobUrl = URL.createObjectURL(outFile);
    activeBlobUrls.add(blobUrl);
    opfsByBlobUrl.set(blobUrl, outcome.outName);
    deliveredOpfs = outcome.outName;
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
    // Worker báo huỷ bằng lớp lỗi riêng của nó -> quy về đúng một nhánh 'cancelled'.
    if (e instanceof CancelledError || e instanceof MuxCancelledError) {
      await updateHlsJob(jobId, { phase: 'cancelled', error: 'Đã huỷ' });
    } else {
      await updateHlsJob(jobId, { phase: 'error', error: describeError(e) });
    }
  } finally {
    // Dọn file OPFS dù thành công/lỗi/huỷ. GIỮ LẠI file kết quả nếu nó đã được giao cho
    // background (blob URL đang trỏ vào đó) — nó sẽ được xoá lúc `revoke` hoặc hết TTL.
    if (session) {
      await session.cleanup(deliveredOpfs);
      session.dispose();
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
  // Tới đây lượt tải đã kết thúc (background báo revoke) hoặc đã quá TTL -> xoá file OPFS.
  // ĐO ĐƯỢC: xoá file trong lúc `chrome.downloads` đang đọc nó VẪN tải xong đủ byte (ngữ nghĩa
  // unlink kiểu POSIX), nên ở đây không có cửa sổ nguy hiểm nào.
  const opfsName = opfsByBlobUrl.get(url);
  if (opfsName !== undefined) {
    opfsByBlobUrl.delete(url);
    void removeOpfsFile(opfsName);
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
      case 'engine/selftest':
        void runEngineSelfTest()
          .then(
            (res: EngineSelfTestResponse) => sendResponse(res),
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

// W3.1 — quét file OPFS mồ côi của các job đã chết (offscreen bị giết giữa chừng, trình duyệt
// tắt ngang). ĐO ĐƯỢC: file OPFS sống sót qua closeDocument, reload extension, và cả khởi động
// lại trình duyệt — không có ai tự dọn hộ. Chạy lúc offscreen vừa dựng: thời điểm đó chắc chắn
// chưa có job nào đang chạy, nên không thể xoá nhầm file đang dùng.
void sweepOrphanOpfsFiles()
  .then((n) => {
    if (n > 0) console.log('[offscreen] đã dọn', n, 'tệp tạm mồ côi');
  })
  .catch(() => undefined);

// W3.1 — KHÔNG còn prewarm engine ở đây. Bản ffmpeg cũ phải nạp sẵn 32 MB wasm vì nạp mất
// nhiều giây; libav.js chỉ 1,56 MB và Worker được dựng NGAY khi job bắt đầu, song song với
// việc tải playlist (`MuxSession.start` gọi trước `await` đầu tiên trong runHlsJob), nên
// khoảng chết đã được che mà không phải giữ wasm sống suốt phiên.
