import { describe, expect, it } from 'vitest';
import { Parser } from 'm3u8-parser';
import {
  childUrlsOfMaster,
  countDiscontinuities,
  parseHlsManifest,
  parseHlsSegments,
  resolveUri,
  spoofTargetsFromSegments,
  uniqueVariantId,
  variantLabel,
} from './hls';

describe('W1.5 uniqueVariantId — danh tính variant không được đụng nhau', () => {
  it('dùng tên tự nhiên khi có, chỉ số khi không', () => {
    const used = new Set<string>();
    expect(uniqueVariantId('v720', 0, used)).toBe('v720');
    expect(uniqueVariantId(undefined, 1, used)).toBe('v1');
    // Chuỗi rỗng/khoảng trắng KHÔNG phải danh tính -> phải rơi về chỉ số.
    expect(uniqueVariantId('   ', 2, used)).toBe('v2');
  });

  // DASH chỉ đòi Representation@id duy nhất TRONG một AdaptationSet -> hai AdaptationSet
  // vẫn có thể cùng khai id="1". Đụng nhau mà giữ nguyên là tái lập đúng con bug đang sửa.
  it('đụng tên thì tách ra bằng chỉ số, không bao giờ trả trùng', () => {
    const used = new Set<string>();
    const ids = ['1', '1', '1'].map((n, i) => uniqueVariantId(n, i, used));
    expect(ids).toEqual(['1', '1#1', '1#2']);
    expect(new Set(ids).size).toBe(3);
  });

  // Review đối kháng W1.5 bắt được: nhánh né trùng `${base}#${index}` trước đây KHÔNG tự soi lại
  // `used`, nên một Representation@id có sẵn dấu '#' đúng dạng đó vẫn nặn ra id TRÙNG.
  // ISO 23009-1 §5.3.5.2 chỉ cấm khoảng trắng trong @id -> '#' là hợp lệ, không phải input bịa.
  // Đây là bất biến của cả gói W1.5, không phải chi tiết cài đặt: trùng id = trùng key React =
  // đúng con bug "bấm một dòng sáng cả cụm" mà gói này sinh ra để diệt.
  it('tên có sẵn dạng "base#index" cũng KHÔNG được đụng id sinh ra', () => {
    const used = new Set<string>();
    const ids = ['a#2', 'a', 'a'].map((n, i) => uniqueVariantId(n, i, used));
    expect(new Set(ids).size).toBe(3);
  });

  it('kẹt nhiều tầng vẫn phải ra id duy nhất', () => {
    const used = new Set<string>();
    const names = ['x#1', 'x#1#2', 'x', 'x', 'x'];
    const ids = names.map((n, i) => uniqueVariantId(n, i, used));
    expect(new Set(ids).size).toBe(names.length);
  });
});

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
hi/index.m3u8`;

const MEDIA_AES = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001
#EXTINF:9.9,
seg0.ts
#EXTINF:9.9,
seg1.ts
#EXT-X-ENDLIST`;

describe('parseHlsManifest - master', () => {
  const r = parseHlsManifest(MASTER, 'https://cdn.example.com/dir/master.m3u8');

  it('isMaster true, 2 variant', () => {
    expect(r.isMaster).toBe(true);
    expect(r.variants).toHaveLength(2);
  });

  it('sắp xếp giảm dần theo height (720 trước 360)', () => {
    expect(r.variants[0]!.height).toBe(720);
    expect(r.variants[1]!.height).toBe(360);
  });

  it('resolve uri tuyệt đối theo baseUrl', () => {
    expect(r.variants[0]!.uri).toBe(
      'https://cdn.example.com/dir/hi/index.m3u8',
    );
  });

  it('label dạng "<height>p" và có bandwidth/codecs', () => {
    expect(r.variants[0]!.name).toBe('720p');
    expect(r.variants[0]!.bandwidth).toBe(2560000);
    expect(r.variants[0]!.codecs).toContain('avc1');
  });
});

describe('parseHlsManifest - media playlist', () => {
  const r = parseHlsManifest(
    MEDIA_AES,
    'https://cdn.example.com/dir/index.m3u8',
  );

  it('isMaster false, 1 "variant" trỏ chính nó', () => {
    expect(r.isMaster).toBe(false);
    expect(r.variants).toHaveLength(1);
    expect(r.variants[0]!.uri).toBe('https://cdn.example.com/dir/index.m3u8');
  });

  it('đếm đúng số segment', () => {
    expect(r.segmentCount).toBe(2);
  });

  it('nhận diện AES-128 nhưng KHÔNG coi là protected (không phải DRM)', () => {
    expect(r.keyMethod).toBe('AES-128');
    expect(r.isProtected).toBe(false);
  });
});

describe('helpers', () => {
  it('resolveUri ghép tương đối -> tuyệt đối', () => {
    expect(resolveUri('a/b.m3u8', 'https://x.com/dir/master.m3u8')).toBe(
      'https://x.com/dir/a/b.m3u8',
    );
  });

  it('variantLabel fallback kbps rồi "Gốc"', () => {
    expect(variantLabel(720)).toBe('720p');
    expect(variantLabel(undefined, 800000)).toBe('800 kbps');
    expect(variantLabel(undefined, undefined)).toBe('Gốc');
  });
});

describe('parseHlsSegments', () => {
  const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=AES-128,URI="https://k.example.com/key.bin"
#EXTINF:9.0,
seg10.ts
#EXTINF:9.0,
seg11.ts
#EXT-X-ENDLIST`;
  const r = parseHlsSegments(MEDIA, 'https://cdn.example.com/dir/index.m3u8');

  it('2 segment, uri tuyệt đối, seq theo media-sequence', () => {
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]!.uri).toBe('https://cdn.example.com/dir/seg10.ts');
    expect(r.segments[0]!.seq).toBe(10);
    expect(r.segments[1]!.seq).toBe(11);
  });

  it('AES-128: encryption aes-128, KHÔNG protected, key uri tuyệt đối, IV không khai báo', () => {
    expect(r.encryption).toBe('aes-128');
    expect(r.isProtected).toBe(false);
    expect(r.segments[0]!.keyUri).toBe('https://k.example.com/key.bin');
    expect(r.segments[0]!.iv).toBeUndefined();
  });

  it('tổng thời lượng', () => {
    expect(r.totalDuration).toBeCloseTo(18);
  });

  it('SAMPLE-AES -> isProtected (DỪNG, không hỗ trợ)', () => {
    const p = parseHlsSegments(
      `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"
#EXTINF:6,
s.ts
#EXT-X-ENDLIST`,
      'https://a.com/i.m3u8',
    );
    expect(p.encryption).toBe('sample-aes');
    expect(p.isProtected).toBe(true);
  });

  it('không mã hoá -> encryption none, seq bắt đầu 0', () => {
    const p = parseHlsSegments(
      `#EXTM3U
#EXTINF:5,
a.ts
#EXTINF:5,
b.ts
#EXT-X-ENDLIST`,
      'https://a.com/i.m3u8',
    );
    expect(p.encryption).toBe('none');
    expect(p.isProtected).toBe(false);
    expect(p.segments[0]!.seq).toBe(0);
  });
});

