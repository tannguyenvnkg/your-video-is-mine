// Xử lý timestamp khi remux MPEG-TS -> MP4 bằng libav.js. LOGIC THUẦN, không đụng wasm/chrome.
//
// Ba rủi ro hỏng-ngầm mà file này tồn tại để chặn:
//   (i)   PTS thô của MPEG-TS lọt thẳng ra output -> start_time 80000 s trong khi duration 12 s.
//   (ii)  So sánh/sắp xếp trên .dts (word thấp 32-bit CÓ DẤU) -> đảo thứ tự khi vượt 2^31.
//   (iii) #EXT-X-DISCONTINUITY (chèn quảng cáo) -> libavformat KHÔNG tự vá; file ra 9 giờ.
//
// Mọi con số trong file này đều đã ĐO, xem remux-time.test.ts.

/* ────────────────────────── 1. Biểu diễn 64-bit của libav.js ────────────────────────── */

/**
 * libav.js phơi mỗi int64 thành CẶP số 32-bit: `pts`/`ptshi`, `dts`/`dtshi`.
 * Macro C sinh ra chúng (bindings.c) là:
 *     uint32_t X(a)   { return (uint32_t)(a->field);       }   // word THẤP
 *     uint32_t Xhi(a) { return (uint32_t)(a->field >> 32); }   // word CAO (dịch số học)
 * Emscripten trả i32 về JS theo kiểu CÓ DẤU, nên CẢ HAI word đọc ra là int32 có dấu.
 * ĐO ĐƯỢC: ghi 0xFFFFFFFF vào word thấp -> JS đọc lại -1.
 *
 * => Giá trị thật = hi * 2^32 + (lo ĐỌC KHÔNG DẤU).
 */
export const TWO_POW_32 = 4294967296;

/** AV_NOPTS_VALUE = INT64_MIN, tách ra thành cặp (lo, hi). ĐO ĐƯỢC: lo=0, hi=-2147483648. */
export const NOPTS_LO = 0;
export const NOPTS_HI = -2147483648;

/** Ngưỡng an toàn của Number: trên mức này phép cộng mất chính xác. */
export const MAX_EXACT = Number.MAX_SAFE_INTEGER; // 2^53 - 1

/** Cặp (lo, hi) có phải AV_NOPTS_VALUE không. */
export function isNoPts(lo: number, hi: number): boolean {
  return lo === NOPTS_LO && hi === NOPTS_HI;
}

/**
 * Ghép cặp (lo, hi) của libav.js thành một Number CHÍNH XÁC.
 *
 * `lo >>> 0` là mấu chốt: nó đọc word thấp KHÔNG DẤU. Viết `hi * 2^32 + lo`
 * (dùng thẳng lo có dấu) sai 6/15 trường hợp đã đo — đó chính là defect (ii).
 *
 * Chính xác tuyệt đối khi |giá trị| < 2^53. Timestamp MPEG-TS tối đa 2^33 nên luôn an toàn.
 */
export function i64ToNumber(lo: number, hi: number): number {
  return hi * TWO_POW_32 + (lo >>> 0);
}

/** Bản BigInt cho trường hợp cần chính xác quá 2^53 (không dùng trong đường chính). */
export function i64ToBigInt(lo: number, hi: number): bigint {
  return (BigInt(hi) << 32n) | BigInt(lo >>> 0);
}

/** Tách Number ngược lại thành cặp (lo, hi) để ghi vào AVPacket. */
export function numberToI64(v: number): { lo: number; hi: number } {
  const hi = Math.floor(v / TWO_POW_32);
  const lo = v - hi * TWO_POW_32; // luôn trong [0, 2^32)
  return { lo: lo | 0, hi: hi | 0 };
}

/**
 * Đọc pts/dts từ một packet libav.js. Trả null khi là AV_NOPTS_VALUE.
 * Nhận `unknown`-ish shape để dùng được với Packet của libav.js mà không cần import type.
 */
export interface RawPacketTs {
  pts?: number;
  ptshi?: number;
  dts?: number;
  dtshi?: number;
}

export function readPts(p: RawPacketTs): number | null {
  const lo = p.pts ?? 0;
  const hi = p.ptshi ?? 0;
  return isNoPts(lo, hi) ? null : i64ToNumber(lo, hi);
}

export function readDts(p: RawPacketTs): number | null {
  const lo = p.dts ?? 0;
  const hi = p.dtshi ?? 0;
  return isNoPts(lo, hi) ? null : i64ToNumber(lo, hi);
}

/* ────────────────────────── 2. Đổi timebase ────────────────────────── */

/** Timebase nội bộ dùng để so sánh giữa các stream (giống AV_TIME_BASE của ffmpeg: micro giây). */
export const TIME_BASE_US = 1_000_000;

export interface TimeBase {
  num: number;
  den: number;
}

/**
 * Đổi timestamp giữa hai timebase, làm tròn nửa-ra-xa-số-0 (giống av_rescale_q mặc định).
 * v * (fromNum/fromDen) / (toNum/toDen)
 */
export function rescaleTs(v: number, from: TimeBase, to: TimeBase): number {
  const r = (v * from.num * to.den) / (from.den * to.num);
  return r < 0 ? -Math.round(-r) : Math.round(r);
}

/** Đổi từ timebase của stream sang micro giây. */
export function toMicros(v: number, tb: TimeBase): number {
  return rescaleTs(v, tb, { num: 1, den: TIME_BASE_US });
}

