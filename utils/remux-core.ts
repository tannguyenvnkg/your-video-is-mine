// libav.js remux core: read packets from a device (already attached), fix up timestamps, write mp4.
//
// Does NOT touch chrome.*, does NOT touch OPFS, does NOT touch Worker — the caller handles all of
// that. This lets the file run unmodified under node to diff the bitstream against real ffmpeg.
//
// Runs TWO PASSES over the same input (the device is position-seekable so pass 2 is cheap):
//   Pass 1 — demux, keep only timestamps (SeamScanner: O(number of seams) memory), finalize the TimelinePlan.
//   Pass 2 — demux again, apply the plan to each packet and push straight to the muxer in batches.
// The tradeoff of an extra demux buys memory with an UPPER BOUND. The prototype that kept every
// packet in RAM for sorting was MEASURED: Node RSS 2.52 GB for a 163 MB input — not usable.

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

/* ────────────────────────── libav.js surface used by this file ────────────────────────── */

/** Raw packet returned by libav.js (32-bit pair for each int64). */
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
 * Only declares the API surface actually used. Deliberately NOT using `any`: if libav.js changes
 * a signature, TypeScript must flag it here rather than waiting until runtime.
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

  // --- Device I/O. The caller attaches the device before calling remux(); declared here so
  // the same `LibavLike` type works for both the worker and the node harness. ---
  /** SEEKABLE read device. MUST know the final file size in advance. */
  mkblockreaderdev(name: string, size: number): Promise<void>;
  ff_block_reader_dev_send(
    name: string,
    pos: number,
    data: Uint8Array | null,
  ): void;
  /** Seekable write device (the mp4 muxer requires a seekable output; `mkstreamwriterdev` does NOT work). */
  mkwriterdev(name: string): Promise<void>;
  onblockread?: (name: string, pos: number, len: number) => void;
  onwrite?: (name: string, pos: number, buf: Uint8Array) => void;
}

/* ────────────────────────── libav constants ────────────────────────── */

const AVMEDIA_TYPE_VIDEO = 0;
const AVMEDIA_TYPE_AUDIO = 1;

/** Mid-flight cancellation — the caller distinguishes this from a real error to report 'cancelled' instead of 'error'. */
export class RemuxCancelledError extends Error {
  constructor(message = 'Đã huỷ') {
    super(message);
    this.name = 'RemuxCancelledError';
  }
}

/* ────────────────────────── Parameters ────────────────────────── */

export interface RemuxInputSpec {
  /** Name of the already-attached device (mkblockreaderdev) — the caller attaches it before calling remux(). */
  name: string;
  /** Which stream to take from this input. 'any' = every stream (case: a single playlist mixing video and audio). */
  kind: 'video' | 'audio' | 'any';
  /**
   * Whether to run the `aac_adtstoasc` bitstream filter on the audio stream.
   * TRUE when the source is MPEG-TS (AAC framed as ADTS, mp4 needs ASC); FALSE for fMP4/CMAF —
   * there AAC is already ASC, running the filter would corrupt it. The caller knows via `parsed.hasInit`.
   */
  adtsToAsc?: boolean;
}

export interface RemuxOptions {
  inputs: readonly RemuxInputSpec[];
  /** Name of the already-attached write device (mkwriterdev). */
  out: string;
  /**
   * Number of bytes reserved for `moov` at the START of the file (faststart).
   *   'auto' (default) — computed from the PACKET COUNT MEASURED IN PASS 1, see `moovReserveForPackets`.
   *   0                 — no reservation, moov lands at the END (always works, just loses faststart).
   *   number            — hard-coded (used for tests and for a retry).
   *
   * 🔴 `-movflags +faststart` DOES NOT WORK here: its second pass RE-OPENS THE FILE FOR READING,
   * and every libav.js writer device throws EIO on read. The symptom is extremely quiet — it still
   * produces a 25,799,252-byte file but `ffprobe` reports `moov atom not found`. Only the return code
   * of `av_write_trailer` reveals it.
   */
  moovSizeBytes?: number | 'auto';
  /** Number of packets per muxer call (memory upper bound). */
  batch?: number;
  /** Byte ceiling per `ff_read_frame_multi` call. */
  readLimit?: number;
  thresholdSec?: number;
  /** 0..1, non-decreasing. */
  onProgress?: (fraction: number) => void;
  /** Read the number of bytes read so far from the device (to compute pass-1 progress). */
  getReadBytes?: () => number;
  /** Total input bytes (to compute pass-1 progress). */
  totalInputBytes?: number;
  isCancelled?: () => boolean;
  onLog?: (line: string) => void;
  /**
   * Error latched by the device's SYNCHRONOUS callback (`onwrite`/`onblockread`).
   *
   * 🔴 WHY THIS IS NEEDED: those two callbacks run synchronously across the wasm boundary, and a
   * `throw` there CAN BE SWALLOWED. Measured real case: OPFS ran out of quota -> `sah.write()`
   * threw `QuotaExceededError`, yet the partially written file still flushed cleanly, closed
   * cleanly, was readable again, and its SIZE was indistinguishable from a complete file. So the
   * caller must LATCH the error into a variable and we poll it here — even when
   * `av_write_trailer` returns 0.
   */
  deviceError?: () => Error | null;
}

