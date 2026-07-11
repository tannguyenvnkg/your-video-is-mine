// Xây dựng session rule cho chrome.declarativeNetRequest để SPOOF Referer/Origin,
// vượt hotlink-protection/403 ở mức KHÔNG-DRM. MV3 webRequest chỉ QUAN SÁT (không sửa được
// header) -> phải dùng DNR (declarativeNetRequestWithHostAccess) để sửa request header.
// Logic thuần (không phụ thuộc chrome API) -> unit test được.

export interface DnrModifyHeader {
  header: string;
  operation: 'set' | 'remove';
  value?: string;
}

export interface DnrRule {
  id: number;
  priority: number;
  action: {
    type: 'modifyHeaders';
    requestHeaders: DnrModifyHeader[];
  };
  condition: {
    requestDomains: string[];
    resourceTypes: string[];
  };
}

/** hostname của URL, hoặc null nếu URL không hợp lệ. */
export function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** origin (scheme://host[:port]) của URL, hoặc null. */
export function originFromUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** id rule ổn định (>= 2000) suy từ host -> re-add cùng host sẽ thay thế, không tích luỹ. */
export function spoofRuleId(host: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < host.length; i++) {
    h ^= host.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 2000 + ((h >>> 0) % 1_000_000);
}

// Áp cho các loại request thường mang media/segment.
const SPOOFED_RESOURCE_TYPES = [
  'xmlhttprequest',
  'media',
  'other',
  'sub_frame',
  'object',
];

/** Rule set Referer + Origin cho mọi request tới `host`. */
export function buildRefererSpoofRule(
  host: string,
  referer: string,
  origin: string,
): DnrRule {
  return {
    id: spoofRuleId(host),
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'referer', operation: 'set', value: referer },
        { header: 'origin', operation: 'set', value: origin },
      ],
    },
    condition: {
      requestDomains: [host],
      resourceTypes: SPOOFED_RESOURCE_TYPES,
    },
  };
}
