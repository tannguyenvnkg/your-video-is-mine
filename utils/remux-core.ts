// Lõi remux libav.js: đọc packet từ device (đã gắn sẵn), chỉnh timestamp, ghi ra mp4.
//
// KHÔNG đụng chrome.*, KHÔNG đụng OPFS, KHÔNG đụng Worker — mọi thứ đó do bên gọi lo. Nhờ vậy
// file này chạy được nguyên vẹn dưới node để đối chiếu bitstream với ffmpeg thật.
//
// Chạy HAI LƯỢT trên cùng một input (device đọc được theo vị trí nên lượt 2 rẻ):
//   Lượt 1 — demux, chỉ giữ timestamp (SeamScanner: bộ nhớ O(số seam)), chốt TimelinePlan.
//   Lượt 2 — demux lại, áp plan cho từng packet rồi đẩy ngay sang muxer theo lô.
// Đổi một lần demux thêm để lấy bộ nhớ CÓ CHẶN TRÊN. Bản giữ hết packet trong RAM để sắp xếp
// đã ĐO: Node RSS 2,52 GB với input 163 MB — không dùng được.

import {
  createRebaser,
  createSeamScanner,
  finishScan,
  rebasePacket,
  readDts,
  readPts,
  scanTimestamp,
  numberToI64,
  type TimeBase,
  type TimedPacket,
  type TimelinePlan,
} from '@/utils/remux-time';

/* ────────────────────────── Bề mặt libav.js mà file này dùng ────────────────────────── */

/** Packet thô do libav.js trả về (cặp 32-bit cho mỗi int64). */
export interface LibavPacket {
  data: Uint8Array;
  stream_index: number;
  pts?: number;
  ptshi?: number;
  dts?: number;
  dtshi?: number;
  duration?: number;
  durationhi?: number;
  flags?: number;
  time_base_num?: number;
  time_base_den?: number;
}

export interface LibavStream {
  index: number;
  codec_type: number;
  codecpar: number;
  time_base_num: number;
  time_base_den: number;
}

/**
 * Chỉ khai đúng phần API đang dùng. Cố ý KHÔNG dùng `any`: nếu libav.js đổi chữ ký thì
 * TypeScript phải nói ra ở đây chứ không phải đợi tới lúc chạy.
 */
export interface LibavLike {
  AVERROR_EOF: number;
  EAGAIN: number;
  av_packet_alloc(): Promise<number>;
  av_packet_free_js?(pkt: number): Promise<void>;
  av_dict_set_js(
    dict: number,
    k: string,
    v: string,
    flags: number,
  ): Promise<number>;
  ff_init_demuxer_file(
    name: string,
    opts?: { open_input_options?: number },
  ): Promise<[number, LibavStream[]]>;
  avformat_close_input_js(ctx: number): Promise<void>;
  ff_read_frame_multi(
    ctx: number,
    pkt: number,
    opts?: { limit?: number },
  ): Promise<[number, Record<string, LibavPacket[]>]>;
  av_bsf_list_parse_str_js(str: string): Promise<number>;
  AVBSFContext_par_in(bsf: number): Promise<number>;
  AVBSFContext_par_out(bsf: number): Promise<number>;
  AVBSFContext_time_base_in_s(
    bsf: number,
    num: number,
    den: number,
  ): Promise<void>;
  avcodec_parameters_copy(dst: number, src: number): Promise<number>;
  av_bsf_init(bsf: number): Promise<number>;
  ff_bsf_multi(
    bsf: number,
    pkt: number,
    packets: LibavPacket[],
    eof: boolean,
  ): Promise<LibavPacket[]>;
  ff_init_muxer(
    opts: { filename: string; open: boolean; codecpars: boolean },
    streams: [number, number, number][],
  ): Promise<[number, number, number]>;
  ff_malloc_int32_list(list: number[]): Promise<number>;
  avformat_write_header(oc: number, options: number): Promise<number>;
  ff_write_multi(
    oc: number,
    pkt: number,
    packets: LibavPacket[],
  ): Promise<void>;
  av_write_trailer(oc: number): Promise<number>;
  ff_free_muxer(oc: number, pb: number): Promise<void>;

