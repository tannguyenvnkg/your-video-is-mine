// Test for utils/remux-time.ts. Every expected number is TAKEN FROM REAL MEASUREMENTS:
// ffmpeg 8.1 `-c copy` on the same fixtures, and real AVPacket from the actual libav.js ts2mp4d build.
import { describe, expect, it } from 'vitest';
import {
  NOPTS_HI,
  NOPTS_LO,
  TIME_BASE_US,
  applyPlan,
  buildTimelinePlan,
  comparePackets,
  computeRebaseOffsetUs,
  correctionAtUs,
  createRebaser,
  createSeamScanner,
  countDtsInversions,
  detectSeams,
  finishScan,
  fromMicros,
  i64ToBigInt,
  i64ToNumber,
  isNoPts,
  isSeamDelta,
  mergeSeams,
  numberToI64,
  readDts,
  rebasePacket,
  readPts,
  rescaleTs,
  scanTimestamp,
  toMicros,
  type Seam,
  type TimeBase,
  type TimedPacket,
} from './remux-time';

const TB90: TimeBase = { num: 1, den: 90000 };
const pk = (
  streamIndex: number,
  dts: number | null,
  duration = 0,
  pts: number | null = dts,
  timeBase: TimeBase = TB90,
): TimedPacket => ({ streamIndex, pts, dts, duration, timeBase });

/* ══════════════ 1. 64-bit representation ══════════════ */
/** Grab the first element, throw if empty — so tests don't have to sprinkle `!` (noUncheckedIndexedAccess). */
function first<T>(xs: readonly T[]): T {
  const x = xs[0];
  if (x === undefined) throw new Error('mảng rỗng');
  return x;
}

describe('i64ToNumber — pairing libav.js (lo, hi)', () => {
  // This table is MEASURED: write the value into a real AVPacket via AVPacket_pts_s/AVPacket_ptshi_s
  // then read it back with AVPacket_pts/AVPacket_ptshi. The low word comes back SIGNED.
  const MEASURED: Array<[string, number, number, number]> = [
    ['zero', 0, 0, 0],
    ['one', 1, 0, 1],
    ['2^31-1', 2147483647, 0, 2147483647],
    ['2^31  (lo hoá âm)', -2147483648, 0, 2147483648],
    ['2^32-1 (lo toàn 1)', -1, 0, 4294967295],
    ['2^32', 0, 1, 4294967296],
    ['2^33-1 (PTS 33-bit lớn nhất)', -1, 1, 8589934591],
    ['2^33  (điểm wrap của TS)', 0, 2, 8589934592],
    ['26h @90k', -165934592, 1, 8424000000],
    ['-1', -1, -1, -1],
    ['-2^31', -2147483648, -1, -2147483648],
    ['-2^33', 0, -2, -8589934592],
  ];

  it.each(MEASURED)('%s -> %d', (_n, lo, hi, expected) => {
    expect(i64ToNumber(lo, hi)).toBe(expected);
  });

  it('MUST NOT write hi*2^32 + lo (using signed lo) — wrong on 6/15 measured cases', () => {
    // This is exactly defect (ii). 2^31 with lo = -2147483648.
    const naive = 0 * 4294967296 + -2147483648;
    expect(naive).toBe(-2147483648);
    expect(i64ToNumber(-2147483648, 0)).toBe(2147483648);
    expect(i64ToNumber(-2147483648, 0)).not.toBe(naive);
  });

  it('i64ToBigInt matches i64ToNumber within Number safe range', () => {
    for (const [, lo, hi, expected] of MEASURED) {
      expect(i64ToBigInt(lo, hi)).toBe(BigInt(expected));
    }
  });

  it('numberToI64 is the inverse of i64ToNumber', () => {
    for (const [, lo, hi, v] of MEASURED) {
      const s = numberToI64(v);
      expect(i64ToNumber(s.lo, s.hi)).toBe(v);
      expect(s.lo).toBe(lo);
      expect(s.hi).toBe(hi);
    }
  });
});

describe('AV_NOPTS_VALUE', () => {
  it('accepts the exact measured pair (lo=0, hi=-2147483648)', () => {
    expect(NOPTS_LO).toBe(0);
    expect(NOPTS_HI).toBe(-2147483648);
    expect(isNoPts(NOPTS_LO, NOPTS_HI)).toBe(true);
  });
  it('does not mistake a valid timestamp for NOPTS', () => {
    expect(isNoPts(0, 0)).toBe(false);
    expect(isNoPts(-2147483648, 0)).toBe(false); // this is 2^31, NOT NOPTS
  });
  it('readPts/readDts return null for NOPTS, a number for real values', () => {
    expect(readPts({ pts: NOPTS_LO, ptshi: NOPTS_HI })).toBeNull();
    expect(readDts({ dts: NOPTS_LO, dtshi: NOPTS_HI })).toBeNull();
    expect(readPts({ pts: -1, ptshi: 1 })).toBe(8589934591);
    expect(readDts({ dts: 128090, dtshi: 0 })).toBe(128090);
  });
});

