// Handle timestamps when remuxing MPEG-TS -> MP4 with libav.js. PURE LOGIC, no wasm/chrome touch.
//
// Three silent-breakage risks this file exists to block:
//   (i)   Raw MPEG-TS PTS leaking straight into output -> start_time 80000 s while duration is 12 s.
//   (ii)  Comparing/sorting on .dts (SIGNED 32-bit low word) -> order reverses past 2^31.
//   (iii) #EXT-X-DISCONTINUITY (ad insertion) -> libavformat does NOT patch it automatically; output ends up 9 hours.
//
// Every number in this file has been MEASURED, see remux-time.test.ts.

/* ────────────────────────── 1. libav.js 64-bit representation ────────────────────────── */

/**
 * libav.js exposes every int64 as a PAIR of 32-bit numbers: `pts`/`ptshi`, `dts`/`dtshi`.
 * The C macro that generates them (bindings.c) is:
 *     uint32_t X(a)   { return (uint32_t)(a->field);       }   // LOW word
 *     uint32_t Xhi(a) { return (uint32_t)(a->field >> 32); }   // HIGH word (arithmetic shift)
 * Emscripten returns i32 to JS as SIGNED, so BOTH words come back as signed int32.
 * MEASURED: writing 0xFFFFFFFF into the low word -> JS reads it back as -1.
 *
 * => Real value = hi * 2^32 + (lo READ AS UNSIGNED).
 */
export const TWO_POW_32 = 4294967296;

/** AV_NOPTS_VALUE = INT64_MIN, split into a (lo, hi) pair. MEASURED: lo=0, hi=-2147483648. */
export const NOPTS_LO = 0;
export const NOPTS_HI = -2147483648;

/** Number's safe threshold: above this, addition loses precision. */
export const MAX_EXACT = Number.MAX_SAFE_INTEGER; // 2^53 - 1

/** Whether a (lo, hi) pair is AV_NOPTS_VALUE. */
export function isNoPts(lo: number, hi: number): boolean {
  return lo === NOPTS_LO && hi === NOPTS_HI;
}

/**
 * Combine a libav.js (lo, hi) pair into one EXACT Number.
 *
 * `lo >>> 0` is the crux: it reads the low word as UNSIGNED. Writing `hi * 2^32 + lo`
 * (using the signed lo directly) is wrong in 6/15 measured cases — that's exactly defect (ii).
 *
 * Absolutely exact when |value| < 2^53. MPEG-TS timestamps max out at 2^33, so always safe.
 */
export function i64ToNumber(lo: number, hi: number): number {
  return hi * TWO_POW_32 + (lo >>> 0);
}

/** BigInt variant for cases needing precision beyond 2^53 (not used on the main path). */
export function i64ToBigInt(lo: number, hi: number): bigint {
  return (BigInt(hi) << 32n) | BigInt(lo >>> 0);
}

/** Split a Number back into a (lo, hi) pair for writing into an AVPacket. */
export function numberToI64(v: number): { lo: number; hi: number } {
  const hi = Math.floor(v / TWO_POW_32);
  const lo = v - hi * TWO_POW_32; // always within [0, 2^32)
  return { lo: lo | 0, hi: hi | 0 };
}

/**
 * Read pts/dts from a libav.js packet. Returns null when it's AV_NOPTS_VALUE.
 * Accepts an `unknown`-ish shape so it works with libav.js's Packet without needing the type import.
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

/* ────────────────────────── 2. Timebase conversion ────────────────────────── */

/** Internal timebase used to compare across streams (like ffmpeg's AV_TIME_BASE: microseconds). */
export const TIME_BASE_US = 1_000_000;

export interface TimeBase {
  num: number;
  den: number;
}

/**
 * Convert a timestamp between two timebases, rounding half-away-from-zero (like av_rescale_q's default).
 * v * (fromNum/fromDen) / (toNum/toDen)
 */