// ===========================================================================
// W0.4 — FIXTURE CA KHÓ. Fixture cũ ở trên chỉ mã hoá ca DỄ (master muxed,
// segment không byterange, không discontinuity) — đúng dạng duy nhất mà các
// lỗi Đợt 1 là vô hại. Đó là lý do test xanh trong khi sản phẩm câm.
//
// Ba lớp test dưới đây, đọc kèm nhau:
//
//  1. "hợp đồng thư viện" — XANH ngay. Chứng minh dữ liệu CÓ SẴN trong
//     m3u8-parser và ta đang vứt đi. Nếu lớp này đỏ => parser đổi shape,
//     KHÔNG phải lỗi của ta => đọc lại trước khi sửa code mình.
//
//  2. it.fails(...) — lỗi THẬT, ĐỎ hôm nay. Vitest coi "đỏ" là ĐẠT nên cả
//     suite vẫn xanh (cổng §1.2). Khi Đợt 1 sửa xong, test chuyển sang xanh
//     => it.fails FAIL NGƯỢC => buộc phải đổi lại thành it(). Chốt tự bật,
//     không phải TODO chết.
//     ⚠️ it.fails đạt khi test ném BẤT KỲ lỗi gì => nó KHÔNG phân biệt được
//     "đỏ vì thiếu tính năng" với "đỏ vì làm sai". Vì vậy mỗi it.fails chỉ
//     mang ĐÚNG MỘT khẳng định, và luôn có test canh (lớp 3) đi kèm.
//
//  3. test canh — XANH ngay (vì hiện chưa có tiếng nên đúng một cách rỗng),
//     XANH sau khi sửa ĐÚNG, và ĐỎ nếu sửa SAI. Đây là thứ bắt bản sửa ngây thơ.
// ===========================================================================

/** Manifest thô từ m3u8-parser (để test hợp đồng thư viện). */
function rawManifest(text: string) {
  const p = new Parser();
  p.push(text);
  p.end();
  return p.manifest;
}

/** Shape mediaGroups.AUDIO đã ĐO THẬT ở m3u8-parser@7.2.0 (không phải suy đoán). */
interface AudioRendition {
  default: boolean;
  autoselect: boolean;
  language?: string;
  /** VẮNG HẲN (không phải undefined) khi #EXT-X-MEDIA không có URI. */
  uri?: string;
}
type AudioGroups = Record<string, Record<string, AudioRendition>>;

function audioGroups(text: string): AudioGroups {
  const mg = rawManifest(text).mediaGroups as
    { AUDIO?: AudioGroups } | undefined;
  return mg?.AUDIO ?? {};
}

/**
 * URL luồng tiếng mà variant THẬT SỰ DÙNG (chuỗi rỗng nếu chưa chọn gì).
 *
 * Đọc được cả hai hình dạng đang được cân nhắc cho W1.1, vì lộ trình còn
 * MÂU THUẪN với chính nó (xem §2b): NGHIEN-CUU-VDH.md W1.1 bước 2 bảo thêm
 * `audioUri?: string`, còn PROMPT-THUC-THI §3.2 + W4.4 bảo mang CẢ DANH SÁCH
 * rendition. Helper này trung lập với cả hai để test canh không ép thiết kế.
 *
 * 🔧 W1.1: nếu chọn hình dạng THỨ BA, phải cập nhật hàm này — nếu không nó
 * trả '' vĩnh viễn và mọi test canh dùng nó sẽ xanh RỖNG một cách vô dụng.
 */
function selectedAudioUri(variant: unknown): string {
  const v = variant as {
    audioUri?: string;
    audioRenditions?: { uri?: string; selected?: boolean }[];
  };
  return v.audioUri ?? v.audioRenditions?.find((x) => x.selected)?.uri ?? '';
}

// --- Fixture: Twitter/X. Dạng gây câm phổ biến nhất ---------------------
// Bẫy riêng của X, cả ba đều đã kiểm chứng trên manifest thật:
//  - NAME đứng TRƯỚC TYPE  -> regex neo vào "#EXT-X-MEDIA:TYPE=" trượt sạch.
//  - KHÔNG có DEFAULT      -> heuristic "chọn rendition DEFAULT" trả về RỖNG.
//  - Mỗi tier hình một group tiếng riêng -> BẮT BUỘC tra qua AUDIO= của
//    variant đã chọn; lấy #EXT-X-MEDIA đầu tiên sẽ ghép tiếng 128k vào 480x270.
const X_MASTER = `#EXTM3U
#EXT-X-MEDIA:NAME="Audio",AUTOSELECT=YES,TYPE=AUDIO,GROUP-ID="audio-128000",URI="/aud/128/pl.m3u8"
#EXT-X-MEDIA:NAME="Audio",AUTOSELECT=YES,TYPE=AUDIO,GROUP-ID="audio-64000",URI="/aud/64/pl.m3u8"
#EXT-X-MEDIA:NAME="Audio",AUTOSELECT=YES,TYPE=AUDIO,GROUP-ID="audio-32000",URI="/aud/32/pl.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2176000,RESOLUTION=1280x720,CODECS="avc1.4d001f,mp4a.40.2",AUDIO="audio-128000"
/vid/720/pl.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=832000,RESOLUTION=640x360,CODECS="avc1.4d001e,mp4a.40.2",AUDIO="audio-64000"
/vid/360/pl.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=288000,RESOLUTION=480x270,CODECS="avc1.4d0015,mp4a.40.2",AUDIO="audio-32000"
/vid/270/pl.m3u8`;
const X_BASE = 'https://video.twimg.com/ext_tw_video/1/pu/pl/master.m3u8';

