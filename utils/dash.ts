// Parse DASH manifest (.mpd) THUẦN -> danh sách representation chất lượng + danh sách segment.
// mpd-parser chuẩn hoá MPD về dạng giống HLS (playlists[] + attributes + resolvedUri tuyệt đối).

import {
  parse,
  type MpdManifest,
  type MpdPlaylist,
  type MpdSegment,
} from 'mpd-parser';
import type { RenditionInfo, VariantInfo } from './types';
import {
  countDiscontinuities,
  parseHlsSegments,
  sortVariantsDesc,
  uniqueVariantId,
  variantLabel,
  type HlsSegment,
  type HlsSegmentsResult,
} from './hls';
import { drmSystemsInMpd } from './drm';

export interface DashParseResult {
  isMaster: boolean;
  variants: VariantInfo[];
  /**
   * W7.1 — DASH khai DRM ngay trong manifest qua `<ContentProtection>`. Trước W7.1 ta KHÔNG đọc thẻ
   * này, nên video DRM lọt qua bước "Chất lượng" rồi mới hỏng ở tận khâu tải — khó hiểu với user.
   */
  isProtected: boolean;
  /** Tên các hệ thống DRM đã khai (để nói ĐÚNG cái gì chặn, không phải câu chung chung). */
  drmSystems: string[];
}

/**
 * Một track DASH (hình hoặc tiếng) kèm danh tính đã chốt.
 *
 * 🔴 VÌ SAO ĐÁNH ID CHUNG MỘT LƯỢT cho cả hình lẫn tiếng: `parseDashSegments` tra track theo id.
 * Nếu hình và tiếng đánh số ở hai không gian tên riêng thì một id có thể trỏ vào HAI track —
 * chọn 1080p mà tải nhầm tiếng, không một dòng lỗi. Một `used` duy nhất, một thứ tự duy nhất
 * (hình trước, tiếng sau) làm `dashTracks()` thành NGUỒN SỰ THẬT DUY NHẤT về danh tính.
 */
interface DashTrack {
  id: string;
  kind: 'video' | 'audio';
  playlist: MpdPlaylist;
  /** Nhãn của AdaptationSet tiếng (chỉ track tiếng mới có). */
  label?: string;
  groupId?: string;
  language?: string;
  isDefault?: boolean;
}

/**
 * Liệt kê MỌI track của một MPD với id duy nhất toàn cục.
 *
 * ⚠️ Đừng tra theo `attributes.NAME` trực tiếp ở nơi khác: DASH chỉ đòi `Representation@id` duy
 * nhất TRONG một AdaptationSet, nên hai AdaptationSet vẫn có thể cùng khai `id="1"`.
 * `uniqueVariantId` tách chúng bằng hậu tố, và mọi chỗ khác PHẢI dùng lại đúng id đã tách đó.
 */
function dashTracks(manifest: MpdManifest): DashTrack[] {
  const used = new Set<string>();
  const out: DashTrack[] = [];

  const playlists = manifest.playlists ?? [];
  playlists.forEach((p, index) => {
    out.push({
      id: uniqueVariantId(p.attributes?.NAME, index, used),
      kind: 'video',
      playlist: p,
    });
  });

  // Tiếng nằm ở mediaGroups.AUDIO[group][label].playlists[] (đã đo thật ở mpd-parser@1.4.0).
  const groups = manifest.mediaGroups?.AUDIO ?? {};
  let audioIndex = playlists.length;
  for (const [groupId, group] of Object.entries(groups)) {
    for (const [label, rendition] of Object.entries(group)) {
      for (const p of rendition.playlists ?? []) {
        out.push({
          id: uniqueVariantId(p.attributes?.NAME, audioIndex, used),
          kind: 'audio',
          playlist: p,
          label,
          groupId,
          ...(rendition.language !== undefined
            ? { language: rendition.language }
            : {}),
          isDefault: rendition.default === true,
        });
        audioIndex++;
      }
    }
  }
  return out;
}

/**
 * Rendition tiếng cho popup chọn.
 *
 * ⚠️ KHÔNG dùng lại `renditionsForVariant` của HLS: hàm đó chốt "cái được chọn" bằng so sánh
 * `uri`, mà DASH SegmentTemplate cho MỌI track cùng một `resolvedUri` (chính file .mpd). So theo
 * uri ở đây thì KHÔNG BAO GIỜ có cái nào `selected` -> popup không tìm ra tiếng -> ghép ra file
 * CÂM mà không một tầng nào báo lỗi. Đúng căn bệnh §2.1 mà W1.1 sinh ra để chữa.
 * Vì vậy DASH chọn theo `default` rồi tới cái đầu, và định danh bằng `id`, không bằng `uri`.
 */