export function rescaleTs(v: number, from: TimeBase, to: TimeBase): number {
  const r = (v * from.num * to.den) / (from.den * to.num);
  return r < 0 ? -Math.round(-r) : Math.round(r);
}

/** Convert from a stream's timebase to microseconds. */
export function toMicros(v: number, tb: TimeBase): number {
  return rescaleTs(v, tb, { num: 1, den: TIME_BASE_US });
}

/** Convert from microseconds back to a stream's timebase. */
export function fromMicros(v: number, tb: TimeBase): number {
  return rescaleTs(v, { num: 1, den: TIME_BASE_US }, tb);
}

/* ────────────────────────── 3. Packet comparison / sorting ────────────────────────── */

export interface TimedPacket {
  streamIndex: number;
  /** Already combined into 64-bit, in the stream's timebase. null = AV_NOPTS_VALUE. */
  pts: number | null;
  dts: number | null;
  /** Duration in the stream's timebase (0 if unknown). */
  duration: number;
  timeBase: TimeBase;
  /**
   * Which input (the case where HLS/DASH has a SEPARATE audio rendition => two AVFormatContext,
   * and BOTH have `streamIndex 0`). Without this field, two streams from different inputs
   * collide on identity. Blank = 0 (single input).
   */
  inputIndex?: number;
  /**
   * Content type. ONLY used to pick the PRIMARY stream for seam detection — see `pickPrimaryKey`.
   * Blank falls back to the "smallest streamIndex" rule.
   */
  mediaType?: 'video' | 'audio' | 'other';
}

/** A stream's unique identity, accounting for input as well. */
export function streamKey(p: {
  inputIndex?: number;
  streamIndex: number;
}): string {
  return `${p.inputIndex ?? 0}:${p.streamIndex}`;
}

/**
 * Compare two packets to write out to the muxer in non-decreasing DTS order.
 *
 * MUST compare on the combined 64-bit value and MUST normalize to the same timebase.
 * The old version compared `a.dts - b.dts` directly (low word) -> order reverses past 2^31.
 * Ties fall back to streamIndex for stability (deterministic).
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

/** Count how many times DTS goes backward within a packet sequence of the SAME stream. Used for verification. */
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

/* ────────────────────────── 4. Patching discontinuities ────────────────────────── */

/**
 * MEASURED: libavformat does NOT patch #EXT-X-DISCONTINUITY. The ffmpeg CLI itself
 * (fftools/ffmpeg_demux.c) does, and that code is NOT part of the library we call. Without doing
 * it ourselves, a 12-second file comes out as 9.26 hours.
 *
 * ffmpeg's rule, copied verbatim:
 *   - Only applies to formats with the AVFMT_TS_DISCONT flag (mpegts has it).
 *   - delta = current_dts - expected_dts, where expected_dts = prev_dts + prev_duration.
 *     Use "dts + duration", NOT "prev dts" alone — otherwise delta picks up the natural
 *     spacing between two packets too (MEASURED: 3000003030 instead of 3000000000).
 *   - |delta| > threshold (default 10 s) -> accumulate -delta into ONE GLOBAL offset.
 *
 * The offset is GLOBAL (one number for every stream), not one offset per stream.
 * This is exactly what keeps A/V sync: both streams shift by the identical amount. Whichever
 * stream detects the seam first decides the offset; the other stream follows along.
 */
export const DEFAULT_DTS_DELTA_THRESHOLD_SEC = 10;

