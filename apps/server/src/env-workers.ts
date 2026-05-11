/**
 * Workers config loader.
 *
 * Thin wrapper around `loadConfigFromStrings`. Workers have no filesystem,
 * so `POLICY.path` is unsupported — operators must inline `POLICY.content`
 * (or wire a separate KV binding outside the env map). Setting `POLICY.path`
 * on Workers is a loud error at boot, not a silent fallback.
 *
 * **Strictly no `node:*` imports.**
 */

import { sharedLogger as logger } from '@mcp-toolkit/core';
import type { AppConfig } from './config.ts';
import { type EnvStringMap, loadConfigFromStrings } from './env-loader.ts';

/**
 * Filter Workers bindings to the grouped env-string entries. KV / D1 /
 * Queue bindings are objects and would not parse as JSON; the runtime
 * config surface is exactly these string keys.
 */
function pickEnvVars(bindings: Record<string, unknown>): EnvStringMap {
  const keys = [
    'SERVER',
    'RUNTIME',
    'AUTH',
    'AUTH_KEYS',
    'AUTH_OAUTH',
    'MCP',
    'MCP_ICON',
    'STORAGE',
    'POLICY',
    'CONNECTED_SERVERS',
  ] as const;
  const out: EnvStringMap = {};
  for (const k of keys) {
    const v = bindings[k];
    if (typeof v === 'string') {
      out[k] = v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = String(v);
    }
  }
  return out;
}

/**
 * Workers cannot read files. If `POLICY` carries `{ path }`, fail loudly at
 * boot — silently dropping the path would mean the server runs without the
 * policy the operator configured.
 */
function rejectPolicyPath(env: EnvStringMap): void {
  if (!env.POLICY || env.POLICY.trim() === '') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.POLICY);
  } catch {
    // Defer to the shared loader's JSON-parse error.
    return;
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    'path' in (parsed as Record<string, unknown>)
  ) {
    throw new Error(
      'POLICY.path is not supported on Workers; use POLICY.content (inline YAML/JSON).',
    );
  }
}

export function loadWorkersConfig(bindings: Record<string, unknown>): AppConfig {
  const env = pickEnvVars(bindings);
  try {
    rejectPolicyPath(env);
    return loadConfigFromStrings(env);
  } catch (error) {
    logger.error('env_workers', { message: (error as Error).message });
    throw error;
  }
}
