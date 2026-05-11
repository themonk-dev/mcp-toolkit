/**
 * `none` strategy — no authentication. Always passes verify().
 *
 * Use when the MCP server should be wide open (development, anonymous tools).
 */

import type { AuthStrategy, AuthStrategyKind } from '../types.ts';

export interface NoneStrategyOptions {
  /** Override the kind name reported back from the strategy. */
  kind?: AuthStrategyKind;
}

export function noneStrategy(opts: NoneStrategyOptions = {}): AuthStrategy {
  const kind: AuthStrategyKind = opts.kind ?? 'none';
  return {
    kind,
    async verify(): Promise<{
      ok: true;
      resolvedHeaders: Record<string, string>;
    }> {
      return { ok: true, resolvedHeaders: {} };
    },
    protectedResourceMetadata() {
      return null;
    },
  };
}
