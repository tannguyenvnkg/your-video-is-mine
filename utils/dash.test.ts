import { describe, expect, it } from 'vitest';
import { parse as parseMpd } from 'mpd-parser';
import { parseDashManifest } from './dash';

const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT30S" minBufferTime="PT2S">
 <Period>
  <AdaptationSet mimeType="video/mp4">
   <Representation id="1" bandwidth="1200000" width="640" height="360" codecs="avc1.42c01e">
    <BaseURL>video360.mp4</BaseURL>
    <SegmentBase indexRange="0-100"/>
   </Representation>
   <Representation id="2" bandwidth="2400000" width="1280" height="720" codecs="avc1.4d401f">
    <BaseURL>video720.mp4</BaseURL>
    <SegmentBase indexRange="0-100"/>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>`;

describe('parseDashManifest', () => {
  const r = parseDashManifest(MPD, 'https://ex.com/dir/stream.mpd');

  it('2 representation, sắp xếp giảm dần theo height', () => {
    expect(r.variants).toHaveLength(2);
    expect(r.variants[0]!.height).toBe(720);
    expect(r.variants[1]!.height).toBe(360);
  });

  it('resolvedUri tuyệt đối theo baseUrl của mpd', () => {
    expect(r.variants[0]!.uri).toBe('https://ex.com/dir/video720.mp4');
  });

  it('isMaster true khi có nhiều hơn 1 variant', () => {
    expect(r.isMaster).toBe(true);
  });
});

// ===========================================================================
// W0.4 — FIXTURE CA KHÓ (DASH). Fixture cũ ở trên dùng SegmentBase+BaseURL —
// đúng dạng DASH DUY NHẤT mà `resolvedUri` là file media thật. Dạng phổ biến
// nhất ngoài đời là SegmentTemplate, và ở đó resolvedUri CHÍNH LÀ file .mpd.
//
// Quy ước 3 lớp test giống utils/hls.test.ts: hợp đồng thư viện (xanh) /
// it.fails (đỏ thật, tự bật khi Đợt 1 sửa xong) / test canh.
// ===========================================================================

/** Shape mediaGroups.AUDIO đã ĐO THẬT ở mpd-parser@1.4.0. */
interface MpdAudioRendition {
  language?: string;
  default?: boolean;
  playlists?: {
    attributes?: { NAME?: string };
    segments?: { resolvedUri?: string }[];
  }[];
}

// --- Fixture: SegmentTemplate + AdaptationSet audio ----------------------
// DASH LUÔN LUÔN tách tiếng -> đây là ca chuẩn, không phải ngoại lệ.
const MPD_TEMPLATE = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT60S" minBufferTime="PT2S">
 <Period id="p0">
  <AdaptationSet mimeType="video/mp4" segmentAlignment="true">
   <SegmentTemplate media="$RepresentationID$/seg-$Number$.m4s" initialization="$RepresentationID$/init.mp4" duration="4" startNumber="1" timescale="1"/>
   <Representation id="v720" bandwidth="2400000" width="1280" height="720" codecs="avc1.4d401f"/>
   <Representation id="v360" bandwidth="800000" width="640" height="360" codecs="avc1.42c01e"/>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4" lang="en" segmentAlignment="true">
   <SegmentTemplate media="$RepresentationID$/seg-$Number$.m4s" initialization="$RepresentationID$/init.mp4" duration="4" startNumber="1" timescale="1"/>
   <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2" audioSamplingRate="48000"/>
  </AdaptationSet>
 </Period>
</MPD>`;
const TPL_BASE = 'https://ex.com/dir/stream.mpd';

describe('W0.4 hợp đồng mpd-parser: SegmentTemplate', () => {
  const m = parseMpd(MPD_TEMPLATE, { manifestUri: TPL_BASE });

  it('MỌI representation có resolvedUri = chính file .mpd (không phải media)', () => {
    // Đây là gốc rễ của "bấm 720p thì mọi dòng cùng sáng": uri không phân biệt nổi.
    expect(m.playlists!.map((p) => p.resolvedUri)).toEqual([
      TPL_BASE,
      TPL_BASE,
    ]);
    expect(m.playlists![0]!.uri).toBe('');
  });

  it('danh tính thật nằm ở attributes.NAME = id của Representation', () => {
    expect(m.playlists!.map((p) => p.attributes!.NAME)).toEqual([
      'v720',
      'v360',
    ]);
  });

  it('segment media THÌ có resolvedUri tuyệt đối (dữ liệu tải được nằm sẵn)', () => {
    const segs = m.playlists![0]!.segments as { resolvedUri?: string }[];
    expect(segs[0]!.resolvedUri).toBe('https://ex.com/dir/v720/seg-1.m4s');
    expect(segs).toHaveLength(15);
  });

  it('tiếng nằm ở mediaGroups.AUDIO[group][label].playlists[0].segments[]', () => {
    const mg = m.mediaGroups as {
      AUDIO?: Record<string, Record<string, MpdAudioRendition>>;
    };
    const en = mg.AUDIO!.audio!.en!;
    expect(en.language).toBe('en');
    expect(en.playlists![0]!.attributes!.NAME).toBe('a128');
    expect(en.playlists![0]!.segments![0]!.resolvedUri).toBe(
      'https://ex.com/dir/a128/seg-1.m4s',
    );
  });
});

