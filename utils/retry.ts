// W2.6 — vòng retry cho việc tải segment/key/init.
//
// VÌ SAO TÁCH RA KHỎI offscreen/main.ts: file đó import ffmpeg.wasm + đụng `browser.runtime` nên
// vitest không nạp nổi -> vòng retry (thứ chạy hàng trăm lần mỗi job) chưa từng có một test nào.
// Tách phần THUẦN ra đây (fetch được tiêm vào) thì test đỏ tái hiện được đúng 4 lỗi §2.9.

/** Lỗi KHÔNG thử lại được — thử lại chỉ tốn băng thông mà kết quả y hệt. */
export class FatalFetchError extends Error {}

/** Job đã bị huỷ giữa chừng — KHÔNG phải lỗi mạng, không được thử lại, không báo là "lỗi". */
export class CancelledError extends Error {}

/**
 * Trần chờ PHẢN HỒI ĐẦU TIÊN (header) của mỗi lượt thử.
 *
 * ⚠️ ĐÂY KHÔNG PHẢI trần cho cả lượt tải, và CỐ Ý không phải. Một segment 4K có thể là 20MB;
 * trên đường truyền chậm nó chạy 3 phút mà vẫn hoàn toàn khoẻ mạnh. Đặt trần theo TỔNG thời gian
 * là giết đúng những người dùng mạng yếu — đúng cái bẫy W2.5 đã tránh bằng watchdog nhịp tim.
 */
// 15s: header chỉ vài trăm byte nên đây thuần tuý là độ trễ — 15s không phản hồi = server chết,
// KHÔNG phải "mạng chậm" (mạng chậm ảnh hưởng lúc tải body, chỗ đó có đồng hồ im-lặng riêng).
// Số học tổng: 4 lượt x 15s + backoff (0.5+1+2) = ~63s là user thấy lỗi, thay vì treo vô hạn.
export const HEADERS_TIMEOUT_MS = 15_000;

/**
 * Trần IM LẶNG giữa chừng: bao lâu KHÔNG nhận thêm byte nào thì coi là chết.
 *
 * Nhịp tim reset mỗi mảnh byte -> tải chậm-mà-đang-chảy không bao giờ bị cắt oan; chỉ kết nối
 * ĐỨNG IM mới bị ngắt. Đây là điểm khác then chốt so với `AbortSignal.timeout` thuần.
 */
export const STALL_TIMEOUT_MS = 30_000;

/** Số lần thử LẠI (tổng số lượt = retries + 1). */
export const DEFAULT_RETRIES = 3;

/** Backoff mũ: 500ms, 1s, 2s… có trần để lần cuối không bắt user chờ vô lý. */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 8_000;

/**
 * Mã HTTP mà thử lại là VÔ NGHĨA — server đã trả lời dứt khoát, lần sau y hệt.
 *
 * VDH fail-fast ở 404/416; ta mở rộng thêm 401/403/410 vì đó là bộ mã của HLS thực tế:
 * URL ký hết hạn trả 403 và sẽ **không bao giờ** hồi phục — thử lại 4 lần chỉ làm CDN coi ta như
 * kẻ dò quét (rủi ro nâng từ throttle mềm lên ban IP cứng, §2.9).
 */
export function isFatalHttpStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 410 ||
    status === 416
  );
}

/** Chờ bao lâu TRƯỚC lượt thử thứ `attempt` (attempt 0 = lượt đầu, không chờ). */
export function backoffDelayMs(
  attempt: number,
  base = BACKOFF_BASE_MS,
  max = BACKOFF_MAX_MS,
): number {
  if (attempt <= 0) return 0;
  return Math.min(base * Math.pow(2, attempt - 1), max);
}

/**
 * `setTimeout` HUỶ ĐƯỢC. Bấm Huỷ trong lúc đang backoff phải dừng NGAY, không bắt user ngồi hết
 * 8 giây rồi mới thấy phản hồi.
 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError('Đã huỷ'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new CancelledError('Đã huỷ'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Ghép signal huỷ của job với timeout của MỘT lượt thử.
 *
 * `AbortSignal.any` có từ Chrome 116; extension nhắm MV3 (Chrome 110+) nên vẫn phải có đường lùi —
 * và đường lùi PHẢI gỡ listener, không thì mỗi segment rò một listener trên signal sống suốt job
 * (hàng trăm segment = hàng trăm listener trên cùng một signal).
 */