describe('W0.4 hợp đồng m3u8-parser: dữ liệu tiếng NẰM SẴN, ta đang vứt đi', () => {
  const groups = audioGroups(X_MASTER);

  it('mediaGroups.AUDIO có đủ 3 group, key trong group là NAME', () => {
    expect(Object.keys(groups)).toEqual([
      'audio-128000',
      'audio-64000',
      'audio-32000',
    ]);
    expect(groups['audio-128000']!.Audio!.uri).toBe('/aud/128/pl.m3u8');
  });

  it('NAME trước TYPE vẫn parse đúng (regex neo "TYPE=" mới là thứ trượt)', () => {
    expect(groups['audio-32000']!.Audio!.uri).toBe('/aud/32/pl.m3u8');
  });

  it('X không khai DEFAULT -> default=false ở MỌI rendition', () => {
    // => heuristic "ưu tiên default===true" trả về RỖNG trên X. Phải fallback.
    const defaults = Object.values(groups).map(
      (g) => Object.values(g)[0]!.default,
    );
    expect(defaults).toEqual([false, false, false]);
  });

  it('parser KHÔNG resolve uri — nguyên văn manifest, ta phải tự resolveUri', () => {
    expect(rawManifest(X_MASTER).playlists![0]!.uri).toBe('/vid/720/pl.m3u8');
  });

  it('variant mang AUDIO= trỏ group tiếng của ĐÚNG tier mình', () => {
    const pls = rawManifest(X_MASTER).playlists!;
    expect(pls.map((p) => p.attributes!.AUDIO)).toEqual([
      'audio-128000',
      'audio-64000',
      'audio-32000',
    ]);
  });
});

describe('W0.4/W1.1 master tách tiếng (Twitter/X) -> file tải về BỊ CÂM', () => {
  const r = parseHlsManifest(X_MASTER, X_BASE);

  it('3 variant, sắp xếp giảm dần 720/360/270', () => {
    expect(r.variants.map((v) => v.height)).toEqual([720, 360, 270]);
  });

  // ✅ W1.1 (2026-07-17): đổi it.fails -> it. Ratchet đã tự bật ("Expect test to fail") ngay khi
  // parseHlsManifest bắt đầu đọc mediaGroups.AUDIO — đúng như W0.4 thiết kế, không cần ai nhớ.
  it('720p phải mang playlist tiếng 128k (trước W1.1: mất tiếng -> CÂM)', () => {
    expect(JSON.stringify(r.variants[0])).toContain(
      'https://video.twimg.com/aud/128/pl.m3u8',
    );
  });

  // Ghim việc phải tra ĐÚNG group của tier mình.
  it('270p phải mang tiếng 32k của chính tier mình', () => {
    expect(JSON.stringify(r.variants[2])).toContain(
      'https://video.twimg.com/aud/32/pl.m3u8',
    );
  });

  // CANH: xanh RỖNG hôm nay (chưa có tiếng để mà chọn sai), XANH khi sửa
  // ĐÚNG, ĐỎ khi sửa NGÂY THƠ ("lấy #EXT-X-MEDIA đầu tiên" -> nhét tiếng
  // 128k vào hình 480x270).
  //
  // Assert trên ĐÚNG rendition ĐƯỢC CHỌN, KHÔNG grep cả object variant.
  // Lý do (đã đo bằng cách cấy 4 thiết kế W1.1 rồi chạy thật): PROMPT-THUC-THI
  // §3.2 khuyến nghị variant mang CẢ DANH SÁCH rendition. Thiết kế đó ghép cặp
  // ĐÚNG nhưng vẫn CHỞ chuỗi '/aud/128/' trong danh sách -> một guard grep
  // JSON.stringify(variant) sẽ ĐỎ OAN đúng bản sửa mà lộ trình khuyên làm.
  // "CHỞ" khác "DÙNG" — chỉ "DÙNG" mới là thứ quyết định file có câm hay không.
  it('nếu 270p đã chọn tiếng thì phải là 32k, không phải 128k', () => {
    const used = selectedAudioUri(r.variants[2]);
    if (used === '') return; // hôm nay: chưa có tiếng -> xanh rỗng, đúng thiết kế
    expect(used).toContain('/aud/32/');
    expect(used).not.toContain('/aud/128/');
  });

  // ⚠️ ĐÃ GỠ BỎ: guard "không được bịa URL tiếng ngoài danh sách manifest".
  // Nó BẤT KHẢ THI trên fixture X, không phải chỉ viết chưa khéo — đã chứng
  // minh bằng cách chạy: một bản sửa KHÔNG hề đọc rendition.uri mà tự nặn
  // `/aud/${kbps}/pl.m3u8` từ GROUP-ID sẽ sinh ra chuỗi TRÙNG KHÍT URL thật,
  // nên KHÔNG assert nào nhìn vào output phân biệt nổi "đọc từ manifest" với
  // "dựng lại y hệt". Guard cũ còn ĐỎ OAN khi variant mang `id` hợp lệ có
  // chứa URL. Một test không bắt nổi đúng thứ nó mang tên = niềm tin giả —
  // chính căn bệnh W0.4 sinh ra để chữa. Ca "bịa" QUAN SÁT ĐƯỢC nằm ở fixture
  // AUDIO_NO_URI ngay dưới: ở đó URL bịa KHÔNG THỂ đến từ manifest.
});

// --- W1.1: hình dạng audioRenditions (thiết kế đã chốt ở §2b) -----------
// Chốt: mang rendition của MỌI group + cờ `selected` ở ĐÚNG MỘT cái variant dùng.
// Lý do mang cả danh sách: W4.4 (picker ngôn ngữ) cần thấy mọi lựa chọn mà KHÔNG phải đổi lại
// giao thức messages.ts. Lý do chỉ MỘT `selected`: "CHỞ" khác "DÙNG" — chỉ cái được DÙNG mới
// quyết định file có câm hay không.
describe('W1.1 audioRenditions: mang cả danh sách, chọn đúng một', () => {
  const r = parseHlsManifest(X_MASTER, X_BASE);

  it('mỗi variant mang rendition của MỌI group (để W4.4 thêm picker)', () => {
    expect(r.variants[0]!.audioRenditions).toHaveLength(3);
    expect(r.variants[0]!.audioRenditions!.map((x) => x.groupId)).toEqual([
      'audio-128000',
      'audio-64000',
      'audio-32000',
    ]);
  });

  it('ĐÚNG MỘT rendition được chọn, và là của group variant trỏ tới', () => {
    for (const v of r.variants) {
      const sel = v.audioRenditions!.filter((x) => x.selected);
      expect(sel).toHaveLength(1);
    }
    expect(
      r.variants[0]!.audioRenditions!.find((x) => x.selected)!.groupId,
    ).toBe('audio-128000');
    expect(
      r.variants[2]!.audioRenditions!.find((x) => x.selected)!.groupId,
    ).toBe('audio-32000');
  });

  // X không khai DEFAULT bao giờ -> nếu chỉ dựa vào DEFAULT thì KHÔNG chọn được gì -> câm y cũ.
  it('không có DEFAULT vẫn chọn được (fallback lấy đầu group)', () => {
    expect(
      r.variants.every((v) => v.audioRenditions!.every((x) => !x.default)),
    ).toBe(true);
    expect(selectedAudioUri(r.variants[0])).toBe(
      'https://video.twimg.com/aud/128/pl.m3u8',
    );
  });
});

