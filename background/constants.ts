import type { HlsPhase } from '@/utils/storage';

// Terminal phase of an HLS job (done/error/cancelled) — used for both the badge and spoof-rule reconciliation.
export const TERMINAL_PHASES = new Set<HlsPhase>([
  'done',
  'error',
  'cancelled',
]);