export function linkSignals(
  primary: AbortSignal,
  jobSignal?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  if (!jobSignal) return { signal: primary, dispose: () => undefined };
  // ⚠️ Signal ĐÃ abort TRƯỚC khi vào đây: `addEventListener('abort')` sẽ KHÔNG BAO GIỜ bắn nữa
  // (sự kiện đã qua) -> nhánh dự phòng trả về một signal chết, huỷ mất tác dụng hoàn toàn.
  // Phải kiểm tường minh. (AbortSignal.any xử đúng ca này sẵn; chỉ nhánh lùi mới thủng.)
  if (primary.aborted || jobSignal.aborted) {
    const ac = new AbortController();
    ac.abort(primary.aborted ? primary.reason : jobSignal.reason);
    return { signal: ac.signal, dispose: () => undefined };
  }
  if (typeof AbortSignal.any === 'function') {
    return {
      signal: AbortSignal.any([primary, jobSignal]),
      dispose: () => undefined,
    };
  }
  const ac = new AbortController();
  const onPrimary = (): void => ac.abort(primary.reason);
  const onJob = (): void => ac.abort(jobSignal.reason);
  primary.addEventListener('abort', onPrimary, { once: true });
  jobSignal.addEventListener('abort', onJob, { once: true });
  return {
    signal: ac.signal,
    dispose: () => {
      primary.removeEventListener('abort', onPrimary);
      jobSignal.removeEventListener('abort', onJob);
    },
  };
}

/** Ghép timeout tổng với signal huỷ của job — dùng cho playlist (vài KB, trần tổng là hợp lý). */
export function timeoutSignal(
  timeoutMs: number,
  jobSignal?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  return linkSignals(AbortSignal.timeout(timeoutMs), jobSignal);
}

export interface ByteRange {
  offset: number;
  length: number;
}

export interface FetchRetryOptions {
  retries?: number;
  range?: ByteRange;
  /** Signal huỷ của JOB (không phải timeout) — abort = huỷ hẳn, không thử lại. */
  signal?: AbortSignal;
  /** Trần chờ header. */
  timeoutMs?: number;
  /** Trần im lặng giữa chừng khi đang đọc body. */
  stallMs?: number;
  /** Tiêm để test; mặc định `fetch` toàn cục. */
  fetchFn?: typeof fetch;
  /** Tiêm để test; mặc định `abortableSleep`. */
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Tên thứ đang tải ("segment #12", "khoá AES", "init") — để thông báo lỗi nói được cái gì hỏng. */
  label?: string;
  /** Báo một lượt thử vừa hỏng và sắp thử lại — để UI không đứng hình câm suốt ~1 phút. */
  onRetry?: (info: { attempt: number; total: number; reason: string }) => void;
}

/** Dịch mã fail-fast sang tiếng người, kèm thứ đang tải. */
function explainFatalStatus(status: number, label?: string): string {
  const what = label ? `${label}: ` : '';
  if (status === 403 || status === 401) {
    return `${what}máy chủ từ chối (HTTP ${status}) — link có thể đã hết hạn hoặc site chặn tải`;
  }
  if (status === 404 || status === 410) {
    return `${what}không còn tồn tại trên máy chủ (HTTP ${status})`;
  }
  if (status === 416) {
    return `${what}máy chủ không chấp nhận dải byte đã xin (HTTP 416)`;
  }
  return `${what}HTTP ${status}`;
}

/**
 * Đọc body với NHỊP TIM: mỗi mảnh byte về là reset đồng hồ im lặng. Đứng im quá `stallMs` ->
 * abort lượt thử này (retry sẽ lo phần còn lại).
 *
 * Không có `res.body` (một số môi trường/response rỗng) -> lùi về `arrayBuffer()`, lúc đó đồng hồ
 * im lặng vẫn đang chạy từ khi nhận header nên vẫn không treo vĩnh viễn.
 */
async function readWithStallGuard(
  res: Response,
  resetStall: () => void,
): Promise<ArrayBuffer> {
  if (!res.body) return await res.arrayBuffer();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    resetStall(); // <- byte về = còn sống
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out.buffer;
}

/**
 * Tải một segment với retry TỬ TẾ (W2.6): timeout mỗi lượt, backoff mũ huỷ được, fail-fast mã
 * không cứu được, và huỷ giật request đang bay ra ngay.
 *
 * `range` có mặt (W1.3) -> gửi header `Range` thay vì tải nguyên file.
 */
