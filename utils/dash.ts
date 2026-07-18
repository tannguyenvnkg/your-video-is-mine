// Parse DASH manifest (.mpd) THUẦN -> danh sách representation chất lượng.
// mpd-parser chuẩn hoá MPD về dạng giống HLS (playlists[] + attributes + resolvedUri tuyệt đối).

import { parse } from 'mpd-parser';
import type { VariantInfo } from './types';
import { sortVariantsDesc, uniqueVariantId, variantLabel } from './hls';
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

export function parseDashManifest(
  text: string,
  manifestUrl: string,
): DashParseResult {
  const manifest = parse(text, { manifestUri: manifestUrl });
  const playlists = manifest.playlists ?? [];

  const usedIds = new Set<string>();
  const variants: VariantInfo[] = playlists.map((p, index) => {
    const attr = p.attributes ?? {};
    const res = attr.RESOLUTION;
    const base = variantLabel(res?.height, attr.BANDWIDTH);
    return {
      // Danh tính THẬT của DASH là Representation@id — mpd-parser để ở attributes.NAME.
      // Với SegmentTemplate thì `uri` của mọi representation đều là chính file .mpd nên vô dụng.
      id: uniqueVariantId(attr.NAME, index, usedIds),
      // resolvedUri đã tuyệt đối; fallback uri rồi manifestUrl.
      uri: p.resolvedUri ?? p.uri ?? manifestUrl,
      // Không có độ phân giải thì thêm số thứ tự để phân biệt.
      name: res?.height ? base : `${base} #${index + 1}`,
      bandwidth: attr.BANDWIDTH,
      width: res?.width,
      height: res?.height,
      codecs: attr.CODECS,
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