/** Đổi từ micro giây về timebase của stream. */
export function fromMicros(v: number, tb: TimeBase): number {
  return rescaleTs(v, { num: 1, den: TIME_BASE_US }, tb);
}

/* ────────────────────────── 3. So sánh / sắp xếp packet ────────────────────────── */

export interface TimedPacket {
  streamIndex: number;
  /** Đã ghép 64-bit, theo timebase của stream. null = AV_NOPTS_VALUE. */
  pts: number | null;
  dts: number | null;
  /** Thời lượng theo timebase của stream (0 nếu không biết). */
  duration: number;
  timeBase: TimeBase;
  /**
   * Input nào (ca HLS/DASH có rendition tiếng RIÊNG => hai AVFormatContext, mà CẢ HAI
   * đều có `streamIndex 0`). Thiếu trường này thì hai stream khác input đụng danh tính nhau.
   * Bỏ trống = 0 (một input duy nhất).
   */
  inputIndex?: number;
  /**
   * Loại nội dung. CHỈ dùng để chọn stream CHÍNH cho việc dò seam — xem `pickPrimaryKey`.
   * Bỏ trống thì rơi về quy tắc "streamIndex nhỏ nhất".
   */
  mediaType?: 'video' | 'audio' | 'other';
}

/** Danh tính duy nhất của một stream, có tính cả input. */
export function streamKey(p: {
  inputIndex?: number;
  streamIndex: number;
}): string {
  return `${p.inputIndex ?? 0}:${p.streamIndex}`;
}

/**
 * So sánh hai packet để ghi ra muxer theo thứ tự DTS không giảm.
 *
 * PHẢI so trên giá trị 64-bit đã ghép và PHẢI quy về cùng timebase.
 * Bản cũ so trực tiếp `a.dts - b.dts` (word thấp) -> đảo thứ tự khi vượt 2^31.
 * Hoà thì giữ nguyên theo streamIndex cho ổn định (deterministic).
 */
export function comparePackets(a: TimedPacket, b: TimedPacket): number {
  const ad = a.dts ?? a.pts;
  const bd = b.dts ?? b.pts;
  if (ad === null || ad === undefined)
    return bd === null || bd === undefined ? 0 : -1;
  if (bd === null || bd === undefined) return 1;
  const au = toMicros(ad, a.timeBase);
  const bu = toMicros(bd, b.timeBase);
  if (au !== bu) return au < bu ? -1 : 1;
  return a.streamIndex - b.streamIndex;
}

/** Đếm số lần DTS đi lùi trong một chuỗi packet của CÙNG một stream. Dùng để kiểm chứng. */
export function countDtsInversions(packets: readonly TimedPacket[]): number {
  let n = 0;
  let prev: number | null = null;
  for (const p of packets) {
    const d = p.dts ?? p.pts;
    if (d === null || d === undefined) continue;
    if (prev !== null && d < prev) n++;
    prev = d;
  }
  return n;
}

/* ────────────────────────── 4. Vá điểm gián đoạn (discontinuity) ────────────────────────── */

/**
 * ĐO ĐƯỢC: libavformat KHÔNG vá #EXT-X-DISCONTINUITY. Chính ffmpeg CLI (fftools/ffmpeg_demux.c)
 * mới làm, và nó KHÔNG nằm trong thư viện ta gọi. Không tự làm thì file 12 giây ra 9,26 giờ.
 *
 * Quy tắc của ffmpeg, ta chép lại nguyên:
 *   - Chỉ áp cho format có cờ AVFMT_TS_DISCONT (mpegts có).
 *   - delta = dts_hiện_tại - dts_kỳ_vọng, với dts_kỳ_vọng = dts_trước + duration_trước.
 *     Dùng "dts + duration" chứ KHÔNG phải "dts trước" — nếu không, delta sẽ dính thêm
 *     khoảng cách tự nhiên giữa hai packet (ĐO: 3000003030 thay vì 3000000000).
 *   - |delta| > ngưỡng (mặc định 10 s) -> cộng dồn -delta vào MỘT offset TOÀN CỤC.
 *
 * Offset là TOÀN CỤC (một con số cho mọi stream), không phải mỗi stream một offset.
 * Đây chính là điều giữ được đồng bộ A/V: hai stream dịch y hệt nhau. Stream nào phát hiện
 * seam trước thì quyết định offset; stream còn lại ăn theo.
 */
export const DEFAULT_DTS_DELTA_THRESHOLD_SEC = 10;

/**
 * Một khoảng lệch so với mốc kỳ vọng có phải gián đoạn không.
 *
 * 🔴 KHÔNG ĐỐI XỨNG, và đây là điểm mấu chốt — đừng "dọn dẹp" thành `Math.abs(delta) > ngưỡng`:
 *
 * - **Nhảy TỚI (delta > 0)**: phải vượt ngưỡng. Khoảng hở tiến là chuyện BÌNH THƯỜNG của nội
 *   dung hợp lệ (khoảng lặng audio, timelapse, GOP dài). Bắt sát quá là báo động OAN, mà luật
 *   dự án nói rõ: giết oan một lượt tải khoẻ TỆ HƠN cái treo.
 * - **Nhảy LÙI (delta < 0)**: LUÔN là gián đoạn, bất kể lớn nhỏ. Trong MỘT stream, DTS theo
 *   đặc tả là không-giảm (đúng cả với B-frame — B-frame làm PTS đảo, KHÔNG làm DTS đảo).
 *   Nên một cú lùi bất kỳ nghĩa là nguồn đã reset đồng hồ.
 *
 * ĐO ĐƯỢC vì sao phải tách hai chiều: một đoạn quảng cáo reset PTS về 0 mà chỉ lùi 3,56s
 * (dưới ngưỡng 10s) thì bản đối xứng KHÔNG coi là seam -> kẹp đơn điệu sau đó nén 90 packet
 * vào ~1ms, span giữ nguyên 3,56s thay vì 7,12s. Không đảo DTS, không lỗi, nội dung mất sạch.
 * Đúng chữ ký hỏng-im-lặng.
 */
