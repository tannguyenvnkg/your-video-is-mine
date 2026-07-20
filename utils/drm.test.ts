import { describe, expect, it } from 'vitest';
import {
  DRM_UNSUPPORTED_ERROR,
  drmNameFromKeySystem,
  drmSystemFromHlsPlaylist,
  drmSystemsInMpd,
  isDrmKeySystem,
} from './drm';

// W7.1 — RANH GIỚI CỨNG §7. `CLAUDE.md` TUYÊN BỐ "gặp DRM thì DỪNG và báo rõ", nhưng trước gói này
// grep `requestMediaKeySystemAccess|MediaKeys|'encrypted'|keySystem` trong entrypoints/ utils/ ra
// ĐÚNG 0 HIT: ranh giới được khai báo mà chưa hề được thi hành. Mỗi test dưới đây ĐỎ trước W7.1.

describe('drmNameFromKeySystem — đọc tên hệ thống DRM cho NGƯỜI đọc', () => {
  it('nhận ba hệ thống DRM lớn', () => {
    expect(drmNameFromKeySystem('com.widevine.alpha')).toBe('Widevine');
    expect(drmNameFromKeySystem('com.microsoft.playready')).toBe('PlayReady');
    expect(drmNameFromKeySystem('com.apple.fps')).toBe('FairPlay');
  });

  it('nhận cả biến thể có hậu tố phiên bản (site thật dùng dạng này)', () => {
    // Safari xin 'com.apple.fps.1_0'/'2_0'; Edge xin 'com.microsoft.playready.recommendation'.
    expect(drmNameFromKeySystem('com.apple.fps.1_0')).toBe('FairPlay');
    expect(drmNameFromKeySystem('com.apple.fps.2_0')).toBe('FairPlay');
    expect(drmNameFromKeySystem('com.microsoft.playready.recommendation')).toBe(
      'PlayReady',
    );
    expect(drmNameFromKeySystem('com.widevine.alpha.experiment')).toBe(
      'Widevine',
    );
  });

  it('KHÔNG phân biệt hoa thường (chuỗi từ trang web, không kiểm soát được)', () => {
    expect(drmNameFromKeySystem('COM.WIDEVINE.ALPHA')).toBe('Widevine');
  });

  it('org.w3.clearkey là EME nhưng KHÔNG phải DRM thương mại -> vẫn chặn, tên riêng', () => {
    // Clear Key về kỹ thuật giải mã được, NHƯNG nó đi qua EME. Ta không đụng vào EME, chấm hết —
    // dựng một đường riêng cho nó là mở đúng cánh cửa §7 cấm.
    expect(drmNameFromKeySystem('org.w3.clearkey')).toBe('Clear Key');
    expect(isDrmKeySystem('org.w3.clearkey')).toBe(true);
  });

  it('chuỗi lạ -> không nhận ra, và KHÔNG được coi là an toàn', () => {
    expect(drmNameFromKeySystem('com.example.unknown')).toBeNull();
    // Mấu chốt: hệ thống lạ vẫn là EME -> vẫn phải CHẶN. Mặc định an toàn, không mặc định cho qua.
    expect(isDrmKeySystem('com.example.unknown')).toBe(true);
  });

  it('chuỗi rỗng không phải key system', () => {
    expect(isDrmKeySystem('')).toBe(false);
    expect(isDrmKeySystem('   ')).toBe(false);
  });
});

describe('DRM_UNSUPPORTED_ERROR — nói thật, nói rõ', () => {
  it('nêu đúng tên hệ thống khi biết', () => {
    const msg = DRM_UNSUPPORTED_ERROR('Widevine');
    expect(msg).toMatch(/Widevine/);
    expect(msg).toMatch(/bảo vệ|DRM/i);
  });

  it('không biết tên thì vẫn ra câu đọc được, không phải chuỗi rỗng', () => {
    const msg = DRM_UNSUPPORTED_ERROR();
    expect(msg.length).toBeGreaterThan(20);
    expect(msg).toMatch(/bảo vệ|DRM/i);
  });
});