export async function fetchWithRetry(
  url: string,
  opts: FetchRetryOptions = {},
): Promise<ArrayBuffer> {
  const {
    retries = DEFAULT_RETRIES,
    range,
    signal,
    timeoutMs = HEADERS_TIMEOUT_MS,
    stallMs = STALL_TIMEOUT_MS,
    fetchFn = fetch,
    sleepFn = abortableSleep,
    label,
    onRetry,
  } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new CancelledError('Đã huỷ');
    if (attempt > 0) {
      // Báo TRƯỚC khi ngủ: user đang nhìn một thanh tiến trình đứng im, phải cho họ biết máy
      // đang thử lại chứ không phải đã chết (§1.7 — spinner câm là kết cục tệ nhất).
      onRetry?.({
        attempt,
        total: retries + 1,
        reason: describeRetryError(lastErr),
      });
      await sleepFn(backoffDelayMs(attempt), signal);
    }

    // Controller RIÊNG mỗi lượt: đồng hồ (header/im lặng) abort đúng lượt này, còn signal của job
    // abort tất cả. Ghép hai đường vào một signal đưa cho fetch.
    const attemptAc = new AbortController();
    const { signal: attemptSignal, dispose } = linkSignals(
      attemptAc.signal,
      signal,
    );
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      attemptAc.abort(new DOMException('timeout', 'TimeoutError'));
    }, timeoutMs);
    const resetStall = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        attemptAc.abort(new DOMException('timeout', 'TimeoutError'));
      }, stallMs);
    };
    try {
      const res = await fetchFn(url, {
        credentials: 'include',
        signal: attemptSignal,
        // Một 403 bị HTTP cache giữ lại sẽ được PHÁT LẠI y nguyên ở mọi lượt thử (và ở lần tải
        // sau khi rule spoof đã bật) -> retry thành nghi lễ vô nghĩa. Đi thẳng ra mạng.
        cache: 'reload',
        ...(range
          ? {
              // HTTP Range là ĐÓNG hai đầu: byte cuối = offset + length - 1.
              headers: {
                Range: `bytes=${range.offset}-${range.offset + range.length - 1}`,
              },
            }
          : {}),
      });
      resetStall(); // header đã về -> chuyển từ đồng hồ chờ-header sang đồng hồ im-lặng
      if (!res.ok) {
        if (isFatalHttpStatus(res.status)) {
          // Fail-fast THOÁT NGAY, không đi qua wrapper "sau N lần thử" ở cuối hàm -> nếu chỉ ném
          // "HTTP 403" thì user đọc được đúng ba chữ đó và không biết cái gì bị chặn.
          throw new FatalFetchError(explainFatalStatus(res.status, label));
        }
        throw new Error(`HTTP ${res.status}`);
      }
      // ⚠️ BẪY W1.3: server PHỚT LỜ Range trả 200 + TOÀN BỘ file. Ghi cả file vào chỗ của một
      // segment = file ra hỏng mà im lặng. Và vì playlist byterange cho cả trăm segment trỏ CÙNG
      // một file, âm thầm chấp nhận còn nghĩa là tải nguyên file đó cả trăm lần (đo thật trên
      // Apple fMP4: 27MB x 101 = ~2.8GB). Thà FAIL LỚN TIẾNG.
      if (range && res.status !== 206) {
        throw new FatalFetchError(
          `máy chủ không hỗ trợ tải theo đoạn (Range): trả HTTP ${res.status} thay vì 206`,
        );
      }
      const buf = await readWithStallGuard(res, resetStall);
      // ⚠️ RFC 7233 CHO PHÉP server/proxy trả 206 NGẮN HƠN dải đã xin. Nhận bừa = segment cụt,
      // ghép ra file thiếu byte mà job vẫn báo 'done' — đúng lớp lỗi câm mà W2.5 vừa phải vá ở
      // đường progressive. Thà FAIL LỚN TIẾNG (đối xứng với guard 200-thay-vì-206 ở trên).
      if (range && buf.byteLength !== range.length) {
        throw new Error(
          `máy chủ trả thiếu byte cho đoạn đã xin: nhận ${buf.byteLength}, cần ${range.length}`,
        );
      }
      return buf;
    } catch (e) {
      // Huỷ job: KHÔNG phải lỗi mạng, dừng ngay, đừng đốt thêm 3 lượt thử.
      if (e instanceof CancelledError) throw e;
      if (signal?.aborted) throw new CancelledError('Đã huỷ');
      // Thử lại vô nghĩa: server sẽ lại phớt lờ Range / lại trả đúng mã đó.
      if (e instanceof FatalFetchError) throw e;
      lastErr = e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      // Mọi đường THOÁT-VÌ-LỖI đều bỏ lại một response chưa đọc hết: không abort thì socket còn
      // treo và byte vẫn chảy về (vô ích) trong khi ta đã đi thử lượt khác. Abort sau khi đã
      // return thành công là vô hại — request lúc đó đã hoàn tất.
      attemptAc.abort();
      dispose();
    }
  }
  throw new Error(
    `Tải ${label ?? 'segment'} lỗi sau ${retries + 1} lần thử: ${describeRetryError(lastErr)}`,
  );
}

/** Mô tả lỗi cuối cùng — timeout của AbortSignal.timeout ném TimeoutError, cần nói cho ra tiếng người. */
function describeRetryError(e: unknown): string {
  // KHÔNG nêu một con số cụ thể ở đây: có HAI đồng hồ (chờ-header 15s, im-lặng 30s) và hàm này
  // không biết cái nào vừa bắn. In bừa một số là nói dối user (đã đo: e2e in "quá hạn 30s" trong
  // khi thứ hết giờ là đồng hồ 15s).
  if (e instanceof DOMException && e.name === 'TimeoutError') {
    return 'máy chủ không phản hồi (quá hạn)';
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