export function isSeamDelta(deltaUs: number, thresholdUs: number): boolean {
  return deltaUs < 0 || deltaUs > thresholdUs;
}

/**
 * Một điểm gián đoạn trên TRỤC THỜI GIAN THÔ (chưa hiệu chỉnh).
 * Khoá theo vị trí thô chứ không theo stream — nhờ vậy hai stream cùng đi qua một seam
 * chỉ sinh ra MỘT hiệu chỉnh, và thứ tự nạp packet không còn quan trọng.
 */
export interface Seam {
  /** DTS thô (µs) của packet đầu tiên SAU seam, do stream phát hiện đầu tiên chốt. */
  atRawUs: number;
  /** Độ lớn cú nhảy (µs). Dương = nhảy tới. */
  deltaUs: number;
  /** Stream đã chốt seam này (chỉ để chẩn đoán). */
  detectedBy: number;
}

/**
 * ⚠️ BẪY ĐÃ ĐO ĐƯỢC: `ff_read_frame_multi` trả packet GOM THEO STREAM, KHÔNG theo thứ tự demux.
 * Bản đầu của thiết kế này giữ một offset chạy dần theo thứ tự nạp; hệ quả là video vá seam
 * xong, rồi audio chạy lại chuỗi của nó từ đầu và vá LẠI CHÍNH seam đó
 * -> offset -66666666678 µs thay vì -33333333334 µs, đúng gấp đôi, và output lệch 33333 s.
 *
 * Nên seam được khoá theo VỊ TRÍ THÔ. Stream nào tới trước thì chốt `deltaUs`; stream sau
 * nhận diện đúng seam đó (vị trí lệch nhau chưa tới ngưỡng) và DÙNG LẠI, không cộng thêm.
 * Đây cũng chính là hành vi của ffmpeg: nó chỉ ghi log discontinuity MỘT lần.
 */
export function isSameSeam(a: Seam, b: Seam, thresholdUs: number): boolean {
  return Math.abs(a.atRawUs - b.atRawUs) <= thresholdUs;
}

/**
 * Quét seam trên MỘT stream. `packets` phải theo thứ tự DTS tăng dần của chính stream đó
 * (đúng như libav trả về cho từng stream).
 *
 * Kỳ vọng = dts_trước + duration_trước. Dùng "dts + duration" chứ KHÔNG phải "dts trước":
 * ĐO ĐƯỢC, nếu bỏ duration thì delta dính thêm khoảng cách tự nhiên giữa hai packet
 * (3000003030 thay vì 3000000000 — lệch 3030 tick = 33,7 ms).
 */
export function detectSeams(
  packets: readonly TimedPacket[],
  thresholdSec: number = DEFAULT_DTS_DELTA_THRESHOLD_SEC,
): Seam[] {
  // Đi qua ĐÚNG máy trạng thái mà bản quét-theo-luồng dùng. Cố ý không viết lại vòng lặp
  // riêng ở đây: sáng 2026-07-19 đã ĐO ra hậu quả của việc hai bản đi hai đường — bản mảng
  // được vá ba lỗi (FP-4, min-first-PTS, đụng inputIndex) còn bản luồng thì KHÔNG, mà bản
  // luồng mới là bản chạy thật. Một máy trạng thái duy nhất thì không thể lệch nhau nữa.
  const d = createStreamDetector(0, 0, undefined, thresholdSec * TIME_BASE_US);
  for (const p of packets) feedDetector(d, p);
  return finishDetector(d);
}

/* ─────────── Máy trạng thái dò seam cho MỘT stream (dùng chung cho cả hai bản) ─────────── */

/** Số khoảng cách quan sát cần có để chốt "nhịp" thật của stream. */
const SPACING_SAMPLES = 64;
/**
 * Dưới bấy nhiêu mẫu thì KHÔNG được tin trung vị — giữ nguyên hành vi cũ (tin `duration`).
 *
 * 🔴 ĐO ĐƯỢC khi vá lỗi VFR: với 2 mẫu mà một trong hai chính là CÚ NHẢY CỦA SEAM, trung vị
 * bị chính seam kéo lệch -> `duration` khai báo bị coi là "sai" -> mốc kỳ vọng nhảy vọt ->
 * SINH THÊM seam giả ngay ở packet thứ hai. Bốn test đang xanh đã đỏ vì đúng chỗ này.
 * Trung vị chỉ chống nhiễu được khi phần tử lạ là thiểu số.
 */
const MIN_SPACING_SAMPLES = 8;
/** Lệch quá bấy nhiêu lần thì KHÔNG tin `duration` khai báo nữa, tin nhịp quan sát được. */
const SPACING_DISAGREE_FACTOR = 2;

interface SeamCandidate {
  atRawUs: number;
  prevRawUs: number;
  prevDurUs: number;
  detectedBy: number;
}