describe('drmSystemsInMpd — DASH khai báo DRM ngay trong manifest', () => {
  it('bắt Widevine theo UUID chuẩn', () => {
    const mpd = `<?xml version="1.0"?><MPD><Period><AdaptationSet>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      </AdaptationSet></Period></MPD>`;
    expect(drmSystemsInMpd(mpd)).toEqual(['Widevine']);
  });

  it('UUID viết HOA vẫn bắt được (manifest thật hay viết hoa)', () => {
    const mpd = `<ContentProtection schemeIdUri="urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED"/>`;
    expect(drmSystemsInMpd(mpd)).toEqual(['Widevine']);
  });

  it('bắt PlayReady + FairPlay, gộp nhiều hệ thống, KHÔNG trùng lặp', () => {
    const mpd = `<MPD>
      <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/>
      <ContentProtection schemeIdUri="urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2"/>
      <ContentProtection schemeIdUri="urn:uuid:9A04F079-9840-4286-AB92-E65BE0885F95"/>
    </MPD>`;
    expect(drmSystemsInMpd(mpd).sort()).toEqual(['FairPlay', 'PlayReady']);
  });

  it('thẻ có tiền tố namespace (cenc:) vẫn bắt', () => {
    const mpd = `<cenc:ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>`;
    expect(drmSystemsInMpd(mpd)).toEqual(['Widevine']);
  });

  it('mp4protection chung (cenc) = ĐÃ MÃ HOÁ dù chưa rõ hãng nào -> vẫn phải chặn', () => {
    const mpd = `<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>`;
    const got = drmSystemsInMpd(mpd);
    expect(got.length).toBeGreaterThan(0);
  });

  it('UUID lạ vẫn tính là được bảo vệ (mặc định an toàn)', () => {
    const mpd = `<ContentProtection schemeIdUri="urn:uuid:11111111-2222-3333-4444-555555555555"/>`;
    expect(drmSystemsInMpd(mpd).length).toBeGreaterThan(0);
  });

  it('manifest SẠCH -> rỗng (đây là nửa dễ sai: đừng chặn oan video thường)', () => {
    const mpd = `<?xml version="1.0"?><MPD><Period><AdaptationSet mimeType="video/mp4">
      <Representation id="1" bandwidth="800000"><BaseURL>v.mp4</BaseURL></Representation>
      </AdaptationSet></Period></MPD>`;
    expect(drmSystemsInMpd(mpd)).toEqual([]);
  });

  it('chữ "ContentProtection" nằm trong URL/comment KHÔNG được tính là DRM', () => {
    // Chặn oan một video thường còn tệ hơn bỏ sót: user mất tính năng mà không hiểu vì sao.
    const mpd = `<MPD><!-- no ContentProtection here -->
      <BaseURL>https://cdn.example/ContentProtection/clip.mp4</BaseURL></MPD>`;
    expect(drmSystemsInMpd(mpd)).toEqual([]);
  });
});