export interface RemuxResult {
  packetsWritten: number;
  packetsScanned: number;
  seams: number;
  rebaseOffsetUs: number;
  /** Return code of `av_write_trailer`. < 0 means the moov reservation was TOO SMALL (overwrote mdat). */
  trailerCode: number;
  /** Number of bytes reserved for moov (0 = no reservation, moov at the end). */
  moovSize: number;
  plan: TimelinePlan;
}

/* ────────────────────────── Internal ────────────────────────── */

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

/** Wraps a raw libav.js packet into a TimedPacket (64-bit reassembled) for remux-time. */
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
    // duration is also a split int64; the high part is almost always 0 but read it fully anyway.
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
    // The first HLS segment can be very short -> default probing may guess the wrong codec. Widen it.
    dict = await libav.av_dict_set_js(dict, 'analyzeduration', '10000000', 0);
    dict = await libav.av_dict_set_js(dict, 'probesize', '10000000', 0);
    const [ctx, streams] = await libav.ff_init_demuxer_file(spec.name, {
      open_input_options: dict,
    });
    out.push({ ctx, streams, spec, index: i });
  }
  return out;
}

/** Which stream of which input is mapped to the output (equivalent to `-map 0:v:0 -map 1:a:0`). */
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
      if (want !== null) break; // only take the FIRST stream that matches the type
    }
  }
  return sel;
}

