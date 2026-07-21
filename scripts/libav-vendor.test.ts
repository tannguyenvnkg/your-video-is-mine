import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Ratchet for the self-built libav.js bundle. Each assertion below corresponds to a bug that was
// ACTUALLY MEASURED, of the GREEN-but-silently-dead kind: tsc/eslint/vitest all miss it, only runtime reveals it.
// Don't loosen any of them without re-measuring.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'public/libav');

const VER = '6.9.8.1';
const VARIANT = 'ts2mp4d';
const loader = resolve(dist, `libav-${VER}-${VARIANT}.mjs`);
const factory = resolve(dist, `libav-${VER}-${VARIANT}.wasm.mjs`);
const wasm = resolve(dist, `libav-${VER}-${VARIANT}.wasm.wasm`);

describe('Self-built libav.js variant in public/libav', () => {
  it('has all three files, with the correct version name', () => {
    // The loader assembles the factory name itself from base + VER + CONFIG. Renaming a file =
    // the loader looks up a nonexistent URL and dies at runtime.
    expect(
      existsSync(loader),
      `Missing ${loader} — see public/libav/BUILD.md`,
    ).toBe(true);
    expect(existsSync(factory)).toBe(true);
    expect(existsSync(wasm)).toBe(true);
  });

  it('loader and factory are both ESM with `export default`', () => {
    // @ffmpeg/core was once mistakenly packaged as the UMD build: the @ffmpeg/ffmpeg worker is
    // type:"module" and loads via import(), which requires export default; the UMD build doesn't have one ->
    // .default is undefined -> HLS died 100% with not a single line of error. Don't let this recur with libav.
    expect(readFileSync(loader, 'utf8')).toContain('export default');
    expect(readFileSync(factory, 'utf8')).toContain('export default');
  });

  it('loader declares the correct VER and CONFIG that the file name depends on', () => {
    const src = readFileSync(loader, 'utf8');
    expect(src).toContain(`libav.VER="${VER}"`);
    expect(src).toContain(`libav.CONFIG="${VARIANT}"`);
  });

  it('carries the LGPL-2.1 license text — a legal obligation, not a formality', () => {
    // We ship a binary built from LGPL sources so we MUST include the license. @ffmpeg/core
    // previously shipped none at all, and that was a separate violation on top of the mislabeling.
    expect(existsSync(resolve(dist, 'LICENSE.txt'))).toBe(true);
    expect(readFileSync(resolve(dist, 'LICENSE.txt'), 'utf8')).toContain(
      'GNU LESSER GENERAL PUBLIC LICENSE',
    );
    expect(readFileSync(factory, 'utf8')).toContain(
      'GNU LESSER GENERAL PUBLIC LICENSE',
    );
  });

  it('config does NOT pull in any encoder or GPL component', () => {
    // The whole reason the W3.1 package exists: @ffmpeg/core is GPL because it links
    // libx264/libx265, whereas the extension only stream-copies and never calls any encoder.
    const components: string[] = JSON.parse(
      readFileSync(resolve(dist, 'config.json'), 'utf8'),
    );
    expect(components.filter((c) => c.startsWith('encoder-'))).toEqual([]);
    for (const gpl of ['libx264', 'libx265', 'libxvid', 'gpl']) {
      expect(components.some((c) => c.includes(gpl))).toBe(false);
    }
  });

  it('keeps two "seemingly unnecessary but mandatory" components — learned the hard way', () => {
    const components: string[] = JSON.parse(
      readFileSync(resolve(dist, 'config.json'), 'utf8'),
    );
    // decoder-aac: even though it's stream-copy only, without it find_stream_info returns
    // sample_rate=0/channels=0 -> the mp4 muxer dies with "sample rate not set" (divide by zero).
    expect(components).toContain('decoder-aac');
    // avbsf: without this fragment av_bsf_* isn't exported to JS, even though bsf was already
    // compiled into libavcodec.
    expect(components).toContain('avbsf');
    // demuxer-mpegts is the whole reason for the self-build: NO prebuilt npm variant has it.
    expect(components).toContain('demuxer-mpegts');
    expect(components).toContain('format-mp4');
  });
});
