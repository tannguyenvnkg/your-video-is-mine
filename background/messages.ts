import type { RuntimeMessage } from '@/utils/messages';

export function isOffscreenTargeted(m: unknown): boolean {
  return (
    typeof m === 'object' &&
    m !== null &&
    (m as { target?: unknown }).target === 'offscreen'
  );
}

export function isRuntimeMessage(m: unknown): m is RuntimeMessage {
  return typeof m === 'object' && m !== null && 'kind' in m;
}
