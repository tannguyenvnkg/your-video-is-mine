// Test cho utils/remux-time.ts. Mọi con số kỳ vọng đều LẤY TỪ ĐO ĐẠC THẬT:
// ffmpeg 8.1 `-c copy` trên chính các fixture đó, và AVPacket thật của bản libav.js ts2mp4d.
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

/* ══════════════ 1. Biểu diễn 64-bit ══════════════ */
/** Lấy phần tử đầu, ném nếu rỗng — để test không phải rải `!` (noUncheckedIndexedAccess). */
function first<T>(xs: readonly T[]): T {
  const x = xs[0];
  if (x === undefined) throw new Error('mảng rỗng');
  return x;
}

describe('i64ToNumber — ghép cặp (lo, hi) của libav.js', () => {
  // Bảng này ĐO ĐƯỢC: ghi giá trị vào AVPacket thật qua AVPacket_pts_s/AVPacket_ptshi_s
  // rồi đọc lại bằng AVPacket_pts/AVPacket_ptshi. Word thấp trả về CÓ DẤU.
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

  it('KHÔNG được viết hi*2^32 + lo (dùng lo có dấu) — sai 6/15 ca đã đo', () => {
    // Chính là defect (ii). 2^31 với lo = -2147483648.
    const naive = 0 * 4294967296 + -2147483648;
    expect(naive).toBe(-2147483648);
    expect(i64ToNumber(-2147483648, 0)).toBe(2147483648);
    expect(i64ToNumber(-2147483648, 0)).not.toBe(naive);
  });

  it('i64ToBigInt khớp i64ToNumber trong vùng an toàn của Number', () => {
    for (const [, lo, hi, expected] of MEASURED) {
      expect(i64ToBigInt(lo, hi)).toBe(BigInt(expected));
    }
  });

  it('numberToI64 là nghịch đảo của i64ToNumber', () => {
    for (const [, lo, hi, v] of MEASURED) {
      const s = numberToI64(v);
      expect(i64ToNumber(s.lo, s.hi)).toBe(v);
      expect(s.lo).toBe(lo);
      expect(s.hi).toBe(hi);
    }
  });
});

describe('AV_NOPTS_VALUE', () => {
  it('nhận đúng cặp đã đo (lo=0, hi=-2147483648)', () => {
    expect(NOPTS_LO).toBe(0);
    expect(NOPTS_HI).toBe(-2147483648);
    expect(isNoPts(NOPTS_LO, NOPTS_HI)).toBe(true);
  });
  it('không nhận nhầm timestamp hợp lệ', () => {
    expect(isNoPts(0, 0)).toBe(false);
    expect(isNoPts(-2147483648, 0)).toBe(false); // đây là 2^31, KHÔNG phải NOPTS
  });
  it('readPts/readDts trả null cho NOPTS, số cho giá trị thật', () => {
    expect(readPts({ pts: NOPTS_LO, ptshi: NOPTS_HI })).toBeNull();
    expect(readDts({ dts: NOPTS_LO, dtshi: NOPTS_HI })).toBeNull();
    expect(readPts({ pts: -1, ptshi: 1 })).toBe(8589934591);
    expect(readDts({ dts: 128090, dtshi: 0 })).toBe(128090);
  });
});

/* ══════════════ 2. Đổi timebase ══════════════ */
describe('rescaleTs / toMicros / fromMicros', () => {
  it('90kHz -> micro giây', () => {
    expect(toMicros(90000, TB90)).toBe(1_000_000);
    expect(toMicros(126000, TB90)).toBe(1_400_000); // mốc audio đã đo của fixture
  });
  it('khứ hồi không trôi ở các mốc đã đo', () => {
    for (const v of [
      0, 2090, 126000, 128090, 7200128090, 2146943648, -540000,
    ]) {
      expect(fromMicros(toMicros(v, TB90), TB90)).toBe(v);
    }
  });
  it('làm tròn nửa-ra-xa-số-0 (giống av_rescale_q)', () => {
    expect(rescaleTs(1, { num: 1, den: 3 }, { num: 1, den: 2 })).toBe(1);
    expect(rescaleTs(-1, { num: 1, den: 3 }, { num: 1, den: 2 })).toBe(-1);
  });
});