  // --- Device I/O. Bên gọi tự gắn device rồi mới gọi remux(); khai ở đây để cùng một
  // kiểu `LibavLike` dùng được cho cả worker lẫn harness node. ---
  /** Device đọc SEEK ĐƯỢC. PHẢI biết trước kích thước cuối cùng của file. */
  mkblockreaderdev(name: string, size: number): Promise<void>;
  ff_block_reader_dev_send(
    name: string,
    pos: number,
    data: Uint8Array | null,
  ): void;
  /** Device ghi seek được (mp4 muxer đòi output seek được; `mkstreamwriterdev` KHÔNG dùng được). */
  mkwriterdev(name: string): Promise<void>;
  onblockread?: (name: string, pos: number, len: number) => void;
  onwrite?: (name: string, pos: number, buf: Uint8Array) => void;
}

/* ────────────────────────── Hằng số libav ────────────────────────── */

const AVMEDIA_TYPE_VIDEO = 0;
const AVMEDIA_TYPE_AUDIO = 1;

/** Huỷ giữa chừng — bên gọi phân biệt với lỗi thật để báo 'cancelled' thay vì 'error'. */
export class RemuxCancelledError extends Error {
  constructor(message = 'Đã huỷ') {
    super(message);
    this.name = 'RemuxCancelledError';
  }
}

/* ────────────────────────── Tham số ────────────────────────── */

export interface RemuxInputSpec {
  /** Tên device đã gắn sẵn (mkblockreaderdev) — bên gọi tự gắn trước khi gọi remux(). */
  name: string;
  /** Lấy stream nào từ input này. 'any' = mọi stream (ca một playlist gộp cả hình lẫn tiếng). */
  kind: 'video' | 'audio' | 'any';
  /**
   * Có chạy bitstream filter `aac_adtstoasc` cho stream tiếng không.
   * ĐÚNG khi nguồn là MPEG-TS (AAC đóng khung ADTS, mp4 cần ASC); SAI với fMP4/CMAF —
   * ở đó AAC đã là ASC sẵn, chạy filter vào là hỏng. Bên gọi biết qua `parsed.hasInit`.
   */
  adtsToAsc?: boolean;
}

export interface RemuxOptions {
  inputs: readonly RemuxInputSpec[];
  /** Tên device ghi (mkwriterdev) đã gắn sẵn. */
  out: string;
  /**
   * Số byte đặt chỗ cho `moov` ở ĐẦU file (faststart).
   *   'auto' (mặc định) — tính từ SỐ PACKET ĐẾM ĐƯỢC Ở LƯỢT 1, xem `moovReserveForPackets`.
   *   0                 — không đặt chỗ, moov nằm CUỐI (luôn chạy được, chỉ mất faststart).
   *   số                — đặt cứng (dùng cho test và cho lần thử lại).
   *
   * 🔴 `-movflags +faststart` KHÔNG dùng được: lượt 2 của nó MỞ FILE RA ĐỌC LẠI, mà mọi
   * writer device của libav.js ném EIO khi đọc. Triệu chứng cực độc — vẫn ra file 25,799,252
   * byte nhưng `ffprobe` báo `moov atom not found`. Chỉ mã trả về của `av_write_trailer` mới lộ.
   */
  moovSizeBytes?: number | 'auto';
  /** Số packet mỗi lần gọi muxer (chặn trên bộ nhớ). */
  batch?: number;
  /** Trần byte mỗi lần `ff_read_frame_multi`. */
  readLimit?: number;
  thresholdSec?: number;
  /** 0..1, không giảm. */
  onProgress?: (fraction: number) => void;
  /** Đọc số byte đã đọc từ device (để tính tiến trình lượt 1). */
  getReadBytes?: () => number;
  /** Tổng byte input (để tính tiến trình lượt 1). */
  totalInputBytes?: number;
  isCancelled?: () => boolean;
  onLog?: (line: string) => void;
  /**
   * Lỗi mà callback ĐỒNG BỘ của device (`onwrite`/`onblockread`) đã chốt lại.
   *
   * 🔴 VÌ SAO CẦN: hai callback đó chạy đồng bộ qua ranh giới wasm, và một `throw` ở đó CÓ THỂ
   * BỊ NUỐT. Ca thật đã đo: OPFS hết quota -> `sah.write()` ném `QuotaExceededError`, file ghi
   * dở vẫn flush sạch, close sạch, đọc lại được, và KÍCH THƯỚC không phân biệt được với file
   * đủ. Nên bên gọi phải CHỐT lỗi vào một biến và ta hỏi lại ở đây — kể cả khi
   * `av_write_trailer` trả 0.
   */
  deviceError?: () => Error | null;
}

