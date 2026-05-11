import { redactSensitiveData } from '@mcp-toolkit/core';
import { defineResource } from '@mcp-toolkit/mcp';

/**
 * Resolve a runtime env-like record without taking a hard dep on the host
 * config module. Reads `process.env` when available (Node, Bun) and falls
 * back to `globalThis.env` (Cloudflare Workers binding pattern). Returns an
 * empty object when neither is present.
 */
function resolveEnvSnapshot(): Record<string, unknown> {
  const g = globalThis as Record<string, unknown>;
  const proc = g.process as { env?: Record<string, unknown> } | undefined;
  if (proc && proc.env && typeof proc.env === 'object') {
    return { ...proc.env };
  }
  const wEnv = g.env;
  if (wEnv && typeof wEnv === 'object') {
    return { ...(wEnv as Record<string, unknown>) };
  }
  return {};
}

/**
 * Server configuration resource — exposes a redacted snapshot of the running
 * environment. Sensitive keys (`*token*`, `*secret*`, `*key*`, `*password*`,
 * `*authorization*`, `*apikey*`) are replaced with `[REDACTED]` by
 * `redactSensitiveData` from `@mcp-toolkit/core`.
 *
 * Env coupling: read at handler-call time via `process.env` / `globalThis.env`.
 * No factory injection is needed — this keeps the resource self-contained and
 * lets the host swap the underlying env without re-registering.
 */
export const configResource = defineResource({
  uri: 'config://server',
  name: 'Server Configuration',
  description: 'Current server configuration (sensitive data redacted)',
  mimeType: 'application/json',
  handler: async () => {
    const safe = redactSensitiveData(resolveEnvSnapshot());
    return {
      contents: [
        {
          uri: 'config://server',
          mimeType: 'application/json',
          text: JSON.stringify(safe, null, 2),
        },
      ],
    };
  },
});