function audioRenditionsOf(
  tracks: DashTrack[],
  manifestUrl: string,
): RenditionInfo[] | undefined {
  const audio = tracks.filter((t) => t.kind === 'audio');
  if (audio.length === 0) return undefined;
  const chosen = audio.find((t) => t.isDefault) ?? audio[0];
  return audio.map((t) => ({
    id: t.id,
    groupId: t.groupId ?? 'audio',
    name: t.label ?? t.id,
    // DASH định danh track bằng `id`; `uri` chỉ để tầng spoof/estimate có một URL thật mà dùng.
    uri: t.playlist.resolvedUri ?? manifestUrl,
    ...(t.language !== undefined ? { language: t.language } : {}),
    default: t.isDefault === true,
    autoselect: t.isDefault === true,
    ...(t === chosen ? { selected: true } : {}),
  }));
}

export function parseDashManifest(
  text: string,
  manifestUrl: string,
): DashParseResult {
  const manifest = parse(text, { manifestUri: manifestUrl });
  const tracks = dashTracks(manifest);
  const audioRenditions = audioRenditionsOf(tracks, manifestUrl);

  const variants: VariantInfo[] = tracks
    .filter((t) => t.kind === 'video')
    .map((t, index) => {
      const attr = t.playlist.attributes ?? {};
      const res = attr.RESOLUTION;
      const base = variantLabel(res?.height, attr.BANDWIDTH);
      return {
        // Danh tính THẬT của DASH là Representation@id — mpd-parser để ở attributes.NAME.
        // Với SegmentTemplate thì `uri` của mọi representation đều là chính file .mpd nên vô dụng.
        id: t.id,
        // 🔴 LUÔN là URL manifest, KHÔNG phải `resolvedUri`.
        // Với SegmentBase, `resolvedUri` là chính file .mp4 — trả về nó thì mọi tầng dưới
        // (estimate, dò host spoof, offscreen) vốn coi `variantUrl` là TÀI LIỆU MANIFEST sẽ
        // fetch nguyên file video rồi `res.text()` và parse như XML. Danh tính track của DASH
        // nằm ở `id`, nên `uri` chỉ cần chỉ đúng chỗ lấy manifest.
        uri: manifestUrl,
        // Không có độ phân giải thì thêm số thứ tự để phân biệt.
        name: res?.height ? base : `${base} #${index + 1}`,
        bandwidth: attr.BANDWIDTH,
        width: res?.width,
        height: res?.height,
        codecs: attr.CODECS,
        // DASH LUÔN tách tiếng -> mang sẵn danh sách để popup gửi kèm `audioId` khi tải.
        ...(audioRenditions ? { audioRenditions } : {}),
      };
    });

  sortVariantsDesc(variants);
  // Soi trên TEXT gốc, không qua mpd-parser: mpd-parser bỏ qua <ContentProtection> hoàn toàn.
  const drmSystems = drmSystemsInMpd(text);
  return {
    isMaster: variants.length > 1,
    variants,
    isProtected: drmSystems.length > 0,
    drmSystems,
  };
}

/**
 * Parse segment theo ĐÚNG định dạng của manifest — điểm rẽ DUY NHẤT giữa HLS và DASH.
 *
 * 🔴 Vì sao phải có: `parseHlsSegments` nuốt XML mà KHÔNG ném lỗi — m3u8-parser trả về manifest
 * rỗng. Nạp một .mpd vào nó thì ước lượng báo "0 segment", khâu dò host spoof tìm ra 0 host, và
 * job chạy tới 'fetching' rồi 403 sạch. Tất cả đều XANH và IM LẶNG. Mọi nơi từng gọi thẳng
 * `parseHlsSegments` trên một URL do user chọn PHẢI đi qua đây.
 *
 * ⚠️ Kiểu `'hls' | 'dash'` viết tay chứ KHÔNG import `ManifestKind` từ `messages.ts`:
 * `messages.ts` kéo theo `storage.ts`, mà file này được offscreen import — nơi `chrome.storage`
 * KHÔNG tồn tại. Một import nhầm ở đây là TypeError lúc chạy mà tsc/eslint/vitest đều không thấy.
 */
export function parseTrackSegments(
  text: string,
  url: string,
  mediaType: 'hls' | 'dash' | undefined,
  trackId?: string,
): HlsSegmentsResult {
  return mediaType === 'dash'
    ? parseDashSegments(text, url, trackId)
    : parseHlsSegments(text, url);
}

/** Chuyển một segment mpd-parser sang đúng shape `HlsSegment`. */
function toHlsSegment(s: MpdSegment, index: number): HlsSegment {
  return {
    // resolvedUri đã tuyệt đối sẵn (mpd-parser resolve theo BaseURL + manifestUri).
    uri: s.resolvedUri ?? s.uri ?? '',
    duration: typeof s.duration === 'number' ? s.duration : 0,
    // DASH không có media sequence; `seq` chỉ dùng làm IV mặc định của AES-128 HLS nên ở đây là
    // số trơ. Vẫn điền chỉ số để trường bắt buộc có giá trị xác định.
    seq: index,
    // Cố ý KHÔNG có keyMethod/keyUri/iv: mã hoá của DASH là CENC = DRM, thuộc ranh giới TỪ CHỐI
    // (§7), không phải thứ để giải mã. Nhờ vậy nhánh AES-128 ở offscreen thành nhánh chết.
    ...(s.map?.resolvedUri ? { initUri: s.map.resolvedUri } : {}),
    ...(s.byterange ? { byterange: s.byterange } : {}),
    ...(s.map?.byterange ? { initByterange: s.map.byterange } : {}),
  };
}