interface StreamDetector {
  streamIndex: number;
  inputIndex: number;
  mediaType?: 'video' | 'audio' | 'other';
  thresholdUs: number;
  prevRawUs: number | null;
  prevDurUs: number;
  /** Khoảng cách DTS quan sát được (µs), tối đa SPACING_SAMPLES cái đầu. */
  deltas: number[];
  /** Trung vị đã chốt của `deltas`. null = chưa đủ mẫu. */
  spacingUs: number | null;
  /** Ứng viên seam chờ chốt nhịp. Có trần (≤ SPACING_SAMPLES) nên bộ nhớ vẫn O(1). */
  pending: SeamCandidate[];
  seams: Seam[];
  firstPtsUs: number | null;
}

function createStreamDetector(
  streamIndex: number,
  inputIndex: number,
  mediaType: 'video' | 'audio' | 'other' | undefined,
  thresholdUs: number,
): StreamDetector {
  return {
    streamIndex,
    inputIndex,
    ...(mediaType !== undefined ? { mediaType } : {}),
    thresholdUs,
    prevRawUs: null,
    prevDurUs: 0,
    deltas: [],
    spacingUs: null,
    pending: [],
    seams: [],
    firstPtsUs: null,
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Chốt một ứng viên: có thật là gián đoạn không?
 *
 * 🔴 ĐÂY LÀ CHỖ VÁ LỖI VFR/TIMELAPSE (đo 2026-07-19, phản biện đối kháng bắt được):
 * một stream mà khung cách nhau THẬT 15 giây nhưng demuxer khai `r_frame_rate=25/1`
 * -> `duration` mỗi packet = 0,04 s. Lấy `expected = dts + 0,04s` thì MỌI packet đều lệch
 * 14,96 s, vượt ngưỡng 10 s -> **11 seam GIẢ trên 12 packet**, và sau khi "hiệu chỉnh" thì
 * 165 giây nội dung còn **0,44 giây**. File vẫn đủ 12 khung, vẫn decode sạch, `av_write_trailer`
 * vẫn trả 0 — không một tín hiệu nào. Đúng chữ ký hỏng-im-lặng của dự án này.
 *
 * Vá bằng cách hỏi thêm một câu: cú nhảy này có BẤT THƯỜNG so với chính stream đó không?
 * Gián đoạn thật (chèn quảng cáo) là chuyện HIẾM và LẺ; còn `duration` khai sai thì lệch
 * ĐỀU ĐỀU ở mọi packet. Nên khi `duration` khai báo lệch quá 2 lần so với nhịp quan sát
 * được, ta tin nhịp quan sát.
 *
 * Đánh đổi có chủ ý: một seam thật NHỎ hơn nhịp + ngưỡng sẽ bị bỏ sót. Bỏ sót seam = giữ
 * nguyên khoảng hở, file dài hơn thực tế — khó chịu nhưng NỘI DUNG CÒN ĐỦ. Báo động oan =
 * nội dung bị nén mất. Luật dự án: giết oan một lượt tải khoẻ tệ hơn cái treo.
 */
function evaluateCandidate(d: StreamDetector, c: SeamCandidate): void {
  let effDurUs = c.prevDurUs;
  const sp = d.spacingUs;
  if (
    sp !== null &&
    sp > 0 &&
    (effDurUs > sp * SPACING_DISAGREE_FACTOR ||
      effDurUs * SPACING_DISAGREE_FACTOR < sp)
  ) {
    effDurUs = sp;
  }
  const deltaUs = c.atRawUs - (c.prevRawUs + effDurUs);
  if (isSeamDelta(deltaUs, d.thresholdUs)) {
    d.seams.push({
      atRawUs: c.atRawUs,
      deltaUs,
      detectedBy: c.detectedBy,
    });
  }
}

function freezeSpacing(d: StreamDetector): void {
  if (d.spacingUs !== null) return;
  d.spacingUs =
    d.deltas.length >= MIN_SPACING_SAMPLES ? (median(d.deltas) ?? 0) : 0;
  for (const c of d.pending) evaluateCandidate(d, c);
  d.pending = [];
}

function feedDetector(d: StreamDetector, p: TimedPacket): void {
  const t = p.dts ?? p.pts;
  if (t === null || t === undefined) return;

  if (d.firstPtsUs === null) {
    const first = p.pts ?? p.dts;
    if (first !== null && first !== undefined) {
      d.firstPtsUs = toMicros(first, p.timeBase);
    }
  }

  // 🔴 BÁO ĐỘNG OAN — ĐO ĐƯỢC, luật dự án: giết oan một lượt tải khoẻ TỆ HƠN cái treo.
  // Packet không biết thời lượng thì KHÔNG suy ra được "mốc kỳ vọng", nên không có cơ sở
  // nào để gọi là gián đoạn. Bản cũ rơi về `expected = dts` và hậu quả đã đo:
  //   - luồng timed-ID3 (rất phổ biến trong HLS thật, 1 packet duration=0 mỗi segment,
  //     segment 12s > ngưỡng 10s) -> 9 seam GIẢ, seam nào cũng dịch toàn cục;
  //   - timelapse 1 khung/15s mà demuxer trả duration=0 -> 11 seam GIẢ.
  // Bỏ qua hẳn packet như vậy: không dò, và cũng KHÔNG cập nhật kỳ vọng.
  if (p.duration <= 0) return;

  const rawUs = toMicros(t, p.timeBase);
  const durUs = toMicros(p.duration, p.timeBase);

  if (d.prevRawUs !== null) {
    const observed = rawUs - d.prevRawUs;
    if (observed > 0 && d.deltas.length < SPACING_SAMPLES)
      d.deltas.push(observed);
    const c: SeamCandidate = {
      atRawUs: rawUs,
      prevRawUs: d.prevRawUs,
      prevDurUs: d.prevDurUs,
      detectedBy: d.streamIndex,
    };
    if (d.spacingUs === null) d.pending.push(c);
    else evaluateCandidate(d, c);
    if (
      d.spacingUs === null &&
      (d.deltas.length >= SPACING_SAMPLES ||
        d.pending.length >= SPACING_SAMPLES)
    ) {
      freezeSpacing(d);
    }
  }

  d.prevRawUs = rawUs;
  d.prevDurUs = durUs;
}

function finishDetector(d: StreamDetector): Seam[] {
  freezeSpacing(d);
  return d.seams;
}

/**
 * Chọn stream CHÍNH — stream duy nhất được quyền chốt seam TOÀN CỤC.
 *
 * 🔴 ĐO ĐƯỢC (ca FP-4), lỗi tệ nhất nhóm báo-động-oan: một video KHOẺ, liên tục 59,96s,
 * đi kèm audio có **khoảng lặng 30 giây HỢP LỆ**. Bản cũ để audio chốt seam rồi áp cho
 * mọi stream -> **video còn 30,02s, mất đúng một nửa**, không một dòng lỗi.
 *
 * Gián đoạn thật (chèn quảng cáo) luôn cắt cả hình lẫn tiếng, nên nó LUÔN nhìn thấy được
 * trên video. Khoảng lặng chỉ-có-ở-audio thì gần như chắc chắn là nội dung hợp lệ.
 * => Chỉ video được quyền chốt. Không có video thì lấy stream chỉ số nhỏ nhất.
 */
export function pickPrimaryKey(
  perStream: readonly (readonly TimedPacket[])[],
): string | null {
  const heads = perStream
    .map((l) => l.find((p) => (p.dts ?? p.pts) !== null))
    .filter((p): p is TimedPacket => p !== undefined);
  return pickPrimaryOf(heads);
}

/**
 * Phần lõi của `pickPrimaryKey`, tách ra để bản QUÉT THEO LUỒNG dùng chung.
 *
 * 🔴 Dùng CHUNG là cố ý: bản luồng từng có luật chọn riêng (thực chất là KHÔNG có luật —
 * mọi stream đều được chốt seam) và vì thế mang nguyên lỗi FP-4 mà bản mảng đã vá.
 * Hai bản đi hai đường là cách lỗi đó sống sót. Đừng tách lại.
 */
function pickPrimaryOf(
  heads: readonly {
    inputIndex?: number;
    streamIndex: number;
    mediaType?: 'video' | 'audio' | 'other';
  }[],
): string | null {
  if (heads.length === 0) return null;
  const video = heads.filter((p) => p.mediaType === 'video');
  const pool = video.length > 0 ? video : heads;
  let best = pool[0]!;
  for (const p of pool) {
    if ((p.inputIndex ?? 0) < (best.inputIndex ?? 0)) best = p;
    else if (
      (p.inputIndex ?? 0) === (best.inputIndex ?? 0) &&
      p.streamIndex < best.streamIndex
    )
      best = p;
  }
  return streamKey(best);
}

/**
 * Gộp seam tìm thấy trên nhiều stream thành danh sách seam TOÀN CỤC.
 * Seam ở cùng vị trí thô (trong ngưỡng) là MỘT seam; giữ bản của stream tới trước
 * (mảng vào đã xếp theo thứ tự stream, video thường là stream 0 — trùng với ffmpeg).
 */
export function mergeSeams(
  perStream: readonly (readonly Seam[])[],
  thresholdSec: number = DEFAULT_DTS_DELTA_THRESHOLD_SEC,
): Seam[] {
  const thresholdUs = thresholdSec * TIME_BASE_US;
  const out: Seam[] = [];
  for (const list of perStream) {
    for (const s of list) {
      if (!out.some((e) => isSameSeam(e, s, thresholdUs))) out.push(s);
    }
  }
  out.sort((a, b) => a.atRawUs - b.atRawUs);
  return out;
}

/**
 * Tổng hiệu chỉnh (µs) áp cho một mốc thời gian THÔ.
 *
 * Một packet nằm SAU seam khi mốc thô của nó vượt trung điểm giữa vùng trước và vùng sau:
 * vùng trước quanh `atRawUs - deltaUs`, vùng sau từ `atRawUs`. Khoảng hở giữa hai vùng
 * chính là `deltaUs` (> ngưỡng 10 s), trong khi lệch A/V chỉ cỡ mili giây, nên trung điểm
 * phân tách chắc chắn cho MỌI stream — đó là điều giữ cho hai stream dịch y hệt nhau.
 */
export function correctionAtUs(rawUs: number, seams: readonly Seam[]): number {
  let corr = 0;
  for (const s of seams) {
    if (rawUs > s.atRawUs - s.deltaUs / 2) corr -= s.deltaUs;
  }
  return corr;
}

/** Dịch cả pts lẫn dts của packet đi `offsetUs` micro giây, giữ nguyên timebase. */
export function shiftPacket(pkt: TimedPacket, offsetUs: number): TimedPacket {
  if (offsetUs === 0) return pkt;
  const off = fromMicros(offsetUs, pkt.timeBase);
  return {
    ...pkt,
    pts: pkt.pts === null ? null : pkt.pts + off,
    dts: pkt.dts === null ? null : pkt.dts + off,
  };
}

/* ────────────────────────── 5. Kéo mốc thời gian về 0 ────────────────────────── */

/**
 * ĐO ĐƯỢC (ffmpeg 8.1, `-c copy`, 5 input khác nhau -> output giống hệt nhau):
 * ffmpeg dịch MỌI stream bằng MỘT offset duy nhất = DTS nhỏ nhất trên toàn bộ các stream,
 * tức `-avoid_negative_ts make_zero`. Nó KHÔNG kéo từng stream về 0 riêng lẻ.
 *
 * Vì DTS trong mỗi stream không giảm, DTS nhỏ nhất của stream = DTS của packet ĐẦU TIÊN.
 * Nên chỉ cần packet đầu của mỗi stream là tính được offset -> hợp với xử lý dạng luồng.
 *
 * Hệ quả (ĐO ĐƯỢC trên fixture chuẩn): audio bắt đầu ở 126000, video ở 128090.
 * offset = 126000. Ra: audio 0, video 2090 tick = 23,222 ms.
 * Chênh lệch A/V 2090 tick được BẢO TOÀN NGUYÊN VẸN ở mức packet.
 * (Trong file MP4 nó thành empty-edit trong elst, lượng tử hoá theo movie timescale 1000
 *  -> ghi được 23 ms; sai số 0,222 ms là của định dạng MP4, ffmpeg thật cũng y vậy.)
 */
export interface StreamStart {
  streamIndex: number;
  /** DTS (hoặc PTS nếu không có DTS) của packet đầu tiên, theo timebase của stream. */
  firstDts: number;
  timeBase: TimeBase;
}

/**
 * Offset (µs) cần CỘNG vào mọi timestamp để mốc nhỏ nhất về đúng 0.
 * Trả 0 khi không có stream nào -> không đổi gì.
 */
export function computeRebaseOffsetUs(starts: readonly StreamStart[]): number {
  let min: number | null = null;
  for (const s of starts) {
    const us = toMicros(s.firstDts, s.timeBase);
    if (min === null || us < min) min = us;
  }
  return min === null ? 0 : -min;
}

/* ────────────────────────── 6. Ghép lại thành một đường ống ────────────────────────── */

/**
 * Toàn bộ thông tin cần để chỉnh timestamp, tính XONG từ trước.
 *
 * Đường ống chạy HAI LƯỢT:
 *   Lượt 1 — demux, CHỈ giữ timestamp rồi vứt data, dựng `TimelinePlan`.
 *   Lượt 2 — demux lại, áp plan cho từng packet rồi đẩy thẳng sang muxer.
 *
 * Đổi một lần demux thêm để lấy bộ nhớ CÓ CHẶN TRÊN. Bản harness cũ giữ mọi packet
 * trong RAM để sắp xếp: ĐO ĐƯỢC Node RSS 2,52 GB với input 163 MB — không dùng được.
 *
 * ⚠️ Lượt 1 KHÔNG được giữ lại toàn bộ timestamp: ĐO ĐƯỢC 65 B/packet, phim 3 tiếng
 * (~790k packet) ≈ 49 MB. Dùng `SeamScanner` — cả `detectSeams` lẫn mốc-đầu đều là phép
 * FOLD, nên quét được theo luồng với bộ nhớ O(số seam), tức vài chục byte.
 * Bản nhận mảng bên dưới giữ lại để test cho gọn.
 *
 * Plan cũng là thứ nên log/telemetry: `seams.length` đối chiếu được với
 * `countDiscontinuities()` mà utils/hls.ts đã đếm từ playlist.
 */
export interface TimelinePlan {
  seams: Seam[];
  /** Offset kéo-về-0 (µs), áp SAU khi đã trừ seam. */
  rebaseOffsetUs: number;
}

/** Chỉ số thời gian tối thiểu cần cho lượt 1. */
export type TimestampOnly = TimedPacket;

/**
 * Dựng plan từ timestamp thô của lượt 1.
 * `perStream` xếp theo thứ tự stream index tăng dần (video thường là 0) để việc chốt
 * `deltaUs` của seam trùng với lựa chọn của ffmpeg.
 */
export function buildTimelinePlan(
  perStream: readonly (readonly TimestampOnly[])[],
  thresholdSec: number = DEFAULT_DTS_DELTA_THRESHOLD_SEC,
): TimelinePlan {
  // CHỈ stream chính được chốt seam toàn cục — xem `pickPrimaryKey`.
  const primary = pickPrimaryKey(perStream);
  const seams = mergeSeams(
    perStream
      .filter((list) => {
        const head = list.find((p) => (p.dts ?? p.pts) !== null);
        return head !== undefined && streamKey(head) === primary;
      })
      .map((list) => detectSeams(list, thresholdSec)),
    thresholdSec,
  );

  // 🔴 Mốc rebase lấy theo PTS đầu nhỏ nhất, KHÔNG phải DTS đầu nhỏ nhất.
  // Hai quy tắc chỉ trùng nhau khi pts == dts — mà mọi fixture đời đầu đều vậy, nên
  // lỗi này vô hình suốt. Có B-frame là lệch ngay. ĐO ĐƯỢC trên fixture bf.ts:
  //   vào: video pts=7200 dts=0 | audio pts=dts=5280
  //   ffmpeg -c copy -> offset -5280 tick (ffprobe format start_time = 0,058667
  //   = đúng PTS đầu của audio), tức nó lấy min PTS chứ không lấy min DTS (=0).
  const starts: StreamStart[] = [];
  for (const list of perStream) {
    for (const p of list) {
      const t = p.pts ?? p.dts;
      if (t === null || t === undefined) continue;
      const rawUs = toMicros(t, p.timeBase);
      starts.push({
        streamIndex: p.streamIndex,
        firstDts: rawUs + correctionAtUs(rawUs, seams),
        timeBase: { num: 1, den: TIME_BASE_US },
      });
      break;
    }
  }

  return { seams, rebaseOffsetUs: computeRebaseOffsetUs(starts) };
}

/* ──────────────── 6b. Áp plan theo LUỒNG — bản DUY NHẤT được dùng thật ──────────────── */

/**
 * 🔴 VÌ SAO PHẢI CÓ TRẠNG THÁI (và vì sao `applyPlan` thuần KHÔNG đủ):
 *
 * 1. **Seam LÙI.** Gián đoạn HLS thường gặp NHẤT là PTS reset về 0 (mỗi đoạn quảng cáo
 *    được mã hoá độc lập từ 0). Khi đó mốc thô TRƯỚC và SAU seam **trùng dải giá trị**
 *    (cùng là 0..10s), nên KHÔNG một hàm thuần theo-giá-trị nào phân biệt nổi.
 *    ĐO ĐƯỢC trên bản cũ: 70s nội dung ra file 120,04s. Phải bám theo THỨ TỰ, không theo giá trị.
 * 2. **Đơn điệu DTS.** Offset toàn cục do video chốt, mà biên segment audio không trùng
 *    biên video (khung AAC 21,3ms; đo: video 4,000s vs audio 4,032s), nên sau hiệu chỉnh
 *    audio CHỒNG LÊN CHÍNH NÓ — đo được 4 lần đảo, đúng một lần mỗi seam.
 *    `av_interleaved_write_frame()` **TỪ CHỐI** dts không đơn điệu ("non monotonically
 *    increasing dts") -> mux lỗi hoặc mất packet trong im lặng.
 *
 * Cả hai đều bắt buộc phải nhớ trạng thái theo TỪNG stream. Đây là lý do kiến trúc
 * "plan thuần, không phụ thuộc thứ tự" đã bị bỏ — nó không thể đúng.
 *
 * Cách dùng: mỗi stream nạp packet theo đúng thứ tự DTS của chính nó (đúng như
 * `ff_read_frame_multi` gom theo stream). Thứ tự GIỮA các stream không quan trọng.
 */
export interface Rebaser {
  plan: TimelinePlan;
  state: Map<
    string,
    { seamIdx: number; expectedUs: number | null; lastOutDts: number | null }
  >;
  thresholdUs: number;
}

export function createRebaser(
  plan: TimelinePlan,
  thresholdSec: number = DEFAULT_DTS_DELTA_THRESHOLD_SEC,
): Rebaser {
  return {
    plan,
    state: new Map(),
    thresholdUs: thresholdSec * TIME_BASE_US,
  };
}

/**
 * Áp hiệu chỉnh cho MỘT packet và trả bản đã dịch.
 *
 * Giữ nguyên hiệu pts-dts của chính packet đó (quan trọng với B-frame), và đảm bảo
 * DTS ra không bao giờ lùi so với packet trước của cùng stream.
 */
export function rebasePacket(rb: Rebaser, pkt: TimedPacket): TimedPacket {
  const d = pkt.dts ?? pkt.pts;
  if (d === null || d === undefined) return pkt;

  const key = streamKey(pkt);
  let st = rb.state.get(key);
  if (!st) {
    st = { seamIdx: 0, expectedUs: null, lastOutDts: null };
    rb.state.set(key, st);
  }

  const rawUs = toMicros(d, pkt.timeBase);

  // Bám seam theo THỨ TỰ: thấy một cú nhảy vượt ngưỡng thì coi như vừa bước qua seam
  // kế tiếp trong danh sách toàn cục, và dùng ĐỘ LỚN của seam toàn cục (do stream chính
  // chốt) — nhờ vậy mọi stream dịch y hệt nhau, đồng bộ A/V được giữ.
  if (
    st.expectedUs !== null &&
    isSeamDelta(rawUs - st.expectedUs, rb.thresholdUs) &&
    st.seamIdx < rb.plan.seams.length
  ) {
    st.seamIdx++;
  }

  let corrUs = 0;
  for (let i = 0; i < st.seamIdx; i++) corrUs -= rb.plan.seams[i]!.deltaUs;

  const shiftUs = corrUs + rb.plan.rebaseOffsetUs;
  const off = fromMicros(shiftUs, pkt.timeBase);

  let outDts = pkt.dts === null ? null : pkt.dts + off;
  let outPts = pkt.pts === null ? null : pkt.pts + off;

  // Kẹp đơn điệu. Bù thêm bao nhiêu cho dts thì bù đúng bấy nhiêu cho pts, để không
  // bao giờ phá vỡ quan hệ pts >= dts.
  if (outDts !== null && st.lastOutDts !== null && outDts <= st.lastOutDts) {
    const bump = st.lastOutDts + 1 - outDts;
    outDts += bump;
    if (outPts !== null) outPts += bump;
  }
  if (outDts !== null) st.lastOutDts = outDts;

  st.expectedUs =
    rawUs + (pkt.duration > 0 ? toMicros(pkt.duration, pkt.timeBase) : 0);

  return { ...pkt, pts: outPts, dts: outDts };
}

/**
 * Quét theo LUỒNG cho lượt 1: bộ nhớ O(số seam), không giữ timestamp nào.
 * Nạp packet của mỗi stream theo đúng thứ tự DTS của stream đó; thứ tự GIỮA các stream
 * không quan trọng (đúng như `ff_read_frame_multi` gom theo stream).
 */
export interface SeamScanner {
  /** Khoá theo `streamKey` (inputIndex:streamIndex) — KHÔNG theo streamIndex trần. */
  perStream: Map<string, StreamDetector>;
  thresholdSec: number;
}

export function createSeamScanner(
  thresholdSec: number = DEFAULT_DTS_DELTA_THRESHOLD_SEC,
): SeamScanner {
  return { perStream: new Map(), thresholdSec };
}

/** Nạp MỘT timestamp vào scanner. Không giữ lại gì ngoài seam (và bộ đệm nhịp có trần). */
export function scanTimestamp(sc: SeamScanner, pkt: TimedPacket): void {
  // 🔴 Khoá theo streamKey chứ KHÔNG theo `pkt.streamIndex`: ca tiếng tách rời có HAI
  // AVFormatContext và CẢ HAI đều đánh số stream từ 0. Khoá bằng số trần thì hình và tiếng
  // dồn vào cùng một ô, timestamp hai luồng xen kẽ nhau và sinh ra seam giả hàng loạt.
  const key = streamKey(pkt);
  let s = sc.perStream.get(key);
  if (!s) {
    s = createStreamDetector(
      pkt.streamIndex,
      pkt.inputIndex ?? 0,
      pkt.mediaType,
      sc.thresholdSec * TIME_BASE_US,
    );
    sc.perStream.set(key, s);
  }
  feedDetector(s, pkt);
}

/** Chốt plan sau khi đã nạp hết lượt 1. */
export function finishScan(sc: SeamScanner): TimelinePlan {
  const entries = [...sc.perStream.values()].sort(
    (a, b) => a.inputIndex - b.inputIndex || a.streamIndex - b.streamIndex,
  );
  for (const e of entries) finishDetector(e);
  // 🔴 CHỈ stream chính được chốt seam toàn cục — y hệt `buildTimelinePlan`.
  // Để mọi stream cùng chốt là lỗi FP-4: một video KHOẺ đi kèm audio có khoảng lặng 30 giây
  // HỢP LỆ thì audio sinh seam giả, và video bị cắt còn đúng một nửa, không một dòng lỗi.
  const primary = pickPrimaryOf(entries);
  const seams = mergeSeams(
    entries.filter((e) => streamKey(e) === primary).map((e) => e.seams),
    sc.thresholdSec,
  );
  // Mốc rebase gom TOÀN BỘ stream của TOÀN BỘ input (một offset duy nhất giữ đồng bộ A/V).
  const starts: StreamStart[] = [];
  for (const e of entries) {
    if (e.firstPtsUs === null) continue;
    starts.push({
      streamIndex: e.streamIndex,
      firstDts: e.firstPtsUs + correctionAtUs(e.firstPtsUs, seams),
      timeBase: { num: 1, den: TIME_BASE_US },
    });
  }
  return { seams, rebaseOffsetUs: computeRebaseOffsetUs(starts) };
}

/**
 * Áp plan cho một packet (lượt 2). Thuần, không trạng thái, không phụ thuộc thứ tự nạp
 * — đây chính là tính chất mà bản chạy-dần theo thứ tự demux đã KHÔNG có.
 */
export function applyPlan(pkt: TimedPacket, plan: TimelinePlan): TimedPacket {
  // 🔴 CHẶN CỨNG: bản thuần này CHỈ đúng khi không có seam nào.
  // Có seam thì bắt buộc đi qua `createRebaser`/`rebasePacket`, vì hai lý do đã ĐO:
  // seam LÙI làm mốc thô trước/sau trùng dải giá trị (không hàm thuần nào phân biệt nổi),
  // và DTS phải được kẹp đơn điệu theo TỪNG stream, vốn cần trạng thái.
  // Ném lỗi ở đây thay vì trả về số sai — dự án này đã trả giá đủ cho kiểu hỏng im lặng.
  if (plan.seams.length > 0) {
    throw new Error(
      `applyPlan không dùng được khi plan có seam (${plan.seams.length}). Dùng createRebaser()/rebasePacket().`,
    );
  }
  return applyRebaseOnly(pkt, plan);
}

/** Phần dịch-mốc thuần, dùng chung cho `applyPlan` (đã chặn seam ở trên). */
function applyRebaseOnly(pkt: TimedPacket, plan: TimelinePlan): TimedPacket {
  // dts quyết định seam; pts dùng CÙNG hiệu chỉnh với dts của chính packet đó để
  // không bao giờ phá vỡ quan hệ pts-dts (quan trọng khi có B-frame).
  const d = pkt.dts ?? pkt.pts;
  let shiftUs = plan.rebaseOffsetUs;
  if (d !== null && d !== undefined) {
    shiftUs += correctionAtUs(toMicros(d, pkt.timeBase), plan.seams);
  }
  const off = fromMicros(shiftUs, pkt.timeBase);
  return {
    ...pkt,
    pts: pkt.pts === null ? null : pkt.pts + off,
    dts: pkt.dts === null ? null : pkt.dts + off,
  };
}