export interface RemuxResult {
  packetsWritten: number;
  packetsScanned: number;
  seams: number;
  rebaseOffsetUs: number;
  /** Mã trả về của `av_write_trailer`. < 0 nghĩa là moov đặt chỗ THIẾU (tràn đè mdat). */
  trailerCode: number;
  /** Số byte đã đặt chỗ cho moov (0 = không đặt chỗ, moov nằm cuối). */
  moovSize: number;
  plan: TimelinePlan;
}

/* ────────────────────────── Nội bộ ────────────────────────── */

interface OpenInput {
  ctx: number;
  streams: LibavStream[];
  spec: RemuxInputSpec;
  index: number;
}

function timeBaseOf(st: LibavStream): TimeBase {
  return { num: st.time_base_num, den: st.time_base_den };
}

function mediaTypeOf(st: LibavStream): 'video' | 'audio' | 'other' {
  if (st.codec_type === AVMEDIA_TYPE_VIDEO) return 'video';
  if (st.codec_type === AVMEDIA_TYPE_AUDIO) return 'audio';
  return 'other';
}

/** Gói packet thô của libav.js thành TimedPacket (đã ghép 64-bit) để đưa cho remux-time. */
function toTimed(
  p: LibavPacket,
  st: LibavStream,
  inputIndex: number,
): TimedPacket {
  const tb = timeBaseOf(st);
  return {
    streamIndex: p.stream_index,
    inputIndex,
    pts: readPts(p),
    dts: readDts(p),
    // duration cũng là int64 tách đôi; phần cao gần như luôn 0 nhưng đọc cho đủ.
    duration: (p.durationhi ?? 0) * 4294967296 + ((p.duration ?? 0) >>> 0),
    timeBase: tb,
    mediaType: mediaTypeOf(st),
  };
}

async function openInputs(
  libav: LibavLike,
  specs: readonly RemuxInputSpec[],
): Promise<OpenInput[]> {
  const out: OpenInput[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    let dict = 0;
    // Segment HLS đầu tiên có thể rất ngắn -> probe mặc định đoán sai codec. Nới rộng ra.
    dict = await libav.av_dict_set_js(dict, 'analyzeduration', '10000000', 0);
    dict = await libav.av_dict_set_js(dict, 'probesize', '10000000', 0);
    const [ctx, streams] = await libav.ff_init_demuxer_file(spec.name, {
      open_input_options: dict,
    });
    out.push({ ctx, streams, spec, index: i });
  }
  return out;
}

/** Stream nào của input nào được ánh xạ ra output (tương đương `-map 0:v:0 -map 1:a:0`). */
function selectStreams(inputs: readonly OpenInput[]): {
  input: OpenInput;
  stream: LibavStream;
  outIndex: number;
  bsf?: number;
}[] {
  const sel: { input: OpenInput; stream: LibavStream; outIndex: number }[] = [];
  for (const inp of inputs) {
    const want =
      inp.spec.kind === 'video'
        ? AVMEDIA_TYPE_VIDEO
        : inp.spec.kind === 'audio'
          ? AVMEDIA_TYPE_AUDIO
          : null;
    for (const st of inp.streams) {
      if (want !== null && st.codec_type !== want) continue;
      sel.push({ input: inp, stream: st, outIndex: sel.length });
      if (want !== null) break; // chỉ lấy stream ĐẦU TIÊN khớp loại
    }
  }
  return sel;
}

/**
 * Đọc hết mọi packet của mọi input, gọi `onPacket` cho từng cái.
 * `ff_read_frame_multi` trả packet GOM THEO STREAM (không theo thứ tự demux) — cả
 * SeamScanner lẫn Rebaser đều được thiết kế để không phụ thuộc thứ tự giữa các stream.
 */