/* ══════════════ 2. Timebase conversion ══════════════ */
describe('rescaleTs / toMicros / fromMicros', () => {
  it('90kHz -> microseconds', () => {
    expect(toMicros(90000, TB90)).toBe(1_000_000);
    expect(toMicros(126000, TB90)).toBe(1_400_000); // measured audio marker from the fixture
  });
  it('round-trip does not drift at the measured markers', () => {
    for (const v of [
      0, 2090, 126000, 128090, 7200128090, 2146943648, -540000,
    ]) {
      expect(fromMicros(toMicros(v, TB90), TB90)).toBe(v);
    }
  });
  it('rounds half-away-from-zero (like av_rescale_q)', () => {
    expect(rescaleTs(1, { num: 1, den: 3 }, { num: 1, den: 2 })).toBe(1);
    expect(rescaleTs(-1, { num: 1, den: 3 }, { num: 1, den: 2 })).toBe(-1);
  });
});

/* ══════════════ 3. Packet comparison ══════════════ */
describe('comparePackets — MUST compare on the reassembled 64-bit value', () => {
  it('orders correctly when DTS crosses 2^31', () => {
    // MEASURED on the 2p31 fixture: low word jumps +2147483647 -> -2147483648.
    const before = pk(0, 2147483647);
    const after = pk(0, 2147483648);
    expect(comparePackets(before, after)).toBeLessThan(0);
  });
  it('the wrong version (comparing low word) flips order — this is the regression to block', () => {
    const loBefore = numberToI64(2147483647).lo;
    const loAfter = numberToI64(2147483648).lo;
    expect(loAfter - loBefore).toBeLessThan(0); // wrong
    expect(comparePackets(pk(0, 2147483647), pk(0, 2147483648))).toBeLessThan(
      0,
    ); // correct
  });
  it('reduces to the same timebase before comparing', () => {
    const v = pk(0, 90000, 0, 90000, TB90); // 1.0 s
    const a = pk(1, 48000, 0, 48000, { num: 1, den: 48000 }); // 1.0 s
    expect(comparePackets(v, a)).toBeLessThan(0); // tie -> resolved by streamIndex
  });
  it('stable: ties resolve by streamIndex', () => {
    expect(comparePackets(pk(1, 100), pk(0, 100))).toBeGreaterThan(0);
  });
  it('countDtsInversions detects DTS going backwards', () => {
    expect(countDtsInversions([pk(0, 1), pk(0, 2), pk(0, 3)])).toBe(0);
    expect(countDtsInversions([pk(0, 1), pk(0, 5), pk(0, 3)])).toBe(1);
  });
});

/* ══════════════ 4. Pull to 0 ══════════════ */
describe('computeRebaseOffsetUs — ONE shared offset for every stream', () => {
  it('uses the smallest DTS ACROSS ALL streams, not per-stream', () => {
    // MEASURED: standard fixture video=128090, audio=126000 -> offset -1400000 us.
    const off = computeRebaseOffsetUs([
      { streamIndex: 0, firstDts: 128090, timeBase: TB90 },
      { streamIndex: 1, firstDts: 126000, timeBase: TB90 },
    ]);
    expect(off).toBe(-1_400_000);
  });
  it('no streams -> 0', () => {
    expect(computeRebaseOffsetUs([])).toBe(0);
  });
});