/**
 * Từ MPD + id track -> danh sách segment ĐÚNG shape `HlsSegmentsResult`.
 *
 * Trả về đúng kiểu mà `downloadTrack` ở offscreen đang nhận, nên DASH dùng lại NGUYÊN bộ máy
 * fetch/backpressure/retry/mux của HLS thay vì mọc thêm một đường tải thứ hai.
 */
export function parseDashSegments(
  text: string,
  manifestUrl: string,
  trackId?: string,
): HlsSegmentsResult {
  const manifest = parse(text, { manifestUri: manifestUrl });
  const tracks = dashTracks(manifest);
  const track =
    (trackId !== undefined
      ? tracks.find((t) => t.id === trackId)
      : undefined) ?? tracks.find((t) => t.kind === 'video');

  const drmSystems = drmSystemsInMpd(text);
  const base: HlsSegmentsResult = {
    segments: [],
    encryption: 'none',
    isProtected: drmSystems.length > 0,
    totalDuration: 0,
    hasInit: false,
    discontinuityCount: 0,
  };
  if (!track) {
    return {
      ...base,
      unsupportedReason: `Không tìm thấy luồng "${trackId ?? '?'}" trong manifest DASH.`,
    };
  }

  const raw = track.playlist.segments ?? [];
  const segments = raw.map(toHlsSegment);
  const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);

  // SegmentBase/BaseURL: mpd-parser KHÔNG dựng segment (đo thật) nhưng `resolvedUri` LÀ file media
  // tải thẳng được. Báo "playlist không có segment nào" ở đây là đúng chữ mà sai hẳn nguyên nhân,
  // nên chỉ ra đường tải thẳng để tầng trên định tuyến sang luồng progressive.
  if (segments.length === 0) {
    const direct = track.playlist.resolvedUri;
    // Giữ `directUrl` để gói sau định tuyến sang luồng progressive, NHƯNG vẫn phải nêu lý do
    // ngay bây giờ: chưa có ai tiêu thụ `directUrl` cả, nên im lặng ở đây nghĩa là job chết với
    // câu "playlist không có segment nào" — đúng ngõ cụt khó hiểu mà nhánh này sinh ra để tránh.
    if (direct && direct !== manifestUrl) {
      return {
        ...base,
        directUrl: direct,
        unsupportedReason:
          'Representation DASH này là một tệp liền (SegmentBase) chứ không chia segment — chưa hỗ trợ tải dạng này.',
      };
    }
    return {
      ...base,
      unsupportedReason: 'Manifest DASH không khai segment nào tải được.',
    };
  }

  // 🔴 Đa Period: mpd-parser TỰ KHÂU các Period thành MỘT playlist, còn `downloadTrack` chỉ nạp
  // init ĐẦU TIÊN rồi nối mọi segment ra sau nó. ffmpeg vẫn nhận, job vẫn "xong", file thì SAI.
  //
  // 🔬 ĐO THẬT (mpd-parser@1.4.0) — bản đầu của guard này soi "có nhiều init khác nhau không" và
  // ĐÃ SAI: với SegmentTemplate, `initialization` nội suy ra CÙNG một URI ở mọi Period nên chỉ có
  // 1 init, guard không bao giờ bắn. Tệ hơn: `startNumber` reset mỗi Period nên URL segment LẶP
  // (đo được: seg-1, seg-2, seg-1, seg-2) -> ghép mù ra CÙNG 10 giây nối hai lần, đóng gói thành
  // video 20 giây. Tín hiệu ĐÚNG là `discontinuityStarts` — mpd-parser luôn điền khi khâu Period.
  const periodStarts = track.playlist.discontinuityStarts ?? [];
  const inits = new Set(
    segments.map((s) => s.initUri).filter((u): u is string => Boolean(u)),
  );
  const result: HlsSegmentsResult = {
    segments,
    encryption: 'none',
    isProtected: drmSystems.length > 0,
    totalDuration,
    hasInit: inits.size > 0,
    // W1.4 — điền cho ĐỦ hợp đồng. Với DASH con số này chỉ để BÁO CÁO: ranh giới Period bị guard
    // ngay bên dưới TỪ CHỐI thẳng, chứ không hạ xuống mức cảnh báo như HLS.
    discontinuityCount: countDiscontinuities(
      track.playlist.segments ?? [],
      periodStarts,
    ),
  };
  if (periodStarts.length > 0 || inits.size > 1) {
    return {
      ...result,
      unsupportedReason:
        'Manifest DASH có nhiều Period (thường do chèn quảng cáo) — ghép thẳng lại sẽ ra file sai, nên chưa hỗ trợ.',
    };
  }
  return result;
}
