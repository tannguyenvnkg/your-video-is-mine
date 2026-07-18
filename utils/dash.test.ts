import { describe, expect, it } from 'vitest';
import { parse as parseMpd } from 'mpd-parser';
import { parseDashManifest, parseDashSegments } from './dash';

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

  // ⚠️ Test này TRƯỚC ĐÂY ghim `uri` = file media ('…/video720.mp4') và giả định đó ĐÃ SAI —
  // review đối kháng W1.5 chỉ ra: mọi tầng dưới coi `variantUrl` là TÀI LIỆU MANIFEST và gọi
  // `res.text()` + parse trên nó, nên trả về .mp4 khiến chúng nuốt nguyên file video làm XML.
  // Danh tính track của DASH nằm ở `id`; `uri` chỉ cần chỉ đúng chỗ lấy manifest.
  it('uri của variant là MANIFEST, không phải file media', () => {
    expect(r.variants[0]!.uri).toBe('https://ex.com/dir/stream.mpd');
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

  // W1.5 XONG: `id` lấy từ Representation@id (attributes.NAME) -> phân biệt được dù uri trùng.
  it('variant phải có `id` riêng (lấy từ attributes.NAME)', () => {
    const ids = r.variants.map((v) => v.id);
    expect(ids).toEqual(['v720', 'v360']);
  });

  // ✅ W1.5 nửa sau: parseDashManifest nay đọc mediaGroups.AUDIO -> tiếng lộ ra cho popup chọn.
  it('kết quả phải lộ ra representation tiếng a128', () => {
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

describe('W7.1 — DASH khai DRM trong manifest thì phải DỪNG (ranh giới cứng §7)', () => {
  it('MPD có <ContentProtection> Widevine -> isProtected + nêu tên hãng', () => {
    const mpd = `<?xml version="1.0"?><MPD><Period><AdaptationSet mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="1" bandwidth="800000" width="640" height="360"/>
      </AdaptationSet></Period></MPD>`;
    const r = parseDashManifest(mpd, 'https://x/m.mpd');
    expect(r.isProtected).toBe(true);
    expect(r.drmSystems).toContain('Widevine');
  });

  it('MPD thường -> KHÔNG protected (đừng chặn oan video sạch)', () => {
    const mpd = `<?xml version="1.0"?><MPD><Period><AdaptationSet mimeType="video/mp4">
      <Representation id="1" bandwidth="800000" width="640" height="360"/>
      </AdaptationSet></Period></MPD>`;
    const r = parseDashManifest(mpd, 'https://x/m.mpd');
    expect(r.isProtected).toBe(false);
    expect(r.drmSystems).toEqual([]);
  });
});

// --- W1.5: id đụng nhau THẬT trên đường parse, không chỉ ở mức hàm ---------
// mpd-parser gom representation theo BaseURL rồi mới gộp theo id, nên hai AdaptationSet khai
// TRÙNG @id mà khác BaseURL thì sống sót thành hai playlist riêng. DASH cho phép điều này: @id
// chỉ cần duy nhất trong MỘT AdaptationSet. Thêm một @id đã mang sẵn dấu '#' đúng dạng ta sinh ra.
const MPD_DUP_IDS = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT30S" minBufferTime="PT2S">
 <Period>
  <AdaptationSet mimeType="video/mp4">
   <BaseURL>vidA/</BaseURL>
   <Representation id="a#2" bandwidth="2400000" width="1280" height="720" codecs="avc1.4d401f">
    <SegmentBase indexRange="0-100"/>
   </Representation>
  </AdaptationSet>
  <AdaptationSet mimeType="video/mp4">
   <BaseURL>vidB/</BaseURL>
   <Representation id="a" bandwidth="1200000" width="854" height="480" codecs="avc1.42c01e">
    <SegmentBase indexRange="0-100"/>
   </Representation>
  </AdaptationSet>
  <AdaptationSet mimeType="video/mp4">
   <BaseURL>vidC/</BaseURL>
   <Representation id="a" bandwidth="600000" width="640" height="360" codecs="avc1.42c01e">
    <SegmentBase indexRange="0-100"/>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>`;

describe('W1.5 DASH: @id trùng nhau giữa các AdaptationSet vẫn phải ra id duy nhất', () => {
  const r = parseDashManifest(MPD_DUP_IDS, 'https://ex.com/x/manifest.mpd');

  // Ghim ĐÚNG hậu quả người dùng thấy: trùng id = trùng key React = bấm một dòng sáng cả cụm.
  it('mọi variant có id riêng dù manifest khai @id trùng', () => {
    expect(r.variants).toHaveLength(3);
    expect(new Set(r.variants.map((v) => v.id)).size).toBe(3);
  });
});

// ===========================================================================
// W1.5 NỬA SAU — parseDashSegments: DASH tải được thật.
// Trả về ĐÚNG shape HlsSegmentsResult để dùng lại nguyên bộ máy fetch/mux của HLS.
// ===========================================================================

// Đa Period nhưng MỖI Period một init khác nhau -> ghép mù sẽ ra file hỏng ÂM THẦM.
const MPD_MULTI_INIT = MPD_MULTI_PERIOD;

// SegmentBase: mpd-parser trả về 0 segment, còn resolvedUri LÀ file media tải thẳng được.
const MPD_SEGMENT_BASE = MPD;

describe('W1.5 parseDashSegments — hình', () => {
  const r = parseDashSegments(MPD_TEMPLATE, TPL_BASE, 'v720');

  it('trả segment tuyệt đối đúng representation đã chọn', () => {
    expect(r.segments).toHaveLength(15);
    expect(r.segments[0]!.uri).toBe('https://ex.com/dir/v720/seg-1.m4s');
    expect(r.segments[0]!.duration).toBe(4);
  });

  it('init segment lấy từ segments[0].map', () => {
    expect(r.hasInit).toBe(true);
    expect(r.segments[0]!.initUri).toBe('https://ex.com/dir/v720/init.mp4');
  });

  it('DASH không có AES-128 kiểu HLS -> encryption none, không khoá', () => {
    expect(r.encryption).toBe('none');
    expect(r.isProtected).toBe(false);
    expect(r.segments[0]!.keyUri).toBeUndefined();
    expect(r.segments[0]!.keyMethod).toBeUndefined();
  });

  it('tổng thời lượng cộng từ segment', () => {
    expect(r.totalDuration).toBe(60);
  });

  // W1.4 — `discontinuityCount` là trường BẮT BUỘC của HlsSegmentsResult, nên DASH phải điền nó
  // luôn (một Period = không chỗ nối nào). Thiếu -> tầng trên đọc `undefined` rồi so sánh `> 0`
  // ra false: im lặng đúng kiểu §2.1 chứ không phải lỗi ồn ào.
  it('một Period -> discontinuityCount = 0 (không cảnh báo oan)', () => {
    expect(r.discontinuityCount).toBe(0);
  });

  // Chọn ĐÚNG representation, không phải cái đầu tiên gặp.
  it('chọn v360 thì ra segment của v360', () => {
    const r360 = parseDashSegments(MPD_TEMPLATE, TPL_BASE, 'v360');
    expect(r360.segments[0]!.uri).toBe('https://ex.com/dir/v360/seg-1.m4s');
  });
});

describe('W1.5 parseDashSegments — tiếng (DASH LUÔN tách tiếng)', () => {
  it('tra được representation tiếng theo id', () => {
    const r = parseDashSegments(MPD_TEMPLATE, TPL_BASE, 'a128');
    expect(r.segments).toHaveLength(15);
    expect(r.segments[0]!.uri).toBe('https://ex.com/dir/a128/seg-1.m4s');
    expect(r.segments[0]!.initUri).toBe('https://ex.com/dir/a128/init.mp4');
  });
});

describe('W1.5 parseDashManifest phải lộ tiếng ra cho popup chọn', () => {
  const r = parseDashManifest(MPD_TEMPLATE, TPL_BASE);

  it('mỗi variant mang danh sách rendition tiếng, đúng MỘT cái selected', () => {
    const rends = r.variants[0]!.audioRenditions;
    expect(rends).toBeDefined();
    expect(rends!.map((x) => x.id)).toEqual(['a128']);
    expect(rends!.filter((x) => x.selected)).toHaveLength(1);
  });
});

describe('W1.5 CHẶN TRUNG THỰC các ca ghép ra file hỏng âm thầm', () => {
  // Mỗi Period một init riêng: downloadTrack chỉ nạp init ĐẦU rồi nối mọi segment ra sau ->
  // ffmpeg vẫn nhận, job vẫn báo "xong", file thì SAI. Thà dừng và nói thẳng.
  it('đa Period init khác nhau -> nêu lý do không hỗ trợ, KHÔNG im lặng', () => {
    const r = parseDashSegments(
      MPD_MULTI_INIT,
      'https://ex.com/dir/multi.mpd',
      'v720',
    );
    expect(r.unsupportedReason).toBeTruthy();
    expect(r.unsupportedReason).toContain('Period');
  });

  // SegmentBase: 0 segment nhưng resolvedUri là file .mp4 tải thẳng được -> phải chỉ ra đường đó,
  // không được báo "playlist không có segment nào" (đúng chữ, sai hoàn toàn về nguyên nhân).
  it('SegmentBase -> chỉ ra URL tải thẳng thay vì báo rỗng khó hiểu', () => {
    const r = parseDashSegments(
      MPD_SEGMENT_BASE,
      'https://ex.com/dir/stream.mpd',
      '2',
    );
    expect(r.segments).toHaveLength(0);
    expect(r.directUrl).toBe('https://ex.com/dir/video720.mp4');
  });
});

describe('W1.5 tra id KHÔNG được trúng nhầm representation khi @id đụng nhau', () => {
  it('id đã tách bằng hậu tố thì tra đúng cái đã tách', () => {
    const m = parseDashManifest(MPD_DUP_IDS, 'https://ex.com/x/manifest.mpd');
    const ids = m.variants.map((v) => v.id);
    // Mỗi id phải tra ra ĐÚNG representation có uri riêng của nó.
    const uris = ids.map(
      (id) =>
        parseDashSegments(MPD_DUP_IDS, 'https://ex.com/x/manifest.mpd', id)
          .directUrl,
    );
    expect(new Set(uris).size).toBe(3);
  });
});

// ===========================================================================
// Review đối kháng W1.5 nửa sau bắt được — ĐÃ ĐO, không phải suy luận.
// ===========================================================================

// Đa Period nhưng template init nội suy ra CÙNG một URI (dạng SegmentTemplate phổ biến nhất).
// 🔬 ĐO THẬT ở mpd-parser@1.4.0: 2 Period -> 1 playlist, 4 segment, init duy nhất 1 cái, và
// media URI LẶP: seg-v0-1, seg-v0-2, seg-v0-1, seg-v0-2 (startNumber reset mỗi Period).
// => Guard "nhiều init khác nhau" KHÔNG bắn, và ghép mù cho ra CÙNG 10 giây nối hai lần,
//    đóng gói thành video 20 giây. ffmpeg nhận, job báo "xong". Hỏng ÂM THẦM.
const MPD_MULTI_PERIOD_SAME_INIT = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT20S" minBufferTime="PT2S">
 <Period id="p0" duration="PT10S">
  <AdaptationSet mimeType="video/mp4">
   <SegmentTemplate media="seg-$RepresentationID$-$Number$.m4s" initialization="init-$RepresentationID$.mp4" duration="5" startNumber="1" timescale="1"/>
   <Representation id="v0" bandwidth="100000" width="640" height="360" codecs="avc1.42c01e"/>
  </AdaptationSet>
 </Period>
 <Period id="p1" duration="PT10S">
  <AdaptationSet mimeType="video/mp4">
   <SegmentTemplate media="seg-$RepresentationID$-$Number$.m4s" initialization="init-$RepresentationID$.mp4" duration="5" startNumber="1" timescale="1"/>
   <Representation id="v0" bandwidth="100000" width="640" height="360" codecs="avc1.42c01e"/>
  </AdaptationSet>
 </Period>
</MPD>`;

describe('W1.5 đa Period phải bị chặn kể cả khi init GIỐNG nhau', () => {
  const r = parseDashSegments(
    MPD_MULTI_PERIOD_SAME_INIT,
    'https://x.test/m.mpd',
    'v0',
  );

  it('ghim hiện tượng đã đo: segment LẶP URL vì startNumber reset mỗi Period', () => {
    expect(r.segments).toHaveLength(4);
    expect(new Set(r.segments.map((s) => s.uri)).size).toBe(2);
  });

  it('phải nêu lý do không hỗ trợ, KHÔNG được ghép ra file lặp nội dung', () => {
    expect(r.unsupportedReason).toBeTruthy();
    expect(r.unsupportedReason).toContain('Period');
  });

  // W1.4 — ca "một Period -> 0" ở trên được thoả mãn bởi một số 0 CỨNG, nên tự nó không chứng
  // minh parseDashSegments có thật sự gọi countDiscontinuities. Ranh giới Period là chỗ nối THẬT,
  // nên đây là ca duy nhất buộc con số phải đến từ manifest.
  it('ranh giới Period là chỗ nối thật -> đếm ra 1 (không phải số 0 cứng)', () => {
    expect(r.discontinuityCount).toBe(1);
  });
});

describe('W1.5 DASH: uri của variant PHẢI là manifest, không phải file media', () => {
  // Mọi tầng dưới (estimate/spoof/offscreen) coi `variantUrl` là TÀI LIỆU MANIFEST và gọi
  // parse trên text của nó. Với SegmentBase, `resolvedUri` là file .mp4 -> trả về nó nghĩa là
  // tầng dưới fetch nguyên file video rồi `res.text()` nó và parse như XML. Định danh track của
  // DASH là `id`, nên uri KHÔNG cần mang thông tin gì khác ngoài chỗ lấy manifest.
  it('SegmentBase: uri vẫn là .mpd chứ không phải .mp4', () => {
    const m = parseDashManifest(MPD, 'https://ex.com/dir/stream.mpd');
    expect(m.variants[0]!.uri).toBe('https://ex.com/dir/stream.mpd');
  });

  it('SegmentTemplate: uri cũng là .mpd', () => {
    const m = parseDashManifest(MPD_TEMPLATE, TPL_BASE);
    expect(m.variants.every((v) => v.uri === TPL_BASE)).toBe(true);
  });
});

describe('W1.5 SegmentBase chưa tải được thì phải NÓI, không dẫn vào ngõ cụt', () => {
  it('nêu lý do đọc được thay vì để job chết với "không có segment nào"', () => {
    const r = parseDashSegments(MPD, 'https://ex.com/dir/stream.mpd', '2');
    expect(r.segments).toHaveLength(0);
    expect(r.unsupportedReason).toBeTruthy();
    // Vẫn giữ đường tải thẳng cho gói sau định tuyến sang progressive.
    expect(r.directUrl).toBe('https://ex.com/dir/video720.mp4');
  });
});