async function pumpAll(
  libav: LibavLike,
  inputs: readonly OpenInput[],
  pkt: number,
  readLimit: number,
  onPacket: (
    p: LibavPacket,
    st: LibavStream,
    inp: OpenInput,
  ) => Promise<void> | void,
  isCancelled: () => boolean,
): Promise<void> {
  for (const inp of inputs) {
    for (;;) {
      if (isCancelled()) throw new RemuxCancelledError();
      const [res, groups] = await libav.ff_read_frame_multi(inp.ctx, pkt, {
        limit: readLimit,
      });
      for (const key of Object.keys(groups)) {
        for (const p of groups[key]!) {
          const st = inp.streams[p.stream_index];
          if (!st) continue; // stream không khai báo -> bỏ, muxer cũng không nhận
          await onPacket(p, st, inp);
        }
      }
      if (res === libav.AVERROR_EOF) break;
      if (res !== 0 && res !== -libav.EAGAIN) {
        throw new Error(`Đọc dữ liệu video lỗi (mã ${res}).`);
      }
      if (res === -libav.EAGAIN) {
        // Device tạm hết dữ liệu: nhường một nhịp cho callback nạp thêm.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }
}

/* ────────────────────────── Hàm chính ────────────────────────── */

export async function remux(
  libav: LibavLike,
  opts: RemuxOptions,
): Promise<RemuxResult> {
  const batch = opts.batch ?? 256;
  const readLimit = opts.readLimit ?? 1 << 20;
  const isCancelled = opts.isCancelled ?? (() => false);
  const log = opts.onLog ?? (() => undefined);

  let lastFraction = -1;
  const report = (f: number): void => {
    if (!opts.onProgress) return;
    const clamped = Math.max(0, Math.min(1, f));
    // Không giảm, và chỉ báo khi đổi ≥1% (badge chỉ hiển thị số nguyên phần trăm).
    if (clamped <= lastFraction || clamped - lastFraction < 0.01) return;
    lastFraction = clamped;
    opts.onProgress(clamped);
  };

  const pkt = await libav.av_packet_alloc();

  /* ---- LƯỢT 1: quét timestamp, chốt plan ---- */
  const scanner = createSeamScanner(opts.thresholdSec);
  let packetsScanned = 0;
  {
    const inputs = await openInputs(libav, opts.inputs);
    try {
      await pumpAll(
        libav,
        inputs,
        pkt,
        readLimit,
        (p, st, inp) => {
          scanTimestamp(scanner, toTimed(p, st, inp.index));
          packetsScanned++;
          if (opts.getReadBytes && opts.totalInputBytes) {
            report((0.5 * opts.getReadBytes()) / opts.totalInputBytes);
          }
        },
        isCancelled,
      );
    } finally {
      for (const inp of inputs) {
        try {
          await libav.avformat_close_input_js(inp.ctx);
        } catch {
          // dọn dẹp: nuốt lỗi, đừng che mất lỗi gốc
        }
      }
    }
  }
  const plan = finishScan(scanner);
  log(
    `lượt 1: ${packetsScanned} packet, ${plan.seams.length} chỗ nối, ` +
      `offset ${plan.rebaseOffsetUs}µs`,
  );
  report(0.5);

  /* ---- LƯỢT 2: mở lại, áp plan, ghi ra ---- */
  const inputs = await openInputs(libav, opts.inputs);
  const selected = selectStreams(inputs);
  if (selected.length === 0) {
    throw new Error('Không tìm thấy luồng hình/tiếng nào để ghép.');
  }

  // AAC trong MPEG-TS đóng khung ADTS; mp4 cần ASC -> bitstream filter. Chỉ dùng cho nguồn TS.
  const muxPars: [number, number, number][] = [];
  for (const s of selected) {
    let par = s.stream.codecpar;
    if (s.stream.codec_type === AVMEDIA_TYPE_AUDIO && s.input.spec.adtsToAsc) {
      const bsf = await libav.av_bsf_list_parse_str_js('aac_adtstoasc');
      // 🔴 KHÔNG được "thử, hỏng thì thôi". Bản mẫu để `s.bsf` trống khi init hỏng rồi chạy
      // tiếp: AAC dạng ADTS thô bị nhét thẳng vào MP4 -> hình chạy, TIẾNG HỎNG, không một
      // dòng lỗi ở đâu cả. Đó là con đường hỏng-im-lặng thứ tư mà phản biện đối kháng tìm ra.
      if (!bsf) {
        throw new Error('Không khởi tạo được bộ lọc tiếng (aac_adtstoasc).');
      }
      const parIn = await libav.AVBSFContext_par_in(bsf);
      await libav.avcodec_parameters_copy(parIn, s.stream.codecpar);
      await libav.AVBSFContext_time_base_in_s(
        bsf,
        s.stream.time_base_num,
        s.stream.time_base_den,
      );
      const initCode = await libav.av_bsf_init(bsf);
      if (initCode < 0) {
        throw new Error(
          `Không khởi tạo được bộ lọc tiếng aac_adtstoasc (mã ${initCode}).`,
        );
      }
      s.bsf = bsf;
      par = await libav.AVBSFContext_par_out(bsf);
    }
    muxPars.push([par, s.stream.time_base_num, s.stream.time_base_den]);
  }

  const [oc, , pb] = await libav.ff_init_muxer(
    { filename: opts.out, open: true, codecpars: true },
    muxPars,
  );

  let trailerCode: number;
  let packetsWritten = 0;
  let moovSize: number;
  try {
    // Đặt chỗ moov theo SỐ PACKET ĐÃ ĐẾM Ở LƯỢT 1 — không phải theo thời lượng đoán mò.
    // Đây là chỗ lượt 1 trả công: tới đây ta biết CHÍNH XÁC bao nhiêu packet sắp ghi, nên
    // không cần thời lượng từ manifest, không cần hằng số dự phòng, và không cần mux lại
    // lần hai để sửa. `moovSize` vẫn được trả về để bên gọi thử lại nếu trailer báo tràn.
    const wanted = opts.moovSizeBytes ?? 'auto';
    moovSize =
      wanted === 'auto'
        ? moovReserveForPackets(packetsScanned)
        : Math.floor(wanted);
    let muxOpts = 0;
    if (moovSize > 0) {
      muxOpts = await libav.av_dict_set_js(0, 'moov_size', String(moovSize), 0);
    }
    const optsPtr = await libav.ff_malloc_int32_list([muxOpts]);
    const wh = await libav.avformat_write_header(oc, optsPtr);
    if (wh < 0) throw new Error(`Không mở được tệp ra (mã ${wh}).`);

    const rebaser = createRebaser(plan, opts.thresholdSec);
    const byKey = new Map(
      selected.map((s) => [`${s.input.index}:${s.stream.index}`, s]),
    );
    let pending: LibavPacket[] = [];
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      // ff_write_multi dùng av_interleaved_write_frame -> muxer TỰ xen kẽ theo DTS.
      // Kiểu "đọc hết rồi tự sort" của bản thử là thừa, và chính nó gây 2,52GB RAM.
      await libav.ff_write_multi(oc, pkt, pending);
      const devErr = opts.deviceError?.();
      if (devErr) throw devErr;
      packetsWritten += pending.length;
      pending = [];
      if (packetsScanned > 0) {
        report(0.5 + (0.5 * packetsWritten) / packetsScanned);
      }
    };

    await pumpAll(
      libav,
      inputs,
      pkt,
      readLimit,
      async (p, st, inp) => {
        const sel = byKey.get(`${inp.index}:${p.stream_index}`);
        if (!sel) return; // stream không được map ra output
        const timed = rebasePacket(rebaser, toTimed(p, st, inp.index));
        const d = timed.dts === null ? null : numberToI64(timed.dts);
        const t = timed.pts === null ? null : numberToI64(timed.pts);
        const out: LibavPacket = {
          data: p.data,
          stream_index: sel.outIndex,
          ...(t ? { pts: t.lo, ptshi: t.hi } : { pts: p.pts, ptshi: p.ptshi }),
          ...(d ? { dts: d.lo, dtshi: d.hi } : { dts: p.dts, dtshi: p.dtshi }),
          flags: p.flags,
          duration: p.duration,
          durationhi: p.durationhi,
          time_base_num: st.time_base_num,
          time_base_den: st.time_base_den,
        };
        // 🔴 timebase 0 = muxer BỎ QUA phép quy đổi và diễn giải lại timestamp theo timebase
        // của output. Không ném ở đây thì nó thành sai giờ IM LẶNG. `ff_bsf_multi` không có
        // đường bù timebase như `ff_read_frame_multi`, nên phải tự canh.
        if (!out.time_base_num || !out.time_base_den) {
          throw new Error(
            `Packet thiếu timebase (stream ${p.stream_index}) — không ghép để tránh sai giờ.`,
          );
        }
        if (sel.bsf) {
          const filtered = await libav.ff_bsf_multi(sel.bsf, pkt, [out], false);
          for (const f of filtered) {
            f.stream_index = sel.outIndex;
            pending.push(f);
          }
        } else {
          pending.push(out);
        }
        if (pending.length >= batch) await flush();
      },
      isCancelled,
    );
    // Xả nốt bộ lọc (packet cuối có thể còn nằm trong bsf).
    for (const s of selected) {
      if (!s.bsf) continue;
      const tail = await libav.ff_bsf_multi(s.bsf, pkt, [], true);
      for (const f of tail) {
        f.stream_index = s.outIndex;
        pending.push(f);
      }
    }
    await flush();

    // 🔴 KHÔNG BAO GIỜ được bỏ qua mã này. Đặt chỗ moov THIẾU thì moov tràn đè lên mdat,
    // av_write_trailer trả -28, mà file vẫn nằm đó với kích thước trông rất hợp lý.
    // Bên gọi phải xử lý: đây là con đường ra file hỏng-im-lặng duy nhất còn lại.
    trailerCode = await libav.av_write_trailer(oc);
    // Hỏi lại lỗi đã chốt từ callback đồng bộ TRƯỚC khi ai đó kịp tin vào `trailerCode`.
    const devErr = opts.deviceError?.();
    if (devErr) throw devErr;
  } finally {
    try {
      await libav.ff_free_muxer(oc, pb);
    } catch {
      // dọn dẹp
    }
    for (const inp of inputs) {
      try {
        await libav.avformat_close_input_js(inp.ctx);
      } catch {
        // dọn dẹp
      }
    }
  }

  report(1);
  return {
    packetsWritten,
    packetsScanned,
    seams: plan.seams.length,
    rebaseOffsetUs: plan.rebaseOffsetUs,
    trailerCode,
    moovSize,
    plan,
  };
}

/* ────────────────────────── Đặt chỗ moov ────────────────────────── */

/** Phần cố định của moov (ftyp/mvhd/trak header/extradata) — đo được < 1 KiB, để 32 KiB cho rộng. */
const MOOV_FIXED_BYTES = 32 * 1024;
/** Byte mỗi packet. ĐO ĐƯỢC 5,4–15,5 (xem bảng dưới); 32 là dư ~2 lần kể cả khi lên co64. */
const MOOV_BYTES_PER_PACKET = 32;

/**
 * Số byte đặt chỗ cho moov, tính theo SỐ PACKET THẬT.
 *
 * ĐO ĐƯỢC 2026-07-19 (mux bằng ffmpeg 8.1 rồi đọc thẳng độ dài hộp `moov`):
 *   | fixture   | packet | moov (B) | B/packet |
 *   | bf.ts     |    864 |   10.349 |    11,98 |
 *   | multi.ts  |  1.445 |   16.898 |    11,69 |
 *   | part0.ts  |    289 |    4.466 |    15,45 |  <- cao nhất
 *   | cv.ts     |    300 |    4.215 |    14,05 |
 *   | ca.ts     |    564 |    3.028 |     5,37 |
 *   | slow.ts   |     12 |      851 |    70,92 |  <- phần CỐ ĐỊNH áp đảo, không phải xu hướng
 * Phần cố định thật < 1 KiB; để 32 KiB là thừa sức cho cả extradata HEVC.
 * Cộng thêm dự phòng cho ca file > 4 GB: `stco` (4 B/chunk) đổi thành `co64` (8 B/chunk).
 *
 * 🔴 CỐ Ý KHÔNG tính theo THỜI LƯỢNG. Công thức `256KiB + giây × 4096` chỉ mua được
 * ~300–330 packet/giây; nội dung fps cao hoặc nhiều luồng tiếng vượt ngưỡng đó là đặt chỗ
 * thiếu -> file hỏng. Tệ hơn, bản mẫu còn có `(durSec || 3600)`: không biết thời lượng +
 * stream dài hơn 1 giờ = chắc chắn thiếu. Mà thời lượng ở extension này lấy từ manifest HLS
 * — nguồn có thể vắng, có thể sai, có thể là playlist đang phát trực tiếp.
 * Số packet thì LƯỢT 1 ĐẾM ĐƯỢC CHÍNH XÁC trước khi ghi byte nào, nên không phải đoán,
 * và cũng không cần mux lại lần hai để sửa.
 *
 * 🔴 VÌ SAO KHÔNG ĐƯỢC PHÉP SAI: đặt chỗ thiếu cho ra file HỎNG MÀ TRÔNG NHƯ THẬT. ĐO ĐƯỢC
 * với 4096 B: `av_write_trailer` trả **-28**, file 632.021 B, hộp sau moov parse thành rác
 * (`½3rQ`, độ dài 3.467.318.835), decoder ném "Invalid NAL unit size" — NHƯNG
 * `ffprobe -show_entries format=duration` vẫn trả "12.032000" và **thoát mã 0**.
 * Nghĩa là KHÔNG có cách nào phát hiện bằng cách probe file. Chỉ mã trả về của
 * `av_write_trailer` mới lộ. Đừng bao giờ bỏ qua nó.
 */
export function moovReserveForPackets(packets: number): number {
  return (
    MOOV_FIXED_BYTES + Math.max(0, Math.ceil(packets)) * MOOV_BYTES_PER_PACKET
  );
}