/**
 * Reads every packet of every input, calling `onPacket` for each one.
 * `ff_read_frame_multi` returns packets GROUPED BY STREAM (not demux order) — both
 * SeamScanner and Rebaser are designed to not depend on ordering across streams.
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
          if (!st) continue; // undeclared stream -> skip, the muxer wouldn't accept it either
          await onPacket(p, st, inp);
        }
      }
      if (res === libav.AVERROR_EOF) break;
      if (res !== 0 && res !== -libav.EAGAIN) {
        throw new Error(`Đọc dữ liệu video lỗi (mã ${res}).`);
      }
      if (res === -libav.EAGAIN) {
        // Device is temporarily out of data: yield a tick for the callback to feed more in.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }
}

/* ────────────────────────── Main function ────────────────────────── */

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
    // Non-decreasing, and only report when the change is ≥1% (the badge only shows whole percent).
    if (clamped <= lastFraction || clamped - lastFraction < 0.01) return;
    lastFraction = clamped;
    opts.onProgress(clamped);
  };

  const pkt = await libav.av_packet_alloc();

  /* ---- PASS 1: scan timestamps, finalize the plan ---- */
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
          // cleanup: swallow the error, don't mask the original one
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

  /* ---- PASS 2: reopen, apply the plan, write out ---- */
  const inputs = await openInputs(libav, opts.inputs);
  const selected = selectStreams(inputs);
  if (selected.length === 0) {
    throw new Error('Không tìm thấy luồng hình/tiếng nào để ghép.');
  }

  // AAC in MPEG-TS is framed as ADTS; mp4 needs ASC -> bitstream filter. Only used for TS sources.
  const muxPars: [number, number, number][] = [];
  for (const s of selected) {
    let par = s.stream.codecpar;
    if (s.stream.codec_type === AVMEDIA_TYPE_AUDIO && s.input.spec.adtsToAsc) {
      const bsf = await libav.av_bsf_list_parse_str_js('aac_adtstoasc');
      // 🔴 MUST NOT "try it, and if it fails just move on". The prototype left `s.bsf` empty when
      // init failed and kept going: raw ADTS-framed AAC got shoved straight into the MP4 -> video
      // plays, AUDIO IS BROKEN, not a single error anywhere. This is the fourth silent-failure path
      // that adversarial review found.
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
    // Reserve moov based on the PACKET COUNT MEASURED IN PASS 1 — not a guessed duration.
    // This is where pass 1 pays off: by this point we know EXACTLY how many packets are about to
    // be written, so no manifest duration is needed, no fallback constant is needed, and no
    // second remux is needed to fix it up. `moovSize` is still returned so the caller can retry if
    // the trailer reports an overflow.
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
      // ff_write_multi uses av_interleaved_write_frame -> the muxer interleaves by DTS ITSELF.
      // The "read everything then sort" approach of the prototype was unnecessary, and it's exactly
      // what caused the 2.52GB RAM usage.
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
        if (!sel) return; // stream is not mapped to the output
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
        // 🔴 timebase 0 = the muxer SKIPS the conversion and reinterprets the timestamp against
        // the output's timebase. Not throwing here would make it a SILENT timing corruption.
        // `ff_bsf_multi` has no timebase-compensation path like `ff_read_frame_multi`, so we must
        // guard it ourselves.
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
    // Flush the filter's remainder (the last packet may still be sitting inside the bsf).
    for (const s of selected) {
      if (!s.bsf) continue;
      const tail = await libav.ff_bsf_multi(s.bsf, pkt, [], true);
      for (const f of tail) {
        f.stream_index = s.outIndex;
        pending.push(f);
      }
    }
    await flush();

    // 🔴 This return code must NEVER be ignored. An UNDERSIZED moov reservation makes moov
    // overwrite mdat, av_write_trailer returns -28, yet the file still sits there with a size
    // that looks perfectly reasonable. The caller must handle it: this is the last remaining
    // silent-corruption path.
    trailerCode = await libav.av_write_trailer(oc);
    // Poll the error latched by the synchronous callback BEFORE anyone gets a chance to trust `trailerCode`.
    const devErr = opts.deviceError?.();
    if (devErr) throw devErr;
  } finally {
    try {
      await libav.ff_free_muxer(oc, pb);
    } catch {
      // cleanup
    }
    for (const inp of inputs) {
      try {
        await libav.avformat_close_input_js(inp.ctx);
      } catch {
        // cleanup
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

/* ────────────────────────── moov reservation ────────────────────────── */

/** Fixed part of moov (ftyp/mvhd/trak header/extradata) — measured < 1 KiB, use 32 KiB for headroom. */
const MOOV_FIXED_BYTES = 32 * 1024;
/** Bytes per packet. MEASURED 5.4–15.5 (see table below); 32 gives ~2x margin even when it upgrades to co64. */
const MOOV_BYTES_PER_PACKET = 32;

/**
 * Number of bytes to reserve for moov, computed from the ACTUAL PACKET COUNT.
 *
 * MEASURED 2026-07-19 (muxed with ffmpeg 8.1, then reading the `moov` box length directly):
 *   | fixture   | packet | moov (B) | B/packet |
 *   | bf.ts     |    864 |   10.349 |    11,98 |
 *   | multi.ts  |  1.445 |   16.898 |    11,69 |
 *   | part0.ts  |    289 |    4.466 |    15,45 |  <- highest
 *   | cv.ts     |    300 |    4.215 |    14,05 |
 *   | ca.ts     |    564 |    3.028 |     5,37 |
 *   | slow.ts   |     12 |      851 |    70,92 |  <- the FIXED part dominates, not a trend
 * The real fixed part is < 1 KiB; 32 KiB is plenty even for HEVC extradata.
 * Add margin for the > 4 GB file case: `stco` (4 B/chunk) upgrades to `co64` (8 B/chunk).
 *
 * 🔴 DELIBERATELY NOT computed from DURATION. The formula `256KiB + seconds × 4096` only buys
 * ~300–330 packets/second; high-fps content or many audio streams exceed that threshold, giving
 * an undersized reservation -> corrupted file. Worse, the prototype also had `(durSec || 3600)`:
 * unknown duration + a stream longer than 1 hour = guaranteed undersized. And in this extension
 * the duration comes from the HLS manifest — a source that can be missing, wrong, or a live
 * playlist. The packet count, on the other hand, is EXACTLY COUNTED BY PASS 1 before a single byte
 * is written, so it's not a guess, and no second mux is needed to fix it up.
 *
 * 🔴 WHY GETTING THIS WRONG IS UNACCEPTABLE: an undersized reservation produces a CORRUPTED FILE
 * THAT LOOKS FINE. MEASURED with 4096 B: `av_write_trailer` returns **-28**, file is 632,021 B,
 * the box after moov parses as garbage (`½3rQ`, length 3,467,318,835), the decoder throws
 * "Invalid NAL unit size" — YET `ffprobe -show_entries format=duration` still returns "12.032000"
 * and **exits with code 0**. Meaning there is NO way to detect this by probing the file. Only the
 * return code of `av_write_trailer` reveals it. Never ignore it.
 */
export function moovReserveForPackets(packets: number): number {
  return (
    MOOV_FIXED_BYTES + Math.max(0, Math.ceil(packets)) * MOOV_BYTES_PER_PACKET
  );
}