// --- HLS: DRM khai ngay trong playlist qua #EXT-X-KEY / #EXT-X-SESSION-KEY ------------------------
//
// 🔴 LỖ HỔNG THẬT, ĐÃ ĐO 2026-07-19 (đừng "đơn giản hoá" mấy test này đi):
// Trước bản vá, ba hệ DRM phổ biến nhất đều LỌT qua ranh giới §7. Đo bằng m3u8-parser@7.2.0 thật
// qua chính parseHlsSegments():
//     FairPlay  (KEYFORMAT="com.apple.streamingkeydelivery") -> encryption='none', isProtected=FALSE
//     PlayReady (KEYFORMAT="com.microsoft.playready")        -> encryption='none', isProtected=FALSE
//     Widevine  (KEYFORMAT="urn:uuid:edef8ba9-...")          -> encryption='none', isProtected=FALSE
// Nguyên nhân: m3u8-parser đẩy khoá có KEYFORMAT lạ sang `manifest.contentProtection` và KHÔNG gán
// `segment.key`, nên mọi thứ suy ra từ `segment.key` đều thấy playlist "sạch". Hệ quả: extension tải
// trọn nội dung DRM rồi giao file nhiễu KÈM DẤU TÍCH XANH — vừa vượt ranh giới §7, vừa hỏng âm thầm.
//
// => Không được suy DRM từ `segment.key`. Phải soi THẲNG văn bản playlist.
describe('drmSystemFromHlsPlaylist (ranh giới §7 cho HLS)', () => {
  const pl = (keyLine: string) =>
    `#EXTM3U\n#EXT-X-VERSION:5\n#EXT-X-TARGETDURATION:6\n${keyLine}\n#EXTINF:6.0,\nseg0.ts\n#EXT-X-ENDLIST\n`;

  it('FairPlay (Apple) -> chặn, nêu đúng tên hãng', () => {
    const t = pl(
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://kid",KEYFORMAT="com.apple.streamingkeydelivery"',
    );
    expect(drmSystemFromHlsPlaylist(t)).toBe('FairPlay');
  });

  it('PlayReady (Microsoft) -> chặn, nêu đúng tên hãng', () => {
    const t = pl(
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,AAAA",KEYFORMAT="com.microsoft.playready"',
    );
    expect(drmSystemFromHlsPlaylist(t)).toBe('PlayReady');
  });

  it('Widevine (KEYFORMAT dạng urn:uuid) -> chặn, nêu đúng tên hãng', () => {
    const t = pl(
      '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"',
    );
    expect(drmSystemFromHlsPlaylist(t)).toBe('Widevine');
  });

  it('KEYFORMAT LẠ vẫn chặn (mặc định an toàn — danh sách trắng là lỗ hổng)', () => {
    const t = pl('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="x://y",KEYFORMAT="com.hang.moi.ra.doi"');
    expect(drmSystemFromHlsPlaylist(t)).not.toBeNull();
  });

  it('#EXT-X-SESSION-KEY trong MASTER cũng phải chặn (master không có segment nào)', () => {
    // Master quảng cáo DRM bằng SESSION-KEY. Chỉ soi #EXT-X-KEY thì master DRM lọt sạch.
    const t =
      '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://k",KEYFORMAT="com.apple.streamingkeydelivery"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=800000\nmedia.m3u8\n';
    expect(drmSystemFromHlsPlaylist(t)).toBe('FairPlay');
  });

  it('SAMPLE-AES trần (không KEYFORMAT) -> vẫn chặn', () => {
    expect(drmSystemFromHlsPlaylist(pl('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k.bin"'))).not.toBeNull();
  });

  // --- CHIỀU NGƯỢC LẠI: chặn oan còn tệ hơn bỏ sót (luật dự án) ---

  it('AES-128 thường -> KHÔNG chặn (đây là thứ ta ĐƯỢC PHÉP tải)', () => {
    expect(drmSystemFromHlsPlaylist(pl('#EXT-X-KEY:METHOD=AES-128,URI="k.bin"'))).toBeNull();
  });

  it('AES-128 kèm KEYFORMAT="identity" -> KHÔNG chặn (identity là mặc định của RFC 8216)', () => {
    const t = pl('#EXT-X-KEY:METHOD=AES-128,URI="k.bin",KEYFORMAT="identity"');
    expect(drmSystemFromHlsPlaylist(t)).toBeNull();
  });

  it('METHOD=NONE -> KHÔNG chặn dù có KEYFORMAT (đoạn trong-veo giữa stream mã hoá)', () => {
    const t = pl('#EXT-X-KEY:METHOD=NONE,KEYFORMAT="com.apple.streamingkeydelivery"');
    expect(drmSystemFromHlsPlaylist(t)).toBeNull();
  });

  it('playlist SẠCH hoàn toàn -> KHÔNG chặn', () => {
    expect(drmSystemFromHlsPlaylist(pl('#EXT-X-INDEPENDENT-SEGMENTS'))).toBeNull();
  });

  it('chữ KEYFORMAT nằm trong URL segment KHÔNG được tính là DRM', () => {
    const t =
      '#EXTM3U\n#EXTINF:6.0,\nhttps://cdn.example/KEYFORMAT=com.apple.streamingkeydelivery/s0.ts\n#EXT-X-ENDLIST\n';
    expect(drmSystemFromHlsPlaylist(t)).toBeNull();
  });
});