describe('buildTimelinePlan + applyPlan — pull markers to 0', () => {
  const mk = (v0: number, a0: number) => ({
    video: [pk(0, v0, 3000), pk(0, v0 + 3000, 3000)],
    audio: [pk(1, a0, 2089), pk(1, a0 + 2089, 2089)],
  });

  // MEASURED: ffmpeg 8.1 -c copy on these 5 inputs produces IDENTICAL output
  // (video start_pts=2070, audio=0, 360/518 frames, duration 12.027937).
  // 2070 is 2090 after MP4 quantizes it to the movie timescale 1000.
  it.each([
    ['fixture chuẩn', 128090, 126000],
    ['PTS lớn (80000 s)', 7200128090, 7200126000],
    ['vượt 2^32', 4294568090, 4294566000],
    ['vượt 2^31', 2146943648, 2146941558],
    ['sau wrap 33-bit (âm)', -540000, -542090],
  ])('%s -> video 2090 tick, audio 0', (_n, v0, a0) => {
    const { video, audio } = mk(v0, a0);
    const plan = buildTimelinePlan([video, audio]);
    expect(applyPlan(first(audio), plan).dts).toBe(0);
    expect(applyPlan(first(video), plan).dts).toBe(2090);
  });

  it('the EARLIEST-starting stream goes to 0, not every stream', () => {
    // MEASURED on the avoff fixture: video 128090, audio 171000
    // -> ffmpeg produces video start_pts=0, audio start_time=0.476009 s.
    const { video, audio } = mk(128090, 171000);
    const plan = buildTimelinePlan([video, audio]);
    expect(applyPlan(first(video), plan).dts).toBe(0);
    expect(applyPlan(first(audio), plan).dts).toBe(42910); // 0.4767778 s
  });

  it('preserves the pts >= dts relationship (safe with B-frames)', () => {
    const v: TimedPacket = {
      streamIndex: 0,
      dts: 128090,
      pts: 134090,
      duration: 3000,
      timeBase: TB90,
    };
    const plan = buildTimelinePlan([[v]]);
    const o = applyPlan(v, plan);
    expect(o.pts! - o.dts!).toBe(6000);
  });

  it('skips null pts/dts without throwing', () => {
    const v = pk(0, null, 3000, null);
    const plan = buildTimelinePlan([[pk(0, 90000, 3000)], [v]]);
    const o = applyPlan(v, plan);
    expect(o.dts).toBeNull();
    expect(o.pts).toBeNull();
  });
});

/* ══════════════ 5. A/V SYNC ══════════════ */
describe('A/V sync — the most important invariant', () => {
  // Video and audio must shift by the SAME offset. Pulling each stream to 0 independently
  // would destroy A/V skew, and no error would ever be thrown.
  it.each([
    ['audio sớm 2090 tick', 128090, 126000, -2090],
    ['audio muộn 42910 tick', 128090, 171000, 42910],
    ['audio muộn 1 giây', 128090, 218090, 90000],
    ['PTS lớn, audio sớm', 7200128090, 7200126000, -2090],
    ['vượt 2^31, audio sớm', 2146943648, 2146941558, -2090],
    ['sau wrap (âm), audio sớm', -540000, -542090, -2090],
  ])('%s: skew stays EXACTLY 0 tick', (_n, v0, a0, skew) => {
    const video = [pk(0, v0, 3000), pk(0, v0 + 3000, 3000)];
    const audio = [pk(1, a0, 2089), pk(1, a0 + 2089, 2089)];
    const plan = buildTimelinePlan([video, audio]);
    const ov = applyPlan(first(video), plan).dts!;
    const oa = applyPlan(first(audio), plan).dts!;
    expect(a0 - v0).toBe(skew);
    expect(oa - ov).toBe(skew); // 0 tick drift
  });

  it('MUST NOT pull each stream to 0 individually', () => {
    const video = [pk(0, 128090, 3000)];
    const audio = [pk(1, 171000, 2089)];
    const plan = buildTimelinePlan([video, audio]);
    expect(applyPlan(first(audio), plan).dts).not.toBe(0); // if it were 0, the 476ms skew would be lost
  });
});

/* ══════════════ 6. DISCONTINUITY ══════════════ */
describe('detectSeams', () => {
  it('no discontinuity -> no seam', () => {
    const v = [pk(0, 0, 3000), pk(0, 3000, 3000), pk(0, 6000, 3000)];
    expect(detectSeams(v)).toHaveLength(0);
  });

  it('the expected value must be dts + duration, NOT the previous dts', () => {
    // MEASURED: dropping duration makes the delta come out as 3000003030 ticks instead of 3000000000
    // (picks up an extra 3030-tick natural gap = 33.7 ms).
    const jump = 3_000_000_000;
    const v = [pk(0, 0, 3000), pk(0, 3000, 3000), pk(0, 6000 + jump, 3000)];
    const seams = detectSeams(v);
    expect(seams).toHaveLength(1);
    // 3000000000 ticks @90kHz = 33333333333.33 us — NOT divisible evenly. `expected` accumulates
    // each packet's already-rounded duration (33333 us each), so a sub-1us drift here is CORRECT.
    // ffmpeg also produces this exact number: its log reads "new offset= -33333333334".
    expect(seams[0]!.deltaUs).toBe(33_333_333_334);
    expect(
      Math.abs(seams[0]!.deltaUs - toMicros(jump, TB90)),
    ).toBeLessThanOrEqual(2);
  });

  it('a jump smaller than the threshold is NOT a seam', () => {
    const v = [
      pk(0, 0, 3000),
      pk(0, 3000, 3000),
      pk(0, 6000 + 90000 * 9, 3000),
    ]; // 9 s
    expect(detectSeams(v)).toHaveLength(0);
  });

  it('also catches BACKWARD jumps (PTS resets)', () => {
    const v = [
      pk(0, 90000 * 100, 3000),
      pk(0, 90000 * 100 + 3000, 3000),
      pk(0, 0, 3000),
    ];
    const seams = detectSeams(v);
    expect(seams).toHaveLength(1);
    expect(seams[0]!.deltaUs).toBeLessThan(0);
  });

  it('multiple seams (multiple ad insertions)', () => {
    const J = 3_000_000_000;
    const v = [
      pk(0, 0, 3000),
      pk(0, 3000, 3000),
      pk(0, 6000 + J, 3000),
      pk(0, 9000 + J, 3000),
      pk(0, 12000 + 2 * J, 3000),
    ];
    expect(detectSeams(v)).toHaveLength(2);
  });
});

