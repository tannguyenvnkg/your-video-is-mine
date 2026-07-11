import { describe, expect, it } from 'vitest';
import {
  buildRefererSpoofRule,
  hostFromUrl,
  originFromUrl,
  spoofRuleId,
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

describe('spoofRuleId', () => {
  it('ổn định & >= 2000', () => {
    const a = spoofRuleId('cdn.example.com');
    expect(a).toBe(spoofRuleId('cdn.example.com'));
    expect(a).toBeGreaterThanOrEqual(2000);
  });
  it('host khác -> id khác', () => {
    expect(spoofRuleId('a.com')).not.toBe(spoofRuleId('b.com'));
  });
});

describe('buildRefererSpoofRule', () => {
  const rule = buildRefererSpoofRule(
    'cdn.example.com',
    'https://page.example.com/watch',
    'https://page.example.com',
  );

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

  it('condition giới hạn theo host + resourceTypes', () => {
    expect(rule.condition.requestDomains).toEqual(['cdn.example.com']);
    expect(rule.condition.resourceTypes).toContain('xmlhttprequest');
    expect(rule.condition.resourceTypes).toContain('media');
  });

  it('id khớp spoofRuleId(host)', () => {
    expect(rule.id).toBe(spoofRuleId('cdn.example.com'));
  });
});