/**
 * Whether a deviation from the expected mark counts as a discontinuity.
 *
 * 🔴 ASYMMETRIC, and this is the crux — do NOT "clean this up" into `Math.abs(delta) > threshold`:
 *
 * - **Forward jump (delta > 0)**: must exceed the threshold. A forward gap is NORMAL for valid
 *   content (audio silence, timelapse, long GOP). Being too strict here is a FALSE alarm, and the
 *   project rule is clear: falsely killing a healthy download is WORSE than a hang.
 * - **Backward jump (delta < 0)**: ALWAYS a discontinuity, no matter how small. Within ONE
 *   stream, DTS is non-decreasing by spec (true even with B-frames — B-frames make PTS reorder,
 *   NOT DTS). So any backward jump means the source reset its clock.
 *
 * MEASURED why the two directions must be split: an ad segment resets PTS to 0 but only jumps
 * back 3.56s (below the 10s threshold) — the symmetric version does NOT treat this as a seam ->
 * the subsequent monotonic clamp compresses 90 packets into ~1ms, keeping the span at 3.56s
 * instead of 7.12s. No DTS reversal, no error, content silently gone. Exactly this project's
 * silent-breakage signature.
 */
export function isSeamDelta(deltaUs: number, thresholdUs: number): boolean {
  return deltaUs < 0 || deltaUs > thresholdUs;
}

/**
 * A discontinuity point on the RAW (uncorrected) timeline.
 * Keyed by raw position rather than by stream — this way, two streams crossing the same seam
 * produce only ONE correction, and packet ingest order no longer matters.
 */
export interface Seam {
  /** Raw DTS (µs) of the first packet AFTER the seam, decided by whichever stream detected it first. */
  atRawUs: number;
  /** Magnitude of the jump (µs). Positive = forward jump. */
  deltaUs: number;
  /** Stream that locked in this seam (diagnostic only). */
  detectedBy: number;
}

/**
 * ⚠️ MEASURED TRAP: `ff_read_frame_multi` returns packets GROUPED BY STREAM, NOT in demux order.
 * The first version of this design kept a running offset that advanced with ingest order; the
 * result was that video finished patching the seam, then audio ran through its own sequence from
 * the start and patched THAT SAME SEAM AGAIN
 * -> offset -66666666678 µs instead of -33333333334 µs, exactly double, and the output was off by 33333 s.
 *
 * So seams are keyed by RAW POSITION. Whichever stream arrives first locks in `deltaUs`; the
 * later stream recognizes the same seam (position offset still under threshold) and REUSES it
 * instead of adding to it. This is also exactly ffmpeg's behavior: it only logs the discontinuity ONCE.
 */
export function isSameSeam(a: Seam, b: Seam, thresholdUs: number): boolean {
  return Math.abs(a.atRawUs - b.atRawUs) <= thresholdUs;
}

/**
 * Scan seams on ONE stream. `packets` must be in increasing DTS order for that stream
 * (exactly how libav returns packets per-stream).
 *
 * Expected = prev_dts + prev_duration. Use "dts + duration", NOT "prev dts" alone:
 * MEASURED, dropping duration makes delta pick up the natural spacing between two packets
 * (3000003030 instead of 3000000000 — off by 3030 ticks = 33.7 ms).
 */
export function detectSeams(
  packets: readonly TimedPacket[],
  thresholdSec: number = DEFAULT_DTS_DELTA_THRESHOLD_SEC,
): Seam[] {
  // Goes through the EXACT SAME state machine the streaming-scan version uses. Deliberately
  // not writing a separate loop here: on the morning of 2026-07-19 we MEASURED the consequences
  // of having two versions diverge — the array version got three bugs patched (FP-4, min-first-PTS,
  // inputIndex collision) while the streaming version did NOT, and the streaming version is the
  // one that actually runs. A single shared state machine means they can no longer drift apart.
  const d = createStreamDetector(0, 0, undefined, thresholdSec * TIME_BASE_US);
  for (const p of packets) feedDetector(d, p);
  return finishDetector(d);
}

/* ─────────── Seam-detection state machine for ONE stream (shared by both versions) ─────────── */