describe('mergeSeams — ONE seam even if multiple streams see it', () => {
  // ⚠️ REGRESSION THAT ACTUALLY HAPPENED: the first version kept an offset that ran forward as
  // packets were consumed. `ff_read_frame_multi` returns packets GROUPED BY STREAM, so after
  // video patched a seam, audio would patch that SAME seam AGAIN -> offset -66666666678 us
  // instead of -33333333334 us (double), and the output drifted 33333 s from ffmpeg.
  it('a seam seen at the same spot by video and audio counts ONCE', () => {
    const J = 3_000_000_000;
    const seamsV = detectSeams([
      pk(0, 0, 3000),
      pk(0, 3000, 3000),
      pk(0, 6000 + J, 3000),
    ]);
    const seamsA = detectSeams([
      pk(1, 0, 2089),
      pk(1, 2089, 2089),
      pk(1, 4178 + J, 2089),
    ]);
    expect(seamsV).toHaveLength(1);
    expect(seamsA).toHaveLength(1);
    expect(mergeSeams([seamsV, seamsA])).toHaveLength(1);
  });

  it("the stream that arrives first locks in the delta (matches ffmpeg's choice)", () => {
    const a: Seam = {
      atRawUs: 1_000_000_000,
      deltaUs: 33_333_333_334,
      detectedBy: 0,
    };
    const b: Seam = {
      atRawUs: 1_000_010_000,
      deltaUs: 33_333_333_345,
      detectedBy: 1,
    };
    const m = mergeSeams([[a], [b]]);
    expect(m).toHaveLength(1);
    expect(m[0]!.deltaUs).toBe(33_333_333_334);
    expect(m[0]!.detectedBy).toBe(0);
  });

  it('two seams FAR APART are still two seams', () => {
    const a: Seam = { atRawUs: 1_000_000_000, deltaUs: 3.3e10, detectedBy: 0 };
    const b: Seam = { atRawUs: 9_000_000_000, deltaUs: 3.3e10, detectedBy: 0 };
    expect(mergeSeams([[a, b]])).toHaveLength(2);
  });
});

describe('correctionAtUs', () => {
  const seam: Seam = {
    atRawUs: 33_340_756_556,
    deltaUs: 33_333_333_334,
    detectedBy: 0,
  };
  it('before the seam: no correction', () => {
    expect(correctionAtUs(1_400_000, [seam])).toBe(0);
  });
  it('after the seam: subtracts the exact delta', () => {
    expect(correctionAtUs(33_340_756_556, [seam])).toBe(-33_333_333_334);
  });
  it('splits at the MIDPOINT so every stream lands on the same side despite A/V skew', () => {
    const mid = seam.atRawUs - seam.deltaUs / 2;
    expect(correctionAtUs(mid - 1_000_000, [seam])).toBe(0);
    expect(correctionAtUs(mid + 1_000_000, [seam])).toBe(-seam.deltaUs);
  });
  it('multiple seams accumulate', () => {
    const s2: Seam = {
      atRawUs: 66_000_000_000,
      deltaUs: 30_000_000_000,
      detectedBy: 0,
    };
    expect(correctionAtUs(70_000_000_000, [seam, s2])).toBe(-63_333_333_334);
  });
});