describe('W1.1 chọn rendition trong group: ưu tiên DEFAULT, không có thì lấy đầu', () => {
  // Group nhiều ngôn ngữ, DEFAULT nằm ở cái THỨ HAI -> phải chọn nó, không phải cái đầu.
  const MULTI = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",NAME="English",LANGUAGE="en",URI="en/pl.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",NAME="Spanish",LANGUAGE="es",DEFAULT=YES,URI="es/pl.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="g"
v/pl.m3u8`;

  it('DEFAULT=YES thắng dù không đứng đầu', () => {
    const r = parseHlsManifest(MULTI, 'https://ex.com/d/master.m3u8');
    expect(selectedAudioUri(r.variants[0])).toBe('https://ex.com/d/es/pl.m3u8');
  });

  it('vẫn CHỞ đủ cả 2 ngôn ngữ để W4.4 dựng picker', () => {
    const r = parseHlsManifest(MULTI, 'https://ex.com/d/master.m3u8');
    expect(r.variants[0]!.audioRenditions!.map((x) => x.language)).toEqual([
      'en',
      'es',
    ]);
  });
});

describe('W1.1 master KHÔNG tách tiếng -> giữ nguyên đường một-input', () => {
  it('master không có #EXT-X-MEDIA -> không mang audioRenditions', () => {
    const MUXED = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=90000,RESOLUTION=128x96,CODECS="avc1.42c00c,mp4a.40.2"
media.m3u8`;
    const r = parseHlsManifest(MUXED, 'https://ex.com/d/master.m3u8');
    expect(r.variants[0]!.audioRenditions).toBeUndefined();
    expect(selectedAudioUri(r.variants[0])).toBe('');
  });

  // Ca lai: master CÓ mediaGroups nhưng variant này KHÔNG trỏ AUDIO= -> tiếng nằm trong nó.
  // Vẫn CHỞ danh sách (W4.4 cần) nhưng KHÔNG chọn gì -> không ghép nhầm tiếng của variant khác.
  it('variant không khai AUDIO= -> chở danh sách nhưng KHÔNG chọn gì', () => {
    const MIXED = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",NAME="Main",DEFAULT=YES,URI="aud/pl.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.42c01e",AUDIO="g"
sep/pl.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180,CODECS="avc1.42c00c,mp4a.40.2"
muxed/pl.m3u8`;
    const r = parseHlsManifest(MIXED, 'https://ex.com/d/master.m3u8');
    const muxed = r.variants.find((v) => v.uri.includes('muxed'))!;
    const sep = r.variants.find((v) => v.uri.includes('sep'))!;
    expect(selectedAudioUri(sep)).toBe('https://ex.com/d/aud/pl.m3u8');
    expect(selectedAudioUri(muxed)).toBe('');
  });
});

// --- W1.1: hai lỗi do review đối kháng bắt được (2026-07-17) ------------
// Cả hai đều do chính bản sửa W1.1 sinh ra, và cả hai đã được kiểm bằng CHẠY THẬT ffmpeg trước
// khi sửa. Giữ test ở đây để không tái phát.
describe('W1.1 variant AUDIO-ONLY -> KHÔNG được chọn tiếng (chống hồi quy)', () => {
  // HLS Authoring Spec §2.3 BẮT BUỘC master có một rendition audio-only, và nó thường được khai
  // luôn thành #EXT-X-STREAM-INF (Apple/Shaka/Bento4/MediaConvert đều phát kiểu này). Khi đó
  // uri của variant TRÙNG KHÍT uri của rendition tiếng.
  const AUDIO_ONLY_VARIANT = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="English",DEFAULT=YES,URI="a1/prog.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=960x540,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud1"
v5/prog.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=68000,CODECS="mp4a.40.2",AUDIO="aud1"
a1/prog.m3u8`;

  const r = parseHlsManifest(
    AUDIO_ONLY_VARIANT,
    'https://ex.com/dir/master.m3u8',
  );
  const audioOnly = r.variants.find((v) => v.uri.endsWith('a1/prog.m3u8'))!;
  const withVideo = r.variants.find((v) => v.uri.endsWith('v5/prog.m3u8'))!;

  // Chọn tiếng cho nó = gửi audioUrl TRÙNG variantUrl -> offscreen tải cùng playlist 2 lần rồi
  // ép `-map 0:v:0` lên input KHÔNG có hình -> ffmpeg mã 234 (đã đo thật), job LỖI CỨNG.
  // Trước W1.1 chính variant này tải được (ra file chỉ-tiếng hợp lệ) => sẽ là HỒI QUY.
  it('variant audio-only KHÔNG chọn rendition nào (tránh mã 234 + tải đôi)', () => {
    expect(selectedAudioUri(audioOnly)).toBe('');
  });

  it('variant có hình vẫn chọn tiếng bình thường', () => {
    expect(selectedAudioUri(withVideo)).toBe('https://ex.com/dir/a1/prog.m3u8');
  });
});