/** Number of observed spacings needed to lock in a stream's true "cadence". */
const SPACING_SAMPLES = 64;
/**
 * Below this many samples, do NOT trust the median — keep the old behavior (trust `duration`).
 *
 * 🔴 MEASURED while fixing the VFR bug: with 2 samples where one of them IS the seam's jump,
 * the median gets skewed by the seam itself -> the declared `duration` gets judged as "wrong" ->
 * the expected mark jumps ahead -> ANOTHER false seam is generated right at the second packet.
 * Four previously-green tests went red because of exactly this spot.
 * The median only resists noise when the outlier is a minority.
 */
const MIN_SPACING_SAMPLES = 8;
/** Deviate by more than this factor and we stop trusting the declared `duration`, trusting the observed cadence instead. */
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
  /** Observed DTS spacings (µs), capped at the first SPACING_SAMPLES. */
  deltas: number[];
  /** The locked-in median of `deltas`. null = not enough samples yet. */
  spacingUs: number | null;
  /** Seam candidates waiting on cadence lock-in. Capped (≤ SPACING_SAMPLES) so memory stays O(1). */
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
 * Lock in a candidate: is it really a discontinuity?
 *
 * 🔴 THIS IS WHERE THE VFR/TIMELAPSE BUG IS FIXED (measured 2026-07-19, caught by adversarial review):
 * a stream whose frames are REALLY 15 seconds apart but whose demuxer declares `r_frame_rate=25/1`
 * -> `duration` per packet = 0.04 s. Taking `expected = dts + 0.04s` means EVERY packet deviates
 * by 14.96 s, past the 10 s threshold -> **11 FALSE seams out of 12 packets**, and after
 * "correcting" it, 165 seconds of content becomes **0.44 seconds**. The file still has all 12
 * frames, still decodes cleanly, `av_write_trailer` still returns 0 — no signal whatsoever.
 * Exactly this project's silent-breakage signature.
 *
 * Fixed by asking one more question: is this jump ABNORMAL relative to this stream itself?
 * Real discontinuities (ad insertion) are RARE and ISOLATED; a wrongly-declared `duration`
 * deviates UNIFORMLY on every packet. So when the declared `duration` deviates more than 2x from
 * the observed cadence, we trust the observed cadence instead.
 *
 * Deliberate trade-off: a real seam SMALLER than cadence + threshold will be missed. Missing a
 * seam = the gap stays in, the file runs longer than it should — annoying but CONTENT STAYS
 * INTACT. A false alarm = content gets compressed away. Project rule: falsely killing a healthy
 * download is worse than a hang.
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

  // 🔴 FALSE ALARM — MEASURED, project rule: falsely killing a healthy download is WORSE than a hang.
  // A packet with unknown duration gives NO way to derive an "expected mark", so there's no basis
  // to call it a discontinuity. The old version fell back to `expected = dts` and the measured fallout:
  //   - a timed-ID3 track (very common in real HLS, 1 packet duration=0 per segment,
  //     12s segment > 10s threshold) -> 9 FALSE seams, each one shifting the global offset;
  //   - a timelapse at 1 frame/15s where the demuxer reports duration=0 -> 11 FALSE seams.
  // Skip such packets entirely: no detection, and also NO expected-mark update.
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
 * Pick the PRIMARY stream — the only stream allowed to lock in a GLOBAL seam.
 *
 * 🔴 MEASURED (case FP-4), the worst bug in the false-alarm group: a HEALTHY video, continuous
 * for 59.96s, paired with audio that has a **valid 30-second silence**. The old version let
 * audio lock the seam and applied it to every stream -> **video ends up 30.02s, exactly half
 * missing**, not a single error line.
 *
 * A real discontinuity (ad insertion) always cuts both video and audio, so it's ALWAYS visible
 * on video. A silence that's audio-only is almost certainly valid content.
 * => Only video is allowed to lock in a seam. No video stream, fall back to the smallest stream index.
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
 * The core of `pickPrimaryKey`, split out so the STREAMING-SCAN version can share it.
 *
 * 🔴 Sharing is deliberate: the streaming version used to have its own selection rule
 * (effectively NO rule at all — every stream was allowed to lock a seam), which is exactly
 * how it inherited the FP-4 bug the array version had already fixed. Two versions diverging
 * is how that bug survived. Don't split this apart again.
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
 * Merge seams found across multiple streams into a GLOBAL seam list.
 * Seams at the same raw position (within threshold) are ONE seam; keep the version from
 * whichever stream came first (the input array is already ordered by stream, video is usually
 * stream 0 — matching ffmpeg's behavior).
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
 * Total correction (µs) to apply to a RAW time mark.
 *
 * A packet falls AFTER a seam when its raw mark passes the midpoint between the before-region
 * and the after-region: the before-region sits around `atRawUs - deltaUs`, the after-region
 * starts at `atRawUs`. The gap between the two regions is exactly `deltaUs` (> the 10 s
 * threshold), while A/V drift is only millisecond-scale, so the midpoint reliably separates them
 * for EVERY stream — that's what keeps two streams shifting by the exact same amount.
 */
export function correctionAtUs(rawUs: number, seams: readonly Seam[]): number {
  let corr = 0;
  for (const s of seams) {
    if (rawUs > s.atRawUs - s.deltaUs / 2) corr -= s.deltaUs;
  }
  return corr;
}

/** Shift both pts and dts of a packet by `offsetUs` microseconds, keeping the timebase unchanged. */
export function shiftPacket(pkt: TimedPacket, offsetUs: number): TimedPacket {
  if (offsetUs === 0) return pkt;
  const off = fromMicros(offsetUs, pkt.timeBase);
  return {
    ...pkt,
    pts: pkt.pts === null ? null : pkt.pts + off,
    dts: pkt.dts === null ? null : pkt.dts + off,
  };
}

/* ────────────────────────── 5. Rebasing the time mark to 0 ────────────────────────── */

/**
 * MEASURED (ffmpeg 8.1, `-c copy`, 5 different inputs -> identical output behavior):
 * ffmpeg shifts EVERY stream by a SINGLE offset = the smallest DTS across all streams,
 * i.e. `-avoid_negative_ts make_zero`. It does NOT rebase each stream to 0 individually.
 *
 * Since DTS within a stream is non-decreasing, a stream's smallest DTS = the DTS of its FIRST
 * packet. So only the first packet of each stream is needed to compute the offset -> fits streaming processing.
 *
 * Consequence (MEASURED on the standard fixture): audio starts at 126000, video at 128090.
 * offset = 126000. Result: audio 0, video 2090 ticks = 23.222 ms.
 * The 2090-tick A/V gap is PRESERVED EXACTLY at the packet level.
 * (In the MP4 file it becomes an empty-edit in the elst, quantized to the movie timescale of 1000
 *  -> writes as 23 ms; the 0.222 ms error is inherent to the MP4 format, real ffmpeg does the same.)
 */
export interface StreamStart {
  streamIndex: number;
  /** DTS (or PTS if there's no DTS) of the first packet, in the stream's timebase. */
  firstDts: number;
  timeBase: TimeBase;
}

/**
 * Offset (µs) to ADD to every timestamp so the smallest mark lands exactly at 0.
 * Returns 0 when there are no streams -> no change.
 */
export function computeRebaseOffsetUs(starts: readonly StreamStart[]): number {
  let min: number | null = null;
  for (const s of starts) {
    const us = toMicros(s.firstDts, s.timeBase);
    if (min === null || us < min) min = us;
  }
  return min === null ? 0 : -min;
}

/* ────────────────────────── 6. Assembling into one pipeline ────────────────────────── */

/**
 * All the information needed to adjust timestamps, computed AHEAD of time.
 *
 * The pipeline runs in TWO PASSES:
 *   Pass 1 — demux, keep ONLY timestamps and discard the data, build a `TimelinePlan`.
 *   Pass 2 — demux again, apply the plan to each packet and push straight to the muxer.
 *
 * Trading one extra demux pass to get BOUNDED memory. The old harness kept every packet
 * in RAM for sorting: MEASURED Node RSS of 2.52 GB for a 163 MB input — unusable.
 *
 * ⚠️ Pass 1 must NOT keep every timestamp: MEASURED at 65 B/packet, a 3-hour movie
 * (~790k packets) ≈ 49 MB. Use `SeamScanner` — both `detectSeams` and the start mark are FOLD
 * operations, so scanning can be streamed with O(number of seams) memory, i.e. a few dozen bytes.
 * The array-based version below is kept for test convenience.
 *
 * The plan is also worth logging/telemetry: `seams.length` can be cross-checked against
 * `countDiscontinuities()` which utils/hls.ts already counts from the playlist.
 */
export interface TimelinePlan {
  seams: Seam[];
  /** Rebase-to-0 offset (µs), applied AFTER subtracting the seam. */
  rebaseOffsetUs: number;
}

/** Minimal timing info needed for pass 1. */
export type TimestampOnly = TimedPacket;

/**
 * Build a plan from pass 1's raw timestamps.
 * `perStream` is ordered by increasing stream index (video is usually 0) so locking in a seam's
 * `deltaUs` matches ffmpeg's own choice.
 */
export function buildTimelinePlan(
  perStream: readonly (readonly TimestampOnly[])[],
  thresholdSec: number = DEFAULT_DTS_DELTA_THRESHOLD_SEC,
): TimelinePlan {
  // ONLY the primary stream is allowed to lock in a global seam — see `pickPrimaryKey`.
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

  // 🔴 The rebase mark is taken from the smallest FIRST PTS, NOT the smallest first DTS.
  // The two rules only coincide when pts == dts — which every early fixture happened to have,
  // so this bug stayed invisible. Add a B-frame and it deviates immediately. MEASURED on
  // fixture bf.ts:
  //   input: video pts=7200 dts=0 | audio pts=dts=5280
  //   ffmpeg -c copy -> offset -5280 ticks (ffprobe format start_time = 0.058667
  //   = exactly audio's first PTS), i.e. it takes min PTS, not min DTS (=0).
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

/* ──────────────── 6b. Applying the plan by STREAM — the ONLY version actually used ──────────────── */

/**
 * 🔴 WHY STATE IS REQUIRED (and why a pure `applyPlan` is NOT enough):
 *
 * 1. **Backward seam.** The MOST common HLS discontinuity is a PTS reset to 0 (each ad segment
 *    is encoded independently starting at 0). When that happens, the raw mark BEFORE and AFTER
 *    the seam **overlap in value range** (both are 0..10s), so NO pure value-based function can
 *    tell them apart. MEASURED on the old version: 70s of content came out as a 120.04s file.
 *    Must track by ORDER, not by value.
 * 2. **DTS monotonicity.** The global offset is locked in by video, but audio segment boundaries
 *    don't align with video boundaries (AAC frame is 21.3ms; measured: video at 4.000s vs audio
 *    at 4.032s), so after correction audio OVERLAPS ITSELF — measured 4 reversals, exactly one
 *    per seam. `av_interleaved_write_frame()` **REJECTS** non-monotonic dts ("non monotonically
 *    increasing dts") -> mux error or silently dropped packets.
 *
 * Both cases force remembering state PER stream. This is why the "pure plan, order-independent"
 * architecture was abandoned — it can't be made correct.
 *
 * Usage: each stream feeds packets in its own correct DTS order (exactly how
 * `ff_read_frame_multi` groups by stream). Order BETWEEN streams doesn't matter.
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
 * Apply the correction to ONE packet and return the shifted version.
 *
 * Preserves that packet's own pts-dts delta (important for B-frames), and guarantees
 * the output DTS never goes backward relative to the previous packet of the same stream.
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

  // Track seams by ORDER: seeing a jump past the threshold means we've just crossed the next
  // seam in the global list, and we use the MAGNITUDE of the global seam (locked in by the
  // primary stream) — this is what makes every stream shift by the exact same amount, keeping A/V sync.
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

  // Monotonic clamp. Whatever bump is applied to dts, apply the identical bump to pts, so the
  // pts >= dts relationship is never broken.
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
 * Streaming scan for pass 1: O(number of seams) memory, keeps no timestamps at all.
 * Feed each stream's packets in that stream's own DTS order; order BETWEEN streams
 * doesn't matter (exactly how `ff_read_frame_multi` groups by stream).
 */
export interface SeamScanner {
  /** Keyed by `streamKey` (inputIndex:streamIndex) — NOT by raw streamIndex. */
  perStream: Map<string, StreamDetector>;
  thresholdSec: number;
}

export function createSeamScanner(
  thresholdSec: number = DEFAULT_DTS_DELTA_THRESHOLD_SEC,
): SeamScanner {
  return { perStream: new Map(), thresholdSec };
}

/** Feed ONE timestamp into the scanner. Keeps nothing except seams (and the capped cadence buffer). */
export function scanTimestamp(sc: SeamScanner, pkt: TimedPacket): void {
  // 🔴 Keyed by streamKey, NOT by `pkt.streamIndex`: the split-audio case has TWO
  // AVFormatContext, and BOTH number their streams starting from 0. Keying by the raw number
  // would merge video and audio into the same slot, interleaving both streams' timestamps and
  // generating a batch of false seams.
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

/** Finalize the plan after pass 1 has been fully fed. */
export function finishScan(sc: SeamScanner): TimelinePlan {
  const entries = [...sc.perStream.values()].sort(
    (a, b) => a.inputIndex - b.inputIndex || a.streamIndex - b.streamIndex,
  );
  for (const e of entries) finishDetector(e);
  // 🔴 ONLY the primary stream is allowed to lock in a global seam — identical to `buildTimelinePlan`.
  // Letting every stream lock in is the FP-4 bug: a HEALTHY video paired with audio that has a
  // VALID 30-second silence causes audio to generate a false seam, and video gets cut exactly
  // in half, not a single error line.
  const primary = pickPrimaryOf(entries);
  const seams = mergeSeams(
    entries.filter((e) => streamKey(e) === primary).map((e) => e.seams),
    sc.thresholdSec,
  );
  // The rebase mark pools EVERY stream of EVERY input (a single offset keeps A/V sync).
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
 * Apply the plan to a packet (pass 2). Pure, stateless, order-independent
 * — exactly the property the running-offset-by-demux-order version LACKED.
 */
export function applyPlan(pkt: TimedPacket, plan: TimelinePlan): TimedPacket {
  // 🔴 HARD GUARD: this pure version is ONLY correct when there are no seams.
  // With seams present, you MUST go through `createRebaser`/`rebasePacket`, for two MEASURED
  // reasons: a backward seam makes the before/after raw marks overlap in value range (no pure
  // function can tell them apart), and DTS must be clamped monotonic PER stream, which needs state.
  // Throwing here instead of returning a wrong number — this project has paid enough for the
  // silent-breakage pattern.
  if (plan.seams.length > 0) {
    throw new Error(
      `applyPlan không dùng được khi plan có seam (${plan.seams.length}). Dùng createRebaser()/rebasePacket().`,
    );
  }
  return applyRebaseOnly(pkt, plan);
}

/** The pure mark-shifting part, shared by `applyPlan` (seams already guarded against above). */
function applyRebaseOnly(pkt: TimedPacket, plan: TimelinePlan): TimedPacket {
  // dts decides the seam; pts uses the SAME correction as that packet's own dts so the
  // pts-dts relationship is never broken (important with B-frames).
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