describe('start-to-end discontinuity: a 12s file must still come out 12s', () => {
  it('swallows the seam and keeps A/V sync', () => {
    // MEASURED on the disc fixture: the first 3 segments have normal PTS, the next 3 jump
    // +3000000000 ticks. The raw TS reports a duration of 33345 s; ffmpeg -c copy still outputs 12.027937 s.
    const J = 3_000_000_000;
    const video: TimedPacket[] = [];
    const audio: TimedPacket[] = [];
    for (let i = 0; i < 180; i++) video.push(pk(0, 128090 + i * 3000, 3000));
    for (let i = 180; i < 360; i++)
      video.push(pk(0, 128090 + i * 3000 + J, 3000));
    for (let i = 0; i < 259; i++) audio.push(pk(1, 126000 + i * 2089, 2089));
    for (let i = 259; i < 518; i++)
      audio.push(pk(1, 126000 + i * 2089 + J, 2089));

    const plan = buildTimelinePlan([video, audio]);
    expect(plan.seams).toHaveLength(1); // NOT 2
    expect(plan.rebaseOffsetUs).toBe(-1_400_000);

    // There's a seam -> MUST go through the rebaser (applyPlan now throws on purpose).
    const rb = createRebaser(plan);
    const outV = video.map((p) => rebasePacket(rb, p).dts!);
    const outA = audio.map((p) => rebasePacket(rb, p).dts!);

    expect(countDtsInversions(outV.map((d) => pk(0, d)))).toBe(0);
    expect(countDtsInversions(outA.map((d) => pk(1, d)))).toBe(0);
    expect(outA[0]).toBe(0);
    expect(outV[0]).toBe(2090);
    // 12 s, not 9 hours
    expect((outV[outV.length - 1]! - outV[0]!) / 90000).toBeCloseTo(11.967, 3);
    // A/V skew preserved across the seam
    expect(outA[259]! - outV[180]!).toBe(audio[259]!.dts! - video[180]!.dts!);
  });
});

/* ══════════════ 7. Streaming scan ══════════════ */
describe('SeamScanner — pass 1 must run with O(number of seams) memory', () => {
  // MEASURED: keeping every TimedPacket costs 65 B/packet -> a 3-hour movie is ~49 MB.
  // The scanner only keeps seams, so it doesn't depend on the movie's length.
  const build = () => {
    const J = 3_000_000_000;
    const video: TimedPacket[] = [];
    const audio: TimedPacket[] = [];
    for (let i = 0; i < 180; i++) video.push(pk(0, 128090 + i * 3000, 3000));
    for (let i = 180; i < 360; i++)
      video.push(pk(0, 128090 + i * 3000 + J, 3000));
    for (let i = 0; i < 259; i++) audio.push(pk(1, 126000 + i * 2089, 2089));
    for (let i = 259; i < 518; i++)
      audio.push(pk(1, 126000 + i * 2089 + J, 2089));
    return { video, audio };
  };

  it('produces a plan IDENTICAL to the array-based version', () => {
    const { video, audio } = build();
    const sc = createSeamScanner();
    for (const p of video) scanTimestamp(sc, p);
    for (const p of audio) scanTimestamp(sc, p);
    expect(finishScan(sc)).toEqual(buildTimelinePlan([video, audio]));
  });

  it('does not depend on the feed order BETWEEN streams', () => {
    const { video, audio } = build();
    const a = createSeamScanner();
    for (const p of video) scanTimestamp(a, p);
    for (const p of audio) scanTimestamp(a, p);
    const b = createSeamScanner();
    for (const p of audio) scanTimestamp(b, p);
    for (const p of video) scanTimestamp(b, p);
    expect(finishScan(a)).toEqual(finishScan(b)); // any interleaving gives the same result
  });

  it('skips packets without a timestamp', () => {
    const sc = createSeamScanner();
    scanTimestamp(sc, pk(0, null, 3000, null));
    expect(finishScan(sc).rebaseOffsetUs).toBe(0);
  });
});