describe('W0.4/W1.5 DASH SegmentTemplate -> variant không phân biệt nổi + mất tiếng', () => {
  const r = parseDashManifest(MPD_TEMPLATE, TPL_BASE);

  it('hiện trạng: 2 variant nhưng uri TRÙNG HỆT (chính là file .mpd)', () => {
    expect(r.variants).toHaveLength(2);
    expect(new Set(r.variants.map((v) => v.uri)).size).toBe(1);
    expect(r.variants[0]!.uri).toBe(TPL_BASE);
  });

  // ĐỎ hôm nay: VariantInfo chưa có `id` -> popup key theo uri -> React cảnh báo
  // trùng key, bấm "720p" thì mọi dòng cùng sáng.
  it.fails('variant phải có `id` riêng (lấy từ attributes.NAME)', () => {
    const ids = r.variants.map((v) => (v as unknown as { id?: string }).id);
    expect(ids).toEqual(['v720', 'v360']);
  });

  // ĐỎ hôm nay: parseDashManifest bỏ qua mediaGroups.AUDIO -> tiếng vô hình.
  it.fails('kết quả phải lộ ra representation tiếng a128', () => {
    expect(JSON.stringify(r)).toContain('a128');
  });

  // CANH: AdaptationSet tiếng KHÔNG được lẫn vào danh sách chất lượng hình.
  it('không được liệt kê tiếng như một mức chất lượng hình', () => {
    expect(r.variants.map((v) => v.height)).toEqual([720, 360]);
  });
});

// --- Fixture: DASH đa Period --------------------------------------------
// mpd-parser TỰ KHÂU nhiều Period thành MỘT playlist -> không cần xử lý riêng.
// NHƯNG ranh giới Period là một discontinuity thật, VÀ mỗi Period có init
// segment RIÊNG -> HlsSegment.initUri (một init duy nhất cho cả playlist)
// không diễn đạt nổi ca này.
const MPD_MULTI_PERIOD = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT20S" minBufferTime="PT2S">
 <Period id="p0" duration="PT10S">
  <AdaptationSet mimeType="video/mp4">
   <SegmentTemplate media="p0/$RepresentationID$-$Number$.m4s" initialization="p0/$RepresentationID$-init.mp4" duration="5" startNumber="1" timescale="1"/>
   <Representation id="v720" bandwidth="2400000" width="1280" height="720" codecs="avc1.4d401f"/>
  </AdaptationSet>
 </Period>
 <Period id="p1" duration="PT10S">
  <AdaptationSet mimeType="video/mp4">
   <SegmentTemplate media="p1/$RepresentationID$-$Number$.m4s" initialization="p1/$RepresentationID$-init.mp4" duration="5" startNumber="1" timescale="1"/>
   <Representation id="v720" bandwidth="2400000" width="1280" height="720" codecs="avc1.4d401f"/>
  </AdaptationSet>
 </Period>
</MPD>`;

describe('W0.4 hợp đồng mpd-parser: đa Period', () => {
  const m = parseMpd(MPD_MULTI_PERIOD, {
    manifestUri: 'https://ex.com/dir/multi.mpd',
  });
  const p = m.playlists![0]!;

  it('tự khâu 2 Period thành MỘT playlist 4 segment', () => {
    expect(m.playlists).toHaveLength(1);
    const segs = p.segments as { resolvedUri?: string }[];
    expect(segs.map((s) => s.resolvedUri)).toEqual([
      'https://ex.com/dir/p0/v720-1.m4s',
      'https://ex.com/dir/p0/v720-2.m4s',
      'https://ex.com/dir/p1/v720-1.m4s',
      'https://ex.com/dir/p1/v720-2.m4s',
    ]);
  });

  it('ranh giới Period LÀ một discontinuity thật (chỉ số 2)', () => {
    expect(p.discontinuityStarts).toEqual([2]);
    const segs = p.segments as { discontinuity?: boolean; timeline?: number }[];
    expect(segs[2]!.discontinuity).toBe(true);
    expect(segs.map((s) => s.timeline)).toEqual([0, 0, 10, 10]);
  });

  it('MỖI Period có init segment RIÊNG -> một initUri cho cả playlist là SAI', () => {
    const segs = p.segments as { map?: { resolvedUri?: string } }[];
    expect(segs.map((s) => s.map!.resolvedUri)).toEqual([
      'https://ex.com/dir/p0/v720-init.mp4',
      'https://ex.com/dir/p0/v720-init.mp4',
      'https://ex.com/dir/p1/v720-init.mp4',
      'https://ex.com/dir/p1/v720-init.mp4',
    ]);
  });
});