/* ══════════════ 3. So sánh packet ══════════════ */
describe('comparePackets — PHẢI so trên giá trị 64-bit đã ghép', () => {
  it('xếp đúng thứ tự khi DTS vượt qua 2^31', () => {
    // ĐO ĐƯỢC trên fixture 2p31: word thấp nhảy +2147483647 -> -2147483648.
    const before = pk(0, 2147483647);
    const after = pk(0, 2147483648);
    expect(comparePackets(before, after)).toBeLessThan(0);
  });
  it('bản sai (so word thấp) sẽ đảo — đây là hồi quy cần chặn', () => {
    const loBefore = numberToI64(2147483647).lo;
    const loAfter = numberToI64(2147483648).lo;
    expect(loAfter - loBefore).toBeLessThan(0); // sai
    expect(comparePackets(pk(0, 2147483647), pk(0, 2147483648))).toBeLessThan(
      0,
    ); // đúng
  });
  it('quy về cùng timebase trước khi so', () => {
    const v = pk(0, 90000, 0, 90000, TB90); // 1,0 s
    const a = pk(1, 48000, 0, 48000, { num: 1, den: 48000 }); // 1,0 s
    expect(comparePackets(v, a)).toBeLessThan(0); // hoà -> phân giải theo streamIndex
  });
  it('ổn định: hoà thì theo streamIndex', () => {
    expect(comparePackets(pk(1, 100), pk(0, 100))).toBeGreaterThan(0);
  });
  it('countDtsInversions phát hiện DTS đi lùi', () => {
    expect(countDtsInversions([pk(0, 1), pk(0, 2), pk(0, 3)])).toBe(0);
    expect(countDtsInversions([pk(0, 1), pk(0, 5), pk(0, 3)])).toBe(1);
  });
});

/* ══════════════ 4. Kéo về 0 ══════════════ */
describe('computeRebaseOffsetUs — MỘT offset chung cho mọi stream', () => {
  it('dùng DTS nhỏ nhất TRÊN TOÀN BỘ stream, không phải của từng stream', () => {
    // ĐO ĐƯỢC: fixture chuẩn video=128090, audio=126000 -> offset -1400000 us.
    const off = computeRebaseOffsetUs([
      { streamIndex: 0, firstDts: 128090, timeBase: TB90 },
      { streamIndex: 1, firstDts: 126000, timeBase: TB90 },
    ]);
    expect(off).toBe(-1_400_000);
  });
  it('không có stream nào -> 0', () => {
    expect(computeRebaseOffsetUs([])).toBe(0);
  });
});