/* ══════════════ 8. Pinning constants ══════════════ */
describe('constants', () => {
  it("TIME_BASE_US matches ffmpeg's AV_TIME_BASE", () => {
    expect(TIME_BASE_US).toBe(1_000_000);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * BUGS FOUND BY ADVERSARIAL REVIEW (2026-07-19)
 *
 * The four cases below were RED on the first version, even though that version already had
 * 60 passing tests AND had passed mutation testing against 2 deliberately-broken versions.
 * Lesson: mutation testing proves the tests fire correctly according to INTENT, it does
 * NOT prove that intent is correct.
 *
 * Shared blind spot of the old test suite: every fixture had `pts == dts` and every seam had a
 * POSITIVE sign. Three out of the four bugs fall outside exactly that region. Don't narrow the
 * fixture set back down like before.
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('B1 — BACKWARD seam (PTS reset to 0): the MOST common HLS discontinuity shape', () => {
  // Each ad segment is encoded independently starting from 0, so a backward seam is actually the
  // common case, not a forward one. The old version only tested DETECTING a backward seam; every
  // correctionAtUs test used a POSITIVE delta -> the negative branch never ran.
  //
  // 🔴 And once it ran, it surfaced this: for a backward seam, the raw markers BEFORE and AFTER the
  // seam land in the SAME VALUE RANGE (both 0..10s), so no pure value-based function can tell them
  // apart. That's why it has to go through `rebasePacket` (which tracks ORDER) rather than `applyPlan`.
  const s = 90_000;
  const pre = Array.from({ length: 60 }, (_, i) => pk(0, i * s, s));
  const post = Array.from({ length: 10 }, (_, i) => pk(0, i * s, s));

  it('detects exactly ONE seam, with a negative magnitude', () => {
    const plan = buildTimelinePlan([[...pre, ...post]]);
    expect(plan.seams).toHaveLength(1);
    expect(plan.seams[0]!.deltaUs).toBeLessThan(0);
  });

  it('70 seconds of content comes out as ~70 seconds, not 120 seconds', () => {
    // MEASURED on the old version: span 120.04s + still one DTS inversion left.
    const plan = buildTimelinePlan([[...pre, ...post]]);
    const rb = createRebaser(plan);
    const out = [...pre, ...post].map((p) => rebasePacket(rb, p));
    const dts = out.map((p) => p.dts!);
    const spanSec = (Math.max(...dts) - Math.min(...dts)) / s;
    expect(spanSec).toBeCloseTo(69, 0);
    expect(countDtsInversions(out)).toBe(0);
  });
});

describe('B2 — the rebase marker is the min first-PTS, NOT the min first-DTS', () => {
  // The two rules only coincide when pts == dts, which every old fixture happened to satisfy.
  // Add a B-frame and they diverge immediately. MEASURED with ffmpeg -c copy on the bf.ts fixture:
  //   input : video pts=7200 dts=0 | audio pts=dts=5280
  //   ffmpeg output: offset -5280 ticks -> video pts 1920 dts -5280, audio 0
  //   ffprobe format start_time = 0.058667 = audio's first PTS
  it('content with B-frames: offset is taken from the smallest PTS', () => {
    const video = [pk(0, 0, 3000, 7200)]; // dts 0 but pts 7200
    const audio = [pk(1, 5280, 1024, 5280)];
    const plan = buildTimelinePlan([video, audio]);
    // min first-PTS = 5280 ticks = 58666.67 µs -> offset should be roughly that, negative
    expect(plan.rebaseOffsetUs).toBeCloseTo(-58_667, 0);
    expect(applyPlan(video[0]!, plan).pts).toBe(1920);
    expect(applyPlan(video[0]!, plan).dts).toBe(-5280);
    expect(applyPlan(audio[0]!, plan).pts).toBe(0);
  });
});

describe('C1 — DTS must be MONOTONIC per stream after correction', () => {
  // The most serious bug. The global offset is locked in by the VIDEO stream, but the audio
  // segment boundaries don't line up with the video's (AAC frame is 21.3ms; measured: video 4.000s
  // vs audio 4.032s), so after correction audio OVERLAPS ITSELF.
  // av_interleaved_write_frame() REJECTS non-monotonic dts -> silent mux failure/dropped packets.
  it('audio boundary misaligned with video: must not produce any inversion', () => {
    const s = 90_000;
    const vDur = 4 * s; // video 4.000s per part
    const aDur = Math.round(4.032 * s); // audio 4.032s — boundary offset, as actually measured
    const video: TimedPacket[] = [];
    const audio: TimedPacket[] = [];
    for (let part = 0; part < 3; part++) {
      const jump = part * 20_000 * s; // each part jumps 20000s (ad break)
      for (let i = 0; i < 4; i++)
        video.push(pk(0, jump + i * (vDur / 4), vDur / 4));
      for (let i = 0; i < 4; i++)
        audio.push(pk(1, jump + i * (aDur / 4), aDur / 4));
    }
    const plan = buildTimelinePlan([video, audio]);
    const rb = createRebaser(plan);
    const outA = audio.map((p) => rebasePacket(rb, p));
    const outV = video.map((p) => rebasePacket(rb, p));
    expect(countDtsInversions(outA)).toBe(0);
    expect(countDtsInversions(outV)).toBe(0);
  });
});

describe('C2 — seam detection MUST NOT false-positive (project rule: a false kill is worse than a hang)', () => {
  it('packets with duration<=0 (timed-ID3) must not produce a seam', () => {
    // MEASURED: timed-ID3 tracks are very common in real HLS, emitting one duration=0 packet
    // per segment -> the old version produced 9 false seams.
    const s = 90_000;
    const meta = Array.from({ length: 10 }, (_, i) => pk(2, i * 12 * s, 0));
    expect(detectSeams(meta)).toEqual([]);
  });

  it('a legitimate audio silence gap must not chop a healthy video in half', () => {
    // MEASURED on the old version (case FP-4): video continuous for 59.96s + audio pauses for 30s
    // -> produced 1 seam -> video ended up only 30.02s. HALF THE VIDEO WAS LOST.
    const s = 90_000;
    const video = Array.from({ length: 60 }, (_, i) =>
      pk(0, i * s, s, i * s, TB90),
    );
    const audio = [
      ...Array.from({ length: 15 }, (_, i) => pk(1, i * s, s)),
      // 30s of silence then resumes — legitimate, not a discontinuity
      ...Array.from({ length: 15 }, (_, i) => pk(1, (45 + i) * s, s)),
    ];
    const plan = buildTimelinePlan([video, audio]);
    expect(plan.seams).toEqual([]);
    const outV = video.map((p) => applyPlan(p, plan));
    const span = (outV[outV.length - 1]!.dts! - outV[0]!.dts!) / s;
    expect(span).toBeCloseTo(59, 0);
  });
});

describe('applyPlan MUST REJECT when there is a seam (guard the trap instead of returning a wrong number)', () => {
  it('throws and points to the rebaser', () => {
    const plan = {
      seams: [{ atRawUs: 0, deltaUs: 1, detectedBy: 0 }],
      rebaseOffsetUs: 0,
    };
    expect(() => applyPlan(pk(0, 0, 90_000), plan)).toThrow(/rebasePacket/);
  });
  it('still runs normally when the plan has no seams', () => {
    expect(
      applyPlan(pk(0, 90_000, 90_000), {
        seams: [],
        rebaseOffsetUs: -1_000_000,
      }).dts,
    ).toBe(0);
  });
});

describe('Backward seam BELOW the threshold — case found while verifying against a real fixture', () => {
  // Not part of the adversarial-review list. Surfaced when reconstructing the "PTS reset to 0" case
  // from a REAL packet: the segment is only 3.56s long, so the backward jump (-3.56s) is SMALLER
  // than the 10s threshold.
  // A version using `Math.abs(delta) > threshold` doesn't count that as a seam -> the monotonic clamp
  // afterward compresses 90 packets into ~1ms: span stays 3.56s instead of 7.12s, NO DTS inversion,
  // NO error. Content disappears silently. That's why the seam-detection rule must be ASYMMETRIC.
  it('a small backward jump is still a seam; content does not get compressed', () => {
    const s = 90_000;
    const one = Array.from({ length: 90 }, (_, i) =>
      pk(0, Math.round(i * s * 0.04), Math.round(s * 0.04)),
    );
    const stream = [...one, ...one.map((p) => ({ ...p }))];
    const plan = buildTimelinePlan([stream]);
    expect(plan.seams).toHaveLength(1);
    expect(plan.seams[0]!.deltaUs).toBeLessThan(0);

    const rb = createRebaser(plan);
    const out = stream.map((p) => rebasePacket(rb, p));
    const dts = out.map((p) => p.dts!);
    const spanIn = (one[one.length - 1]!.dts! - one[0]!.dts!) / s;
    const spanOut = (Math.max(...dts) - Math.min(...dts)) / s;
    expect(spanOut).toBeCloseTo(spanIn * 2, 0); // must NOT equal spanIn
    expect(countDtsInversions(out)).toBe(0);
  });

  it('a FORWARD gap below the threshold is still NOT a seam (keeps the anti-false-positive guard)', () => {
    expect(isSeamDelta(5_000_000, 10_000_000)).toBe(false); // 5s forward gap: normal
    expect(isSeamDelta(11_000_000, 10_000_000)).toBe(true); // 11s forward gap: discontinuity
    expect(isSeamDelta(-100, 10_000_000)).toBe(true); // tiny backward jump: still a discontinuity
  });
});

/* ───────────── The STREAMING scanner must match the array version on ALL THREE fixed bugs ─────────────
 *
 * 🔴 MEASURED 2026-07-19: the previous adversarial-review round only fixed `buildTimelinePlan` (the
 * ARRAY-based version, used by tests), while `createSeamScanner`/`finishScan` — the version PRODUCTION
 * actually has to use because memory is bounded — still carried all three bugs. The three tests below
 * used to be ALL RED:
 *   S1 -> false seam at 30s (exactly bug FP-4: a healthy video gets cut in half)
 *   S2 -> offset 0 instead of −58667 (bug B2: using min first-DTS instead of min first-PTS)
 *   S3 -> 2 false seams (bug C3: two inputs sharing streamIndex 0 get their identities mixed up)
 * Lesson: "fixed" at the test layer does NOT mean "fixed" at the actually-running layer.
 */
describe('the streaming scanner must match the array version on ALL THREE fixed bugs', () => {
  const scanAll = (...lists: TimedPacket[][]) => {
    const sc = createSeamScanner();
    for (const l of lists) for (const p of l) scanTimestamp(sc, p);
    return finishScan(sc);
  };
  const TB90 = { num: 1, den: 90_000 };

  it('S1 (FP-4): a legitimate audio silence gap must NOT produce a seam', () => {
    const video: TimedPacket[] = Array.from({ length: 30 }, (_, i) => ({
      streamIndex: 0,
      pts: i * 180_000,
      dts: i * 180_000,
      duration: 180_000,
      timeBase: TB90,
      mediaType: 'video',
    }));
    const audio: TimedPacket[] = [0, 30, 31].map((s) => ({
      streamIndex: 1,
      pts: s * 90_000,
      dts: s * 90_000,
      duration: 90_000,
      timeBase: TB90,
      mediaType: 'audio' as const,
    }));
    expect(buildTimelinePlan([video, audio]).seams).toHaveLength(0);
    expect(scanAll(video, audio).seams).toHaveLength(0);
  });

  it('S2 (B2): the rebase marker is the min first-PTS, not the min first-DTS', () => {
    const video: TimedPacket[] = [
      {
        streamIndex: 0,
        pts: 7200,
        dts: 0,
        duration: 3000,
        timeBase: TB90,
        mediaType: 'video',
      },
    ];
    const audio: TimedPacket[] = [
      {
        streamIndex: 1,
        pts: 5280,
        dts: 5280,
        duration: 1920,
        timeBase: TB90,
        mediaType: 'audio',
      },
    ];
    const want = buildTimelinePlan([video, audio]);
    expect(want.rebaseOffsetUs).toBe(-58_667); // matches ffmpeg on the bf.ts fixture
    expect(scanAll(video, audio).rebaseOffsetUs).toBe(want.rebaseOffsetUs);
  });

  it('S3 (C3): two inputs that both have streamIndex 0 must NOT have their identities mixed up', () => {
    const video: TimedPacket[] = Array.from({ length: 30 }, (_, i) => ({
      streamIndex: 0,
      inputIndex: 0,
      pts: i * 180_000,
      dts: i * 180_000,
      duration: 180_000,
      timeBase: TB90,
      mediaType: 'video',
    }));
    const audio: TimedPacket[] = [0, 30, 31].map((s) => ({
      streamIndex: 0,
      inputIndex: 1,
      pts: s * 90_000,
      dts: s * 90_000,
      duration: 90_000,
      timeBase: TB90,
      mediaType: 'audio' as const,
    }));
    expect(buildTimelinePlan([video, audio]).seams).toHaveLength(0);
    expect(scanAll(video, audio).seams).toHaveLength(0);
  });
});

/* ───────────────── VFR/timelapse: declared `duration` is WRONG, but the content is healthy ─────────────────
 *
 * 🔴 MEASURED 2026-07-19 (adversarial review round, on the CURRENTLY running remux-time.ts): a
 * stream with frames REALLY spaced 15 seconds apart but where the demuxer declares
 * `r_frame_rate=25/1` -> each packet's `duration` = 0.04 s. `expected = dts + 0.04s` is wrong by
 * 14.96 s on EVERY packet -> **11 FALSE seams on 12 packets**, and after correction **165 seconds of
 * content shrinks to 0.44 seconds**. The file still has all 12 frames, still decodes cleanly,
 * `av_write_trailer` still returns 0 — no signal anywhere.
 *
 * The `duration <= 0` guard does NOT cover this case (here duration = 0.04 > 0). The fix: compare
 * the declared `duration` against the stream's own OBSERVED cadence; if it's off by more than 2x,
 * trust the cadence.
 */
describe('VFR/timelapse must NOT false-positive', () => {
  const TBV = { num: 1, den: 90_000 };
  const vfr: TimedPacket[] = Array.from({ length: 12 }, (_, i) => ({
    streamIndex: 0,
    pts: i * 15 * 90_000,
    dts: i * 15 * 90_000,
    duration: Math.round(0.04 * 90_000), // demuxer declares 25 fps, actually 1 frame/15s
    timeBase: TBV,
    mediaType: 'video',
  }));

  it('does not produce a false seam', () => {
    expect(buildTimelinePlan([vfr]).seams).toHaveLength(0);
  });

  it('does not compress away content (165s stays 165s, not 0.44s)', () => {
    const plan = buildTimelinePlan([vfr]);
    const rb = createRebaser(plan);
    const out = vfr.map((p) => rebasePacket(rb, p));
    const span = (out[out.length - 1]!.dts! - out[0]!.dts!) / 90_000;
    expect(span).toBeCloseTo(165, 1);
  });

  it('still catches a REAL discontinuity within that same VFR content', () => {
    // Same 15s cadence, but a 300s jump in the middle = a real ad break.
    const withSeam: TimedPacket[] = vfr.map((p, i) => ({
      ...p,
      pts: p.pts! + (i >= 6 ? 300 * 90_000 : 0),
      dts: p.dts! + (i >= 6 ? 300 * 90_000 : 0),
    }));
    expect(buildTimelinePlan([withSeam]).seams).toHaveLength(1);
  });
});
