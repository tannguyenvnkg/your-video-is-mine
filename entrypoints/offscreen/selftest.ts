import { MuxSession } from './libav-mux';
import { describeError } from '@/utils/errors';
import type { EngineSelfTestResponse } from '@/utils/messages';

/**
 * Self-test the mux engine.
 *
 * Runs the EXACT real path: load libav in a Worker, append one real MPEG-TS segment (18 KB,
 * bundled) into OPFS, mux to mp4, read back the size. Not just "wasm loaded" — it goes through
 * the full demux -> timestamp fixup -> muxer -> writer device -> OPFS pipeline.
 *
 * The old ffmpeg build made its test video with `-f lavfi testsrc`, i.e. using an ENCODER. This
 * libav.js build DELIBERATELY has no encoder at all (that's why it's only 1.56 MB and avoids GPL),
 * so the test had to switch to remux instead — and remux is actually what the extension does for real.
 */
export async function runEngineSelfTest(): Promise<EngineSelfTestResponse> {
  let session: MuxSession | null = null;
  try {
    session = await MuxSession.start('selftest');
    // ⚠️ `.bin` extension, NOT `.ts`: this is MPEG-TS, but `tsc` sees a `.ts` extension and treats
    // it as TypeScript, breaking `pnpm compile` immediately ("File appears to be binary").
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
