// Parse DASH manifest (.mpd) THUẦN -> danh sách representation chất lượng.
// mpd-parser chuẩn hoá MPD về dạng giống HLS (playlists[] + attributes + resolvedUri tuyệt đối).

import { parse } from 'mpd-parser';
import type { VariantInfo } from './types';
import { sortVariantsDesc, variantLabel } from './hls';

export interface DashParseResult {
  isMaster: boolean;
  variants: VariantInfo[];
}

export function parseDashManifest(
  text: string,
  manifestUrl: string,
): DashParseResult {
  const manifest = parse(text, { manifestUri: manifestUrl });
  const playlists = manifest.playlists ?? [];

  const variants: VariantInfo[] = playlists.map((p, index) => {
    const attr = p.attributes ?? {};
    const res = attr.RESOLUTION;
    const base = variantLabel(res?.height, attr.BANDWIDTH);
    return {
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
  return { isMaster: variants.length > 1, variants };
}
