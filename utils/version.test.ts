import { describe, expect, it } from 'vitest';
import { formatVersionLabel } from './version';

describe('formatVersionLabel', () => {
  it('ghép thành "<name> v<version>"', () => {
    expect(formatVersionLabel('Your Video Is Mine', '0.1.0')).toBe(
      'Your Video Is Mine v0.1.0',
    );
  });
});