describe('W1.1 AUTOSELECT: RFC 8216 §4.3.4.1.1 — không có DEFAULT thì xét AUTOSELECT', () => {
  // Commentary (AUTOSELECT=NO, CÓ URI) đứng TRƯỚC Main (AUTOSELECT=YES, KHÔNG URI = tiếng nằm
  // sẵn trong variant). Fallback "lấy cái đầu" sẽ trúng Commentary -> `-map 1:a:0` thay tiếng
  // chính bằng tiếng bình luận: hình đúng, TIẾNG SAI HOÀN TOÀN, job vẫn 'done', không cảnh báo.
  const COMMENTARY = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",NAME="Commentary",AUTOSELECT=NO,URI="commentary/pl.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",NAME="Main",AUTOSELECT=YES
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="g"
muxed/pl.m3u8`;

  it('AUTOSELECT=YES thắng cái đứng đầu có AUTOSELECT=NO', () => {
    const r = parseHlsManifest(COMMENTARY, 'https://ex.com/dir/master.m3u8');
    const sel = r.variants[0]!.audioRenditions!.find((x) => x.selected)!;
    expect(sel.name).toBe('Main');
    // Main không có URI -> tiếng đã nằm trong variant -> giữ đường một-input, không ghép đè.
    expect(selectedAudioUri(r.variants[0])).toBe('');
  });
});

// --- Fixture: RFC 8216 §4.3.4.2.1 — #EXT-X-MEDIA KHÔNG có URI ------------
// "clients MUST assume that the audio data ... is present in every video
// Rendition" => tiếng ĐÃ nằm trong variant => giữ nguyên đường MỘT input.
// Ca này không có trong manifest thật nào tải được -> buộc phải tự chế.
const AUDIO_NO_URI = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="grp",NAME="Main",DEFAULT=YES,LANGUAGE="en"
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="grp"
muxed/index.m3u8`;

describe('W0.4/W1.1 #EXT-X-MEDIA không URI -> tiếng đã nằm trong variant', () => {
  it('hợp đồng: key "uri" VẮNG HẲN, không phải undefined', () => {
    const main = audioGroups(AUDIO_NO_URI).grp!.Main!;
    expect('uri' in main).toBe(false);
    expect(main.default).toBe(true);
  });

  // CANH: xanh hôm nay, phải XANH LẠI sau W1.1. Đây là ca "bịa" DUY NHẤT
  // quan sát được: rendition không có URI, nên mọi URL tiếng hiện ra đều
  // KHÔNG THỂ đến từ manifest.
  //
  // ĐỘ PHỦ THẬT (đã đo bằng cách cấy 5 bản sửa rồi chạy, đừng tin quá lời):
  // chỉ bắt được bản `resolveUri(rend.uri ?? '')` -> nặn ra master.m3u8.
  // BỎ LỌT: (a) lấy chính uri hình làm input tiếng thứ hai (new Set nuốt trùng),
  // (b) `String(undefined)` -> .../undefined (không đuôi .m3u8 nên regex mù),
  // (c) bịa 'grp/audio.m4a' (mọi đuôi khác .m3u8 đều vô hình).
  // Ba lỗ này chỉ bịt được khi đã biết hình dạng thật -> việc của W1.1.
  it('không sinh thêm URL nào ngoài chính variant (giữ đường một-input)', () => {
    const r = parseHlsManifest(AUDIO_NO_URI, 'https://ex.com/dir/master.m3u8');
    const urls = JSON.stringify(r).match(/https?:[^"]+\.m3u8/g) ?? [];
    expect(new Set(urls)).toEqual(
      new Set(['https://ex.com/dir/muxed/index.m3u8']),
    );
  });
});

// --- Fixture: Vimeo — tiếng và hình TRÙNG PATH, chỉ khác query -----------
// Parser nào dedupe theo path hoặc bỏ query sẽ GỘP HAI TRACK LÀM MỘT.
// URI dùng ../../../ -> bắt buộc resolve thật.
const VIMEO_MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-grp",NAME="Audio",DEFAULT=YES,URI="../../../parcel/v2/pl.m3u8?st=audio&tk=abc"
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="audio-grp"
../../../parcel/v2/pl.m3u8?st=video&tk=abc`;
const VIMEO_BASE = 'https://vod.vimeocdn.com/a/b/c/sep/master.m3u8';

describe('W0.4/W1.1 Vimeo: tiếng/hình trùng path, chỉ khác query', () => {
  it('hợp đồng: hai uri chỉ khác query st=audio / st=video', () => {
    const g = audioGroups(VIMEO_MASTER)['audio-grp']!.Audio!;
    expect(g.uri).toBe('../../../parcel/v2/pl.m3u8?st=audio&tk=abc');
    expect(rawManifest(VIMEO_MASTER).playlists![0]!.uri).toBe(
      '../../../parcel/v2/pl.m3u8?st=video&tk=abc',
    );
  });

  // ../../../ tính từ THƯ MỤC của base (/a/b/c/sep/) -> lùi 3 mức = /a/,
  // KHÔNG phải về gốc domain. Kỳ vọng sai chỗ này là bẫy dễ dẫm.
  it('hình resolve đúng qua ../../../ và GIỮ NGUYÊN query', () => {
    const r = parseHlsManifest(VIMEO_MASTER, VIMEO_BASE);
    expect(r.variants[0]!.uri).toBe(
      'https://vod.vimeocdn.com/a/parcel/v2/pl.m3u8?st=video&tk=abc',
    );
  });

  // ✅ W1.1 (2026-07-17): đổi it.fails -> it (ratchet tự bật).
  it('variant phải mang playlist tiếng (st=audio), resolve tuyệt đối', () => {
    const r = parseHlsManifest(VIMEO_MASTER, VIMEO_BASE);
    expect(JSON.stringify(r.variants[0])).toContain(
      'https://vod.vimeocdn.com/a/parcel/v2/pl.m3u8?st=audio&tk=abc',
    );
  });
});

// --- Fixture: Apple fMP4 — CÙNG uri variant dưới 3 group tiếng -----------
// Ghim lý do W1.5 cần `id` bắt buộc: key/dedupe theo uri sẽ mất ac-3/ec-3.
const APPLE_MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="a1/prog.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ac3",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="a2/prog.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ec3",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="a3/prog.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aac"
v/prog.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2600000,RESOLUTION=1280x720,CODECS="avc1.4d401f,ac-3",AUDIO="ac3"
v/prog.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2700000,RESOLUTION=1280x720,CODECS="avc1.4d401f,ec-3",AUDIO="ec3"
v/prog.m3u8`;

describe('W0.4/W1.5 Apple: 3 variant DÙNG CHUNG một uri hình', () => {
  const r = parseHlsManifest(APPLE_MASTER, 'https://ex.com/dir/master.m3u8');

  it('giữ đủ 3 variant dù uri trùng nhau (không được dedupe theo uri)', () => {
    expect(r.variants).toHaveLength(3);
    expect(new Set(r.variants.map((v) => v.uri)).size).toBe(1);
  });

  // W1.5 XONG: `id` bắt buộc, key/chọn theo id -> bấm 1 dòng chỉ sáng 1 dòng.
  it('mỗi variant phải có `id` riêng để phân biệt', () => {
    const ids = r.variants.map((v) => v.id);
    expect(new Set(ids).size).toBe(3);
  });
});

// --- Fixture: EXT-X-BYTERANGE -------------------------------------------
// Mọi #EXTINF trỏ CÙNG một URL, chỉ khác byte range. Vứt byterange => thấy
// 3 segment trùng URL => tải nguyên file 3 lần, không header Range.
const BYTERANGE = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:10
#EXT-X-MAP:URI="all.ts",BYTERANGE="1000@0"
#EXTINF:9.0,
#EXT-X-BYTERANGE:75232@1000
all.ts
#EXTINF:9.0,
#EXT-X-BYTERANGE:82112
all.ts
#EXTINF:9.0,
#EXT-X-BYTERANGE:69864@200000
all.ts
#EXT-X-ENDLIST`;

describe('W0.4/W1.3 EXT-X-BYTERANGE', () => {
  const raw = rawManifest(BYTERANGE);
  const r = parseHlsSegments(BYTERANGE, 'https://cdn.example.com/dir/x.m3u8');

  it('hợp đồng: offset ĐÃ cộng dồn thành TUYỆT ĐỐI — đừng cộng lần nữa', () => {
    // segment 2 khai "82112" KHÔNG có @offset -> parser tự tính 1000+75232.
    expect(raw.segments![0]!.byterange).toEqual({
      length: 75232,
      offset: 1000,
    });
    expect(raw.segments![1]!.byterange).toEqual({
      length: 82112,
      offset: 76232,
    });
    expect(raw.segments![2]!.byterange).toEqual({
      length: 69864,
      offset: 200000,
    });
  });

  it('hợp đồng: segment.map là MỘT object DÙNG CHUNG — đừng sửa tại chỗ', () => {
    expect(raw.segments![0]!.map).toBe(raw.segments![1]!.map);
  });

  it('hiện trạng: 3 segment trùng hệt uri -> sẽ tải cùng file 3 lần', () => {
    expect(new Set(r.segments.map((s) => s.uri)).size).toBe(1);
  });

  // ✅ W1.3 (2026-07-17): it.fails -> it (ratchet tự bật).
  it('segment phải mang byterange', () => {
    expect(r.segments[0]).toHaveProperty('byterange');
  });

  // Ghim bẫy cộng dồn hai lần (76232, KHÔNG phải 152464).
  it('byterange.offset giữ nguyên giá trị tuyệt đối của parser', () => {
    expect(r.segments[1]).toHaveProperty('byterange.offset', 76232);
    expect(r.segments[1]).toHaveProperty('byterange.length', 82112);
  });

  it('init segment (#EXT-X-MAP) phải mang byterange riêng', () => {
    expect(r.segments[0]).toHaveProperty('initByterange.length', 1000);
    expect(r.segments[0]).toHaveProperty('initByterange.offset', 0);
  });
});

// --- Fixture: #EXT-X-MAP BYTERANGE THIẾU @offset -------------------------
// map.byterange KHÁC segment.byterange: KHÔNG cộng dồn, và thiếu @offset thì
// key `offset` VẮNG HẲN (không mặc định 0). Ca này không có trong manifest
// thật nào tải được -> tự chế theo RFC 8216 §4.3.2.5.
const MAP_BYTERANGE_NO_OFFSET = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MAP:URI="init.mp4",BYTERANGE="800"
#EXTINF:9.0,
#EXT-X-BYTERANGE:5000@800
all.m4s
#EXT-X-ENDLIST`;

describe('W0.4/W1.3 #EXT-X-MAP BYTERANGE thiếu @offset', () => {
  it('hợp đồng: key `offset` VẮNG HẲN ở map.byterange (không mặc định 0)', () => {
    const raw = rawManifest(MAP_BYTERANGE_NO_OFFSET);
    const mapBr = raw.segments![0]!.map!.byterange!;
    expect(mapBr.length).toBe(800);
    expect('offset' in mapBr).toBe(false);
  });

  // ✅ W1.3 (2026-07-17): it.fails -> it. Ghim luôn: thiếu @offset ở MAP nghĩa là bắt đầu
  // từ byte 0, KHÔNG phải "nối tiếp segment trước" như luật của EXT-X-BYTERANGE.
  it('thiếu @offset ở MAP -> phải hiểu là offset 0', () => {
    const r = parseHlsSegments(
      MAP_BYTERANGE_NO_OFFSET,
      'https://cdn.example.com/dir/x.m3u8',
    );
    expect(r.segments[0]).toHaveProperty('initByterange.offset', 0);
  });
});

// --- Fixture: EXT-X-DISCONTINUITY ---------------------------------------
// Stream chèn quảng cáo reset timestamp. Byte-concat + -c copy => DTS không
// đơn điệu => file chạy đoạn đầu rồi lệch tiếng/đứng hình, mà log
// 'Non-monotonous DTS' chỉ đi vào console.debug => user nhận "Đã tải xong ✓".
const DISCONTINUITY = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
a0.ts
#EXTINF:10.0,
a1.ts
#EXT-X-DISCONTINUITY
#EXTINF:6.0,
ad0.ts
#EXT-X-DISCONTINUITY
#EXTINF:10.0,
b0.ts
#EXT-X-ENDLIST`;

describe('W0.4/W1.4 EXT-X-DISCONTINUITY', () => {
  const raw = rawManifest(DISCONTINUITY);
  const r = parseHlsSegments(
    DISCONTINUITY,
    'https://cdn.example.com/dir/x.m3u8',
  );

  it('hợp đồng: discontinuityStarts là CHỈ SỐ MẢNG, không phải media sequence', () => {
    expect(raw.discontinuityStarts).toEqual([2, 3]);
  });

  it('hợp đồng: cờ `discontinuity` CHỈ có mặt khi = true', () => {
    expect('discontinuity' in raw.segments![0]!).toBe(false);
    expect(raw.segments![2]!.discontinuity).toBe(true);
  });

  it('hợp đồng: `timeline` tăng theo mỗi discontinuity (cách gom nhóm sạch hơn)', () => {
    expect(raw.segments!.map((s) => s.timeline)).toEqual([0, 0, 1, 2]);
  });

  it('hiện trạng: parse trót lọt, không một tín hiệu nào về discontinuity', () => {
    expect(r.segments).toHaveLength(4);
    expect(r.totalDuration).toBeCloseTo(36);
  });

  it('kết quả phải đếm discontinuity để còn cảnh báo', () => {
    expect(r).toHaveProperty('discontinuityCount', 2);
  });
});

// --- W1.4: ba ca biên BÁC BỎ cách đếm hiển nhiên ------------------------
// 🔬 ĐO THẬT (m3u8-parser@7.2.0, probe 2026-07-19) trước khi viết một dòng code: dùng thẳng
// `discontinuityStarts.length` SAI CẢ HAI CHIỀU. Ba ca dưới ghim đúng chỗ nó sai — bỏ chúng đi
// thì bản sửa ngây thơ vẫn xanh, và người dùng nhận cảnh báo oan (hoặc số đếm gấp đôi).
describe('W1.4 đếm discontinuity: chỉ tính CHỖ NỐI THẬT bên trong file ghép', () => {
  it('playlist sạch -> 0 (KHÔNG cảnh báo oan)', () => {
    const r = parseHlsSegments(
      `#EXTM3U\n#EXTINF:9,\na.ts\n#EXTINF:9,\nb.ts\n#EXT-X-ENDLIST`,
      'https://a.com/i.m3u8',
    );
    expect(r.discontinuityCount).toBe(0);
  });

  // ĐO: tag đứng TRƯỚC segment đầu -> discontinuityStarts = [0]. Đó là mốc reset so với đoạn ta
  // KHÔNG tải; bên trong file ghép ra không có chỗ nối nào. Đếm nó = doạ user vô cớ.
  it('tag TRƯỚC segment đầu tiên -> 0 chỗ nối (starts=[0] nhưng không có gì phía trước để nối)', () => {
    const text = `#EXTM3U
#EXT-X-DISCONTINUITY
#EXTINF:9,
a.ts
#EXTINF:9,
b.ts
#EXT-X-ENDLIST`;
    expect(rawManifest(text).discontinuityStarts).toEqual([0]); // hợp đồng thư viện
    expect(
      parseHlsSegments(text, 'https://a.com/i.m3u8').discontinuityCount,
    ).toBe(0);
  });

  // ĐO: hai tag liền nhau -> discontinuityStarts = [1,1] (chỉ số LẶP) trong khi chỉ có MỘT chỗ nối.
  it('hai tag LIỀN NHAU -> 1 chỗ nối, không phải 2 (starts lặp chỉ số)', () => {
    const text = `#EXTM3U
#EXTINF:9,
a.ts
#EXT-X-DISCONTINUITY
#EXT-X-DISCONTINUITY
#EXTINF:9,
b.ts
#EXT-X-ENDLIST`;
    expect(rawManifest(text).discontinuityStarts).toEqual([1, 1]); // hợp đồng thư viện
    expect(
      parseHlsSegments(text, 'https://a.com/i.m3u8').discontinuityCount,
    ).toBe(1);
  });

  // ĐO: DISCONTINUITY-SEQUENCE nói "trước cửa sổ này đã có 3 lần đứt", KHÔNG phải đứt bên trong.
  // 🔴 Ghim RIÊNG từng nửa của phép hợp trong countDiscontinuities. Qua đường parse thật, hai
  // nguồn (mảng `discontinuityStarts` và cờ trên segment) LUÔN khai giống nhau, nên xoá nửa nào
  // suite cũng vẫn xanh -> một hôm ai đó dọn "code thừa" là mất lưới mà không ai hay. Gọi thẳng
  // hàm thuần với đúng MỘT nguồn là cách duy nhất chứng minh cả hai nửa đều đang gánh việc.
  it('chỉ có mảng starts (không cờ segment) -> vẫn đếm được', () => {
    expect(countDiscontinuities([{}, {}, {}, {}], [2, 3])).toBe(2);
  });

  it('chỉ có cờ trên segment (không mảng starts) -> vẫn đếm được', () => {
    expect(
      countDiscontinuities([{}, {}, { discontinuity: true }, {}], undefined),
    ).toBe(1);
  });

  // Chỉ số vượt ngoài mảng segment không phải chỗ nối nào cả — bỏ, đừng đếm bừa.
  it('chỉ số nằm ngoài phạm vi segment -> bỏ qua', () => {
    expect(countDiscontinuities([{}, {}], [1, 5, -1])).toBe(1);
  });

  it('DISCONTINUITY-SEQUENCE mà không có tag nào -> 0', () => {
    const text = `#EXTM3U
#EXT-X-DISCONTINUITY-SEQUENCE:3
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:9,
a.ts
#EXTINF:9,
b.ts
#EXT-X-ENDLIST`;
    const raw = rawManifest(text);
    expect(raw.discontinuityStarts).toEqual([]);
    expect(raw.discontinuitySequence).toBe(3); // có mặt, nhưng KHÔNG được dùng để đếm
    expect(
      parseHlsSegments(text, 'https://a.com/i.m3u8').discontinuityCount,
    ).toBe(0);
  });
});

// --- W4.2: URL con của master -> ẩn khỏi popup --------------------------
// ĐO THẬT trước khi viết (Edge + extension + fixture tách tiếng, 2026-07-17): một video phát ra
// popup hiện ĐÚNG 3 DÒNG cùng nhãn "HLS" — master.m3u8, video.m3u8, audio.m3u8 — vì webRequest
// thấy cả 3 và `classifyMedia` chỉ nhìn đuôi `.m3u8`. Sau W1.1, dòng tiếng KHÔNG còn là cách lấy
// tiếng nữa (offscreen tự ghép) => nó chỉ còn là rác: bấm vào ra "video" chỉ có tiếng.
describe('W4.2 childUrlsOfMaster: variant + rendition của master đều là CON', () => {
  // Đúng hình dạng fixture e2e tách tiếng (và của Twitter/X, Vimeo, CMAF).
  const MASTER_DEMUXED = `#EXTM3U
#EXT-X-MEDIA:NAME="Audio",AUTOSELECT=YES,TYPE=AUDIO,GROUP-ID="aud-64000",URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=128x96,CODECS="avc1.42c00c,mp4a.40.2",AUDIO="aud-64000"
video.m3u8`;

  it('trả về CẢ playlist hình lẫn playlist tiếng (uri tuyệt đối)', () => {
    const r = parseHlsManifest(
      MASTER_DEMUXED,
      'https://ex.com/hls/master.m3u8',
    );
    expect(childUrlsOfMaster(r).sort()).toEqual([
      'https://ex.com/hls/audio.m3u8',
      'https://ex.com/hls/video.m3u8',
    ]);
  });

  // 🔴 BẪY CHẾT NGƯỜI: parse một MEDIA playlist trả về `variants: [{ uri: manifestUrl }]` — tức
  // chính nó. Thiếu guard `isMaster` thì mỗi playlist con sẽ tự khai mình là con của CHÍNH MÌNH
  // -> bị ẩn -> user mở popup thấy TRỐNG TRƠN trên site phát thẳng media playlist (không master).
  it('MEDIA playlist -> KHÔNG có con (không được tự ẩn chính mình)', () => {
    const r = parseHlsManifest(
      `#EXTM3U\n#EXTINF:9.9,\nseg0.ts\n#EXT-X-ENDLIST`,
      'https://ex.com/hls/media.m3u8',
    );
    expect(r.isMaster).toBe(false);
    expect(childUrlsOfMaster(r)).toEqual([]);
  });

  it('nhiều group tiếng (kiểu Twitter/X) -> gom hết, không trùng lặp', () => {
    const X = `#EXTM3U
#EXT-X-MEDIA:NAME="a128",TYPE=AUDIO,GROUP-ID="audio-128000",URI="aud/128/pl.m3u8"
#EXT-X-MEDIA:NAME="a64",TYPE=AUDIO,GROUP-ID="audio-64000",URI="aud/64/pl.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="audio-128000"
vid/720/pl.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=480x270,AUDIO="audio-64000"
vid/270/pl.m3u8`;
    const r = parseHlsManifest(X, 'https://video.twimg.com/x/master.m3u8');
    // audioRenditions mang MỌI group ở MỌI variant -> dễ ra URL trùng nếu quên dedupe.
    expect(childUrlsOfMaster(r).sort()).toEqual([
      'https://video.twimg.com/x/aud/128/pl.m3u8',
      'https://video.twimg.com/x/aud/64/pl.m3u8',
      'https://video.twimg.com/x/vid/270/pl.m3u8',
      'https://video.twimg.com/x/vid/720/pl.m3u8',
    ]);
  });

  // Rendition KHÔNG có URI = tiếng nằm sẵn trong variant (RFC 8216 §4.3.4.2.1) -> không có URL
  // nào để ẩn. Nặn ra một URL ở đây sẽ ẩn nhầm chính master.
  it('rendition không URI -> không sinh URL con bịa', () => {
    const NO_URI = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",NAME="Main",AUTOSELECT=YES
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,AUDIO="g"
muxed/pl.m3u8`;
    const r = parseHlsManifest(NO_URI, 'https://ex.com/d/master.m3u8');
    expect(childUrlsOfMaster(r)).toEqual(['https://ex.com/d/muxed/pl.m3u8']);
  });
});

// --- W2.3: mọi host trong playlist -> spoof để segment/key/init khác host không 403 ------
// §2.4: segment hay ở CDN khác host với playlist, và key AES gần như LUÔN ở host khác — lại là thứ
// hay kiểm Referer nhất. applySpoof cũ chỉ phủ host playlist ⇒ job tới 'fetching' rồi mọi segment
// 403. spoofTargetsFromSegments trả MỘT url đại diện cho mỗi host để background bật spoof đủ.
describe('W2.3 spoofTargetsFromSegments', () => {
  const MULTI_HOST = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k.bin"
#EXT-X-MAP:URI="https://init.example.com/init.mp4"
#EXTINF:6,
https://seg.example.com/0.ts
#EXTINF:6,
https://seg.example.com/1.ts
#EXT-X-ENDLIST`;

  it('gom đúng mỗi host một lần: segment + key + init', () => {
    const r = parseHlsSegments(MULTI_HOST, 'https://pl.example.com/media.m3u8');
    const hosts = spoofTargetsFromSegments(r.segments)
      .map((u) => new URL(u).hostname)
      .sort();
    expect(hosts).toEqual([
      'init.example.com',
      'keys.example.com',
      'seg.example.com',
    ]);
  });

  it('segment cùng host -> chỉ một url đại diện (không nở theo số segment)', () => {
    const SAME = `#EXTM3U
#EXTINF:6,
https://cdn.example.com/0.ts
#EXTINF:6,
https://cdn.example.com/1.ts
#EXTINF:6,
https://cdn.example.com/2.ts
#EXT-X-ENDLIST`;
    const r = parseHlsSegments(SAME, 'https://cdn.example.com/media.m3u8');
    expect(spoofTargetsFromSegments(r.segments)).toHaveLength(1);
  });

  it('playlist rỗng -> mảng rỗng', () => {
    expect(spoofTargetsFromSegments([])).toEqual([]);
  });
});

// --- §7: DRM khai trong playlist phải CHẶN, và AES-128 thường phải KHÔNG bị chặn oan -------------
//
// 🔴 ĐO ĐƯỢC 2026-07-19 trước bản vá: ba ca DRM đầu tiên dưới đây đều trả isProtected=FALSE, tức
// extension tải thẳng nội dung được bảo vệ. Nguyên nhân nằm ở m3u8-parser (nó nuốt `segment.key`
// khi KEYFORMAT không phải identity) chứ không nằm ở logic của ta — nên đừng suy DRM từ segment.key.
describe('parseHlsSegments — ranh giới §7 với playlist DRM', () => {
  const pl = (keyLine: string) =>
    `#EXTM3U\n#EXT-X-VERSION:5\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n${keyLine}\n#EXTINF:6.0,\nseg0.ts\n#EXT-X-ENDLIST\n`;
  const U = 'https://x/media.m3u8';

  it('FairPlay -> isProtected + nêu tên hãng', () => {
    const r = parseHlsSegments(
      pl('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k",KEYFORMAT="com.apple.streamingkeydelivery"'),
      U,
    );
    expect(r.isProtected).toBe(true);
    expect(r.drmName).toBe('FairPlay');
  });

  it('PlayReady -> isProtected', () => {
    const r = parseHlsSegments(
      pl('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:x",KEYFORMAT="com.microsoft.playready"'),
      U,
    );
    expect(r.isProtected).toBe(true);
  });

  it('Widevine (urn:uuid) -> isProtected', () => {
    const r = parseHlsSegments(
      pl(
        '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:x",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"',
      ),
      U,
    );
    expect(r.isProtected).toBe(true);
    expect(r.drmName).toBe('Widevine');
  });

  // CHIỀU NGƯỢC LẠI — chặn oan còn tệ hơn bỏ sót.
  it('AES-128 thường -> KHÔNG protected, vẫn tải được', () => {
    const r = parseHlsSegments(pl('#EXT-X-KEY:METHOD=AES-128,URI="k.bin"'), U);
    expect(r.isProtected).toBe(false);
    expect(r.encryption).toBe('aes-128');
    expect(r.drmName).toBeUndefined();
  });

  it('AES-128 kèm KEYFORMAT="identity" -> KHÔNG protected', () => {
    const r = parseHlsSegments(
      pl('#EXT-X-KEY:METHOD=AES-128,URI="k.bin",KEYFORMAT="identity"'),
      U,
    );
    expect(r.isProtected).toBe(false);
  });

  it('master có #EXT-X-SESSION-KEY DRM -> isProtected (master không có segment nào để mà suy)', () => {
    const master =
      '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://k",KEYFORMAT="com.apple.streamingkeydelivery"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\nmedia.m3u8\n';
    const r = parseHlsManifest(master, 'https://x/master.m3u8');
    expect(r.isMaster).toBe(true);
    expect(r.isProtected).toBe(true);
    expect(r.drmName).toBe('FairPlay');
  });

  it('master SẠCH -> KHÔNG protected', () => {
    const master =
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\nmedia.m3u8\n';
    const r = parseHlsManifest(master, 'https://x/master.m3u8');
    expect(r.isProtected ?? false).toBe(false);
  });
});
