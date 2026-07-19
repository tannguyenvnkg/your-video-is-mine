import { describe, expect, it } from 'vitest';
import {
  buildHeaderSpoofRule,
  buildRefererSpoofRule,
  hostFromUrl,
  originFromUrl,
  SPOOF_RULE_ID_MIN,
  staleSpoofRuleIds,
} from './dnr';

describe('hostFromUrl / originFromUrl', () => {
  it('lấy host & origin', () => {
    expect(hostFromUrl('https://cdn.example.com:8443/a/b.ts?x=1')).toBe(
      'cdn.example.com',
    );
    expect(originFromUrl('https://cdn.example.com:8443/a/b.ts')).toBe(
      'https://cdn.example.com:8443',
    );
  });
  it('URL sai -> null', () => {
    expect(hostFromUrl('not a url')).toBeNull();
    expect(originFromUrl('not a url')).toBeNull();
  });
});

describe('buildRefererSpoofRule', () => {
  const rule = buildRefererSpoofRule(
    2345,
    'cdn.example.com',
    'https://page.example.com/watch',
    'https://page.example.com',
  );

  it('nhận id TƯỜNG MINH (W2.4: id theo từng download, không suy từ host)', () => {
    // Trước W2.4 id = hash(host) -> hai download cùng CDN giật rule của nhau (§2.10). Nay caller
    // cấp id riêng cho mỗi (download, host) nên builder chỉ việc dùng nguyên id truyền vào.
    expect(rule.id).toBe(2345);
  });

  it('modifyHeaders set Referer + Origin', () => {
    expect(rule.action.type).toBe('modifyHeaders');
    const headers = rule.action.requestHeaders;
    expect(headers).toEqual([
      {
        header: 'referer',
        operation: 'set',
        value: 'https://page.example.com/watch',
      },
      { header: 'origin', operation: 'set', value: 'https://page.example.com' },
    ]);
  });

  it('condition giới hạn theo host + resourceTypes của EXTENSION', () => {
    expect(rule.condition.requestDomains).toEqual(['cdn.example.com']);
    expect(rule.condition.resourceTypes).toContain('xmlhttprequest');
    expect(rule.condition.resourceTypes).toContain('other');
  });

  it('W2.4: KHÔNG spoof loại request của PLAYER TRANG (media/sub_frame/object)', () => {
    // §2.10: rule cũ phủ media/sub_frame/object -> ghi đè Referer/Origin lên chính traffic của
    // trang (player, iframe) -> user thấy player hỏng / API 403 / bị đăng xuất. Bỏ hẳn 3 loại này.
    expect(rule.condition.resourceTypes).not.toContain('media');
    expect(rule.condition.resourceTypes).not.toContain('sub_frame');
    expect(rule.condition.resourceTypes).not.toContain('object');
  });

  it('W2.4: tabIds:[-1] -> CHỈ khớp request do extension phát, không đụng traffic trang', () => {
    // -1 = request không gắn với tab nào (do SW/offscreen của extension phát). Một dòng này biến
    // lỗ hổng từ "gây hại cho duyệt web" thành "chỉ ảnh hưởng fetch của chính extension".
    expect(rule.condition.tabIds).toEqual([-1]);
  });
});

describe('staleSpoofRuleIds (đối soát rule rò rỉ — W2.4 sweep)', () => {
  it('xoá id spoof KHÔNG còn job sống, GIỮ id còn sống', () => {
    const session = [
      SPOOF_RULE_ID_MIN,
      SPOOF_RULE_ID_MIN + 1,
      SPOOF_RULE_ID_MIN + 2,
    ];
    const alive = [SPOOF_RULE_ID_MIN + 1];
    expect(staleSpoofRuleIds(session, alive)).toEqual([
      SPOOF_RULE_ID_MIN,
      SPOOF_RULE_ID_MIN + 2,
    ]);
  });

  it('KHÔNG bao giờ đụng rule id < ngưỡng (rule của người khác / dải khác)', () => {
    // Sweep chỉ được phép dọn trong dải rule spoof của ta (>= MIN). Rule id nhỏ hơn là của cơ chế
    // khác -> tuyệt đối không xoá dù không có trong tập "còn sống".
    const session = [1, 42, 1999, SPOOF_RULE_ID_MIN];
    expect(staleSpoofRuleIds(session, [])).toEqual([SPOOF_RULE_ID_MIN]);
  });

  it('tập sống rỗng + không rule spoof nào -> không xoá gì', () => {
    expect(staleSpoofRuleIds([1, 2, 3], [])).toEqual([]);
  });
});

// ── W2.1 ─────────────────────────────────────────────────────────────────────────────────────
describe('buildHeaderSpoofRule — phát lại header THẬT của player', () => {
  it('sinh đúng một mục modifyHeaders cho mỗi header được giao', () => {
    const rule = buildHeaderSpoofRule(SPOOF_RULE_ID_MIN, 'cdn.example', {
      referer: 'https://site.example/watch',
      'x-playback-session-id': 'sess-9',
    });
    expect(rule.action.requestHeaders).toEqual([
      {
        header: 'referer',
        operation: 'set',
        value: 'https://site.example/watch',
      },
      { header: 'x-playback-session-id', operation: 'set', value: 'sess-9' },
    ]);
  });

  it('🔴 KHÔNG tự thêm Origin khi không được giao (quy tắc vàng §2.11)', () => {
    // Bản BỊA cũ luôn kèm Origin. Player thật thường không gửi Origin trên GET, và một số CDN
    // 403 chính vì cái Origin lạ đó -> rule "chống 403" tự gây 403.
    const rule = buildHeaderSpoofRule(SPOOF_RULE_ID_MIN, 'cdn.example', {
      referer: 'https://site.example/',
    });
    expect(rule.action.requestHeaders.map((h) => h.header)).toEqual([
      'referer',
    ]);
  });

  it('giữ nguyên bán kính sát thương đã thu hẹp ở W2.4 (tabIds:[-1], không có media/sub_frame)', () => {
    const rule = buildHeaderSpoofRule(SPOOF_RULE_ID_MIN, 'cdn.example', {
      referer: 'https://site.example/',
    });
    expect(rule.condition.tabIds).toEqual([-1]);
    expect(rule.condition.requestDomains).toEqual(['cdn.example']);
    expect(rule.condition.resourceTypes).not.toContain('media');
    expect(rule.condition.resourceTypes).not.toContain('sub_frame');
  });

  it('header rỗng -> rule không có mục nào (caller phải tự tránh áp rule vô nghĩa)', () => {
    expect(
      buildHeaderSpoofRule(SPOOF_RULE_ID_MIN, 'cdn.example', {}).action
        .requestHeaders,
    ).toEqual([]);
  });
});