describe('buildTimelinePlan + applyPlan — kéo mốc về 0', () => {
  const mk = (v0: number, a0: number) => ({
    video: [pk(0, v0, 3000), pk(0, v0 + 3000, 3000)],
    audio: [pk(1, a0, 2089), pk(1, a0 + 2089, 2089)],
  });

  // ĐO ĐƯỢC: ffmpeg 8.1 -c copy cho 5 input này ra output GIỐNG HỆT NHAU
  // (video start_pts=2070, audio=0, 360/518 frame, duration 12.027937).
  // 2070 là 2090 sau khi MP4 lượng tử hoá theo movie timescale 1000.
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

  it('stream bắt đầu SỚM nhất về 0, không phải mọi stream đều về 0', () => {
    // ĐO ĐƯỢC trên fixture avoff: video 128090, audio 171000
    // -> ffmpeg cho video start_pts=0, audio start_time=0,476009 s.
    const { video, audio } = mk(128090, 171000);
    const plan = buildTimelinePlan([video, audio]);
    expect(applyPlan(first(video), plan).dts).toBe(0);
    expect(applyPlan(first(audio), plan).dts).toBe(42910); // 0,4767778 s
  });

  it('giữ nguyên quan hệ pts >= dts (an toàn với B-frame)', () => {
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

  it('bỏ qua pts/dts null mà không ném lỗi', () => {
    const v = pk(0, null, 3000, null);
    const plan = buildTimelinePlan([[pk(0, 90000, 3000)], [v]]);
    const o = applyPlan(v, plan);
    expect(o.dts).toBeNull();
    expect(o.pts).toBeNull();
  });
});

/* ══════════════ 5. ĐỒNG BỘ A/V ══════════════ */
describe('đồng bộ A/V — bất biến quan trọng nhất', () => {
  // Video và audio phải dịch CÙNG một offset. Kéo mỗi stream về 0 riêng sẽ
  // huỷ lệch A/V và không lỗi nào được ném ra.
  it.each([
    ['audio sớm 2090 tick', 128090, 126000, -2090],
    ['audio muộn 42910 tick', 128090, 171000, 42910],
    ['audio muộn 1 giây', 128090, 218090, 90000],
    ['PTS lớn, audio sớm', 7200128090, 7200126000, -2090],
    ['vượt 2^31, audio sớm', 2146943648, 2146941558, -2090],
    ['sau wrap (âm), audio sớm', -540000, -542090, -2090],
  ])('%s: lệch giữ nguyên TUYỆT ĐỐI 0 tick', (_n, v0, a0, skew) => {
    const video = [pk(0, v0, 3000), pk(0, v0 + 3000, 3000)];
    const audio = [pk(1, a0, 2089), pk(1, a0 + 2089, 2089)];
    const plan = buildTimelinePlan([video, audio]);
    const ov = applyPlan(first(video), plan).dts!;
    const oa = applyPlan(first(audio), plan).dts!;
    expect(a0 - v0).toBe(skew);
    expect(oa - ov).toBe(skew); // 0 tick trôi
  });

  it('KHÔNG được kéo từng stream về 0 riêng lẻ', () => {
    const video = [pk(0, 128090, 3000)];
    const audio = [pk(1, 171000, 2089)];
    const plan = buildTimelinePlan([video, audio]);
    expect(applyPlan(first(audio), plan).dts).not.toBe(0); // nếu bằng 0 là đã mất lệch 476 ms
  });
});

/* ══════════════ 6. GIÁN ĐOẠN ══════════════ */
describe('detectSeams', () => {
  it('không có gián đoạn -> không có seam', () => {
    const v = [pk(0, 0, 3000), pk(0, 3000, 3000), pk(0, 6000, 3000)];
    expect(detectSeams(v)).toHaveLength(0);
  });

  it('kỳ vọng phải là dts + duration, KHÔNG phải dts trước đó', () => {
    // ĐO ĐƯỢC: bỏ duration thì delta ra 3000003030 tick thay vì 3000000000
    // (dính thêm 3030 tick khoảng cách tự nhiên = 33,7 ms).
    const jump = 3_000_000_000;
    const v = [pk(0, 0, 3000), pk(0, 3000, 3000), pk(0, 6000 + jump, 3000)];
    const seams = detectSeams(v);
    expect(seams).toHaveLength(1);
    // 3000000000 tick @90kHz = 33333333333,33 us — KHÔNG chia hết. `expected` cộng dồn
    // duration đã làm tròn từng packet (33333 us mỗi cái) nên lệch dưới 1 us là ĐÚNG.
    // ffmpeg cũng ra đúng con số này: log của nó ghi "new offset= -33333333334".
    expect(seams[0]!.deltaUs).toBe(33_333_333_334);
    expect(
      Math.abs(seams[0]!.deltaUs - toMicros(jump, TB90)),
    ).toBeLessThanOrEqual(2);
  });

  it('nhảy nhỏ hơn ngưỡng KHÔNG phải seam', () => {
    const v = [
      pk(0, 0, 3000),
      pk(0, 3000, 3000),
      pk(0, 6000 + 90000 * 9, 3000),
    ]; // 9 s
    expect(detectSeams(v)).toHaveLength(0);
  });

  it('bắt cả nhảy LÙI (PTS tụt về)', () => {
    const v = [
      pk(0, 90000 * 100, 3000),
      pk(0, 90000 * 100 + 3000, 3000),
      pk(0, 0, 3000),
    ];
    const seams = detectSeams(v);
    expect(seams).toHaveLength(1);
    expect(seams[0]!.deltaUs).toBeLessThan(0);
  });

  it('nhiều seam (nhiều lần chèn quảng cáo)', () => {
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

describe('mergeSeams — MỘT seam dù nhiều stream cùng thấy', () => {
  // ⚠️ HỒI QUY ĐÃ TỪNG XẢY RA: bản đầu giữ offset chạy dần theo thứ tự nạp packet.
  // `ff_read_frame_multi` trả packet GOM THEO STREAM, nên video vá seam xong thì audio
  // vá LẠI chính seam đó -> offset -66666666678 us thay vì -33333333334 us (gấp đôi),
  // và output lệch 33333 s so với ffmpeg.
  it('seam của video và audio ở cùng chỗ chỉ tính MỘT lần', () => {
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

  it('stream tới trước chốt delta (khớp lựa chọn của ffmpeg)', () => {
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

  it('hai seam CÁCH XA nhau vẫn là hai seam', () => {
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
  it('trước seam: không hiệu chỉnh', () => {
    expect(correctionAtUs(1_400_000, [seam])).toBe(0);
  });
  it('sau seam: trừ đúng delta', () => {
    expect(correctionAtUs(33_340_756_556, [seam])).toBe(-33_333_333_334);
  });
  it('phân tách bằng TRUNG ĐIỂM nên mọi stream cùng phía dù lệch A/V', () => {
    const mid = seam.atRawUs - seam.deltaUs / 2;
    expect(correctionAtUs(mid - 1_000_000, [seam])).toBe(0);
    expect(correctionAtUs(mid + 1_000_000, [seam])).toBe(-seam.deltaUs);
  });
  it('nhiều seam cộng dồn', () => {
    const s2: Seam = {
      atRawUs: 66_000_000_000,
      deltaUs: 30_000_000_000,
      detectedBy: 0,
    };
    expect(correctionAtUs(70_000_000_000, [seam, s2])).toBe(-63_333_333_334);
  });
});

describe('gián đoạn đầu-cuối: file 12 s vẫn phải ra 12 s', () => {
  it('nuốt seam và giữ đồng bộ A/V', () => {
    // ĐO ĐƯỢC trên fixture disc: 3 segment đầu ở PTS thường, 3 segment sau nhảy
    // +3000000000 tick. TS thô báo duration 33345 s; ffmpeg -c copy vẫn ra 12,027937 s.
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
    expect(plan.seams).toHaveLength(1); // KHÔNG phải 2
    expect(plan.rebaseOffsetUs).toBe(-1_400_000);

    // Có seam -> BẮT BUỘC đi qua rebaser (applyPlan nay ném lỗi, cố ý).
    const rb = createRebaser(plan);
    const outV = video.map((p) => rebasePacket(rb, p).dts!);
    const outA = audio.map((p) => rebasePacket(rb, p).dts!);

    expect(countDtsInversions(outV.map((d) => pk(0, d)))).toBe(0);
    expect(countDtsInversions(outA.map((d) => pk(1, d)))).toBe(0);
    expect(outA[0]).toBe(0);
    expect(outV[0]).toBe(2090);
    // 12 s, không phải 9 tiếng
    expect((outV[outV.length - 1]! - outV[0]!) / 90000).toBeCloseTo(11.967, 3);
    // lệch A/V giữ nguyên qua seam
    expect(outA[259]! - outV[180]!).toBe(audio[259]!.dts! - video[180]!.dts!);
  });
});

/* ══════════════ 7. Quét theo luồng ══════════════ */
describe('SeamScanner — lượt 1 phải chạy với bộ nhớ O(số seam)', () => {
  // ĐO ĐƯỢC: giữ lại mọi TimedPacket tốn 65 B/packet -> phim 3 tiếng ~49 MB.
  // Scanner chỉ giữ seam nên không phụ thuộc độ dài phim.
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

  it('cho ra plan GIỐNG HỆT bản nhận mảng', () => {
    const { video, audio } = build();
    const sc = createSeamScanner();
    for (const p of video) scanTimestamp(sc, p);
    for (const p of audio) scanTimestamp(sc, p);
    expect(finishScan(sc)).toEqual(buildTimelinePlan([video, audio]));
  });

  it('không phụ thuộc thứ tự nạp GIỮA các stream', () => {
    const { video, audio } = build();
    const a = createSeamScanner();
    for (const p of video) scanTimestamp(a, p);
    for (const p of audio) scanTimestamp(a, p);
    const b = createSeamScanner();
    for (const p of audio) scanTimestamp(b, p);
    for (const p of video) scanTimestamp(b, p);
    expect(finishScan(a)).toEqual(finishScan(b)); // xen kẽ kiểu gì cũng vậy
  });

  it('bỏ qua packet không có timestamp', () => {
    const sc = createSeamScanner();
    scanTimestamp(sc, pk(0, null, 3000, null));
    expect(finishScan(sc).rebaseOffsetUs).toBe(0);
  });
});

/* ══════════════ 8. Chốt hằng số ══════════════ */
describe('hằng số', () => {
  it('TIME_BASE_US khớp AV_TIME_BASE của ffmpeg', () => {
    expect(TIME_BASE_US).toBe(1_000_000);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * LỖI DO PHẢN BIỆN ĐỐI KHÁNG TÌM RA (2026-07-19)
 *
 * Bốn ca dưới đây ĐỎ trên bản đầu tiên, dù bản đó đã có 60 test xanh VÀ đã qua
 * mutation test với 2 bản cố tình hỏng. Bài học: mutation test chứng minh test bắn
 * đúng theo Ý ĐỊNH, KHÔNG chứng minh ý định đúng.
 *
 * Điểm mù chung của bộ test cũ: mọi fixture đều `pts == dts` và mọi seam đều dấu DƯƠNG.
 * Ba trong bốn lỗi nằm ngoài đúng vùng đó. Đừng thu hẹp bộ fixture lại như cũ.
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('B1 — seam LÙI (PTS reset về 0): dạng gián đoạn HLS phổ biến NHẤT', () => {
  // Mỗi đoạn quảng cáo được mã hoá độc lập từ 0, nên seam LÙI mới là ca thường gặp,
  // không phải seam tiến. Bản cũ chỉ test PHÁT HIỆN được seam lùi; mọi test
  // correctionAtUs đều dùng delta DƯƠNG -> nhánh âm chưa từng chạy.
  //
  // 🔴 Và khi chạy thì lộ ra: seam lùi làm mốc thô TRƯỚC và SAU seam TRÙNG DẢI GIÁ TRỊ
  // (đều là 0..10s), nên KHÔNG hàm thuần theo-giá-trị nào phân biệt nổi. Vì vậy phải đi
  // qua `rebasePacket` (bám theo THỨ TỰ) chứ không phải `applyPlan`.
  const s = 90_000;
  const pre = Array.from({ length: 60 }, (_, i) => pk(0, i * s, s));
  const post = Array.from({ length: 10 }, (_, i) => pk(0, i * s, s));

  it('phát hiện đúng MỘT seam, độ lớn âm', () => {
    const plan = buildTimelinePlan([[...pre, ...post]]);
    expect(plan.seams).toHaveLength(1);
    expect(plan.seams[0]!.deltaUs).toBeLessThan(0);
  });

  it('70 giây nội dung ra đúng ~70 giây, không phải 120 giây', () => {
    // ĐO ĐƯỢC trên bản cũ: span 120,04s + còn 1 chỗ đảo DTS.
    const plan = buildTimelinePlan([[...pre, ...post]]);
    const rb = createRebaser(plan);
    const out = [...pre, ...post].map((p) => rebasePacket(rb, p));
    const dts = out.map((p) => p.dts!);
    const spanSec = (Math.max(...dts) - Math.min(...dts)) / s;
    expect(spanSec).toBeCloseTo(69, 0);
    expect(countDtsInversions(out)).toBe(0);
  });
});

describe('B2 — mốc rebase là min first-PTS, KHÔNG phải min first-DTS', () => {
  // Hai quy tắc chỉ trùng nhau khi pts == dts, mà toàn bộ fixture cũ đều vậy.
  // Có B-frame là lệch ngay. ĐO ĐƯỢC bằng ffmpeg -c copy trên fixture bf.ts:
  //   vào : video pts=7200 dts=0 | audio pts=dts=5280
  //   ffmpeg ra: offset -5280 tick -> video pts 1920 dts -5280, audio 0
  //   ffprobe format start_time = 0.058667 = first PTS của audio
  it('nội dung có B-frame: offset lấy theo PTS nhỏ nhất', () => {
    const video = [pk(0, 0, 3000, 7200)]; // dts 0 nhưng pts 7200
    const audio = [pk(1, 5280, 1024, 5280)];
    const plan = buildTimelinePlan([video, audio]);
    // min first-PTS = 5280 tick = 58666,67 µs -> offset âm chừng đó
    expect(plan.rebaseOffsetUs).toBeCloseTo(-58_667, 0);
    expect(applyPlan(video[0]!, plan).pts).toBe(1920);
    expect(applyPlan(video[0]!, plan).dts).toBe(-5280);
    expect(applyPlan(audio[0]!, plan).pts).toBe(0);
  });
});

describe('C1 — DTS phải ĐƠN ĐIỆU theo từng stream sau hiệu chỉnh', () => {
  // Lỗi nghiêm trọng nhất. Offset toàn cục do stream VIDEO chốt, nhưng biên segment
  // audio không trùng biên video (khung AAC 21,3ms; đo: video 4,000s vs audio 4,032s),
  // nên sau hiệu chỉnh audio CHỒNG LÊN CHÍNH NÓ.
  // av_interleaved_write_frame() TỪ CHỐI dts không đơn điệu -> mux lỗi/mất packet câm.
  it('audio lệch biên so với video: không được sinh ra chỗ đảo nào', () => {
    const s = 90_000;
    const vDur = 4 * s; // video 4,000s mỗi phần
    const aDur = Math.round(4.032 * s); // audio 4,032s — lệch biên, đúng như đo được
    const video: TimedPacket[] = [];
    const audio: TimedPacket[] = [];
    for (let part = 0; part < 3; part++) {
      const jump = part * 20_000 * s; // mỗi phần nhảy 20000s (quảng cáo)
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

describe('C2 — dò seam KHÔNG được báo động oan (luật dự án: giết oan tệ hơn treo)', () => {
  it('packet duration<=0 (timed-ID3) không được sinh seam', () => {
    // ĐO ĐƯỢC: luồng timed-ID3 rất phổ biến trong HLS thật, phát 1 packet
    // duration=0 mỗi segment -> bản cũ ra 9 seam giả.
    const s = 90_000;
    const meta = Array.from({ length: 10 }, (_, i) => pk(2, i * 12 * s, 0));
    expect(detectSeams(meta)).toEqual([]);
  });

  it('khoảng lặng audio HỢP LỆ không được cắt đôi video khoẻ', () => {
    // ĐO ĐƯỢC trên bản cũ (ca FP-4): video liên tục 59,96s + audio nghỉ 30s
    // -> sinh 1 seam -> video còn 30,02s. MẤT MỘT NỬA VIDEO.
    const s = 90_000;
    const video = Array.from({ length: 60 }, (_, i) =>
      pk(0, i * s, s, i * s, TB90),
    );
    const audio = [
      ...Array.from({ length: 15 }, (_, i) => pk(1, i * s, s)),
      // nghỉ 30s rồi hát tiếp — hợp lệ, không phải gián đoạn
      ...Array.from({ length: 15 }, (_, i) => pk(1, (45 + i) * s, s)),
    ];
    const plan = buildTimelinePlan([video, audio]);
    expect(plan.seams).toEqual([]);
    const outV = video.map((p) => applyPlan(p, plan));
    const span = (outV[outV.length - 1]!.dts! - outV[0]!.dts!) / s;
    expect(span).toBeCloseTo(59, 0);
  });
});

describe('applyPlan phải TỪ CHỐI khi có seam (chặn cái bẫy, không trả số sai)', () => {
  it('ném lỗi và chỉ sang rebaser', () => {
    const plan = {
      seams: [{ atRawUs: 0, deltaUs: 1, detectedBy: 0 }],
      rebaseOffsetUs: 0,
    };
    expect(() => applyPlan(pk(0, 0, 90_000), plan)).toThrow(/rebasePacket/);
  });
  it('vẫn chạy bình thường khi plan không có seam', () => {
    expect(
      applyPlan(pk(0, 90_000, 90_000), {
        seams: [],
        rebaseOffsetUs: -1_000_000,
      }).dts,
    ).toBe(0);
  });
});

describe('Seam LÙI DƯỚI NGƯỠNG — ca tự tìm ra khi kiểm chứng trên fixture thật', () => {
  // Không nằm trong danh sách phản biện. Lộ ra khi dựng lại ca "PTS reset về 0" từ packet
  // THẬT: đoạn chỉ dài 3,56s nên cú lùi (-3,56s) NHỎ HƠN ngưỡng 10s.
  // Bản dùng `Math.abs(delta) > ngưỡng` không coi đó là seam -> kẹp đơn điệu sau đó nén
  // 90 packet vào ~1ms: span giữ nguyên 3,56s thay vì 7,12s, KHÔNG đảo DTS, KHÔNG lỗi.
  // Nội dung mất sạch trong im lặng. Vì vậy luật dò seam phải BẤT ĐỐI XỨNG.
  it('cú lùi nhỏ vẫn là seam; nội dung không bị nén lại', () => {
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
    expect(spanOut).toBeCloseTo(spanIn * 2, 0); // KHÔNG được bằng spanIn
    expect(countDtsInversions(out)).toBe(0);
  });

  it('khoảng hở TIẾN dưới ngưỡng vẫn KHÔNG phải seam (giữ chống báo động oan)', () => {
    expect(isSeamDelta(5_000_000, 10_000_000)).toBe(false); // hở tiến 5s: bình thường
    expect(isSeamDelta(11_000_000, 10_000_000)).toBe(true); // hở tiến 11s: gián đoạn
    expect(isSeamDelta(-100, 10_000_000)).toBe(true); // lùi tí xíu: vẫn là gián đoạn
  });
});

/* ───────────── Scanner theo LUỒNG phải khớp bản mảng ở CẢ BA lỗi đã vá ─────────────
 *
 * 🔴 ĐO ĐƯỢC 2026-07-19: vòng phản biện trước chỉ vá `buildTimelinePlan` (bản nhận MẢNG,
 * dùng cho test), còn `createSeamScanner`/`finishScan` — bản mà PRODUCTION bắt buộc phải
 * dùng vì bộ nhớ có chặn trên — vẫn mang NGUYÊN cả ba lỗi. Ba test dưới đây từng ĐỎ hết:
 *   S1 -> seam giả ở 30s (đúng lỗi FP-4: video khoẻ bị cắt còn một nửa)
 *   S2 -> offset 0 thay vì −58667 (lỗi B2: lấy min first-DTS thay vì min first-PTS)
 *   S3 -> 2 seam giả (lỗi C3: hai input cùng streamIndex 0 lẫn danh tính nhau)
 * Bài học: "đã vá" ở tầng test KHÔNG có nghĩa là đã vá ở tầng chạy thật.
 */
describe('scanner theo luồng phải khớp bản mảng ở CẢ BA lỗi đã vá', () => {
  const scanAll = (...lists: TimedPacket[][]) => {
    const sc = createSeamScanner();
    for (const l of lists) for (const p of l) scanTimestamp(sc, p);
    return finishScan(sc);
  };
  const TB90 = { num: 1, den: 90_000 };

  it('S1 (FP-4): khoảng lặng audio hợp lệ KHÔNG được sinh seam', () => {
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

  it('S2 (B2): mốc rebase lấy min first-PTS, không phải min first-DTS', () => {
    const video: TimedPacket[] = [
      { streamIndex: 0, pts: 7200, dts: 0, duration: 3000, timeBase: TB90, mediaType: 'video' },
    ];
    const audio: TimedPacket[] = [
      { streamIndex: 1, pts: 5280, dts: 5280, duration: 1920, timeBase: TB90, mediaType: 'audio' },
    ];
    const want = buildTimelinePlan([video, audio]);
    expect(want.rebaseOffsetUs).toBe(-58_667); // khớp ffmpeg trên fixture bf.ts
    expect(scanAll(video, audio).rebaseOffsetUs).toBe(want.rebaseOffsetUs);
  });

  it('S3 (C3): hai input đều có streamIndex 0 thì KHÔNG được lẫn danh tính', () => {
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

/* ───────────────── VFR / timelapse: `duration` khai báo SAI, nội dung thì lành ─────────────────
 *
 * 🔴 ĐO ĐƯỢC 2026-07-19 (vòng phản biện đối kháng, bản remux-time.ts ĐANG chạy):
 * stream có khung cách nhau THẬT 15 giây nhưng demuxer khai `r_frame_rate=25/1` -> mỗi packet
 * `duration` = 0,04 s. `expected = dts + 0,04s` sai 14,96 s ở MỌI packet -> **11 seam GIẢ trên
 * 12 packet**, và sau hiệu chỉnh thì **165 giây nội dung còn 0,44 giây**. File vẫn đủ 12 khung,
 * vẫn decode sạch, `av_write_trailer` vẫn trả 0 — không một tín hiệu nào.
 *
 * Guard `duration <= 0` KHÔNG che được ca này (ở đây duration = 0,04 > 0). Cách vá: so
 * `duration` khai báo với NHỊP QUAN SÁT ĐƯỢC của chính stream; lệch quá 2 lần thì tin nhịp.
 */
describe('VFR/timelapse KHÔNG được báo động oan', () => {
  const TBV = { num: 1, den: 90_000 };
  const vfr: TimedPacket[] = Array.from({ length: 12 }, (_, i) => ({
    streamIndex: 0,
    pts: i * 15 * 90_000,
    dts: i * 15 * 90_000,
    duration: Math.round(0.04 * 90_000), // demuxer khai 25 fps, thực tế 1 khung/15s
    timeBase: TBV,
    mediaType: 'video',
  }));

  it('không sinh seam giả', () => {
    expect(buildTimelinePlan([vfr]).seams).toHaveLength(0);
  });

  it('không nén mất nội dung (165s vẫn là 165s, không phải 0,44s)', () => {
    const plan = buildTimelinePlan([vfr]);
    const rb = createRebaser(plan);
    const out = vfr.map((p) => rebasePacket(rb, p));
    const span = (out[out.length - 1]!.dts! - out[0]!.dts!) / 90_000;
    expect(span).toBeCloseTo(165, 1);
  });

  it('vẫn bắt được gián đoạn THẬT trên chính nội dung VFR đó', () => {
    // Cùng nhịp 15s, nhưng nhảy vọt 300s ở giữa = quảng cáo thật.
    const withSeam: TimedPacket[] = vfr.map((p, i) => ({
      ...p,
      pts: p.pts! + (i >= 6 ? 300 * 90_000 : 0),
      dts: p.dts! + (i >= 6 ? 300 * 90_000 : 0),
    }));
    expect(buildTimelinePlan([withSeam]).seams).toHaveLength(1);
  });
});
