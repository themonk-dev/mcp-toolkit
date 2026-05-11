/**
 * Node-only config loader.
 *
 * Thin wrapper around `loadConfigFromStrings`. The only Node-specific work is
 * resolving `POLICY.path` to file bytes via `node:fs.readFileSync` before
 * handing the env map to the shared loader — so the policy package never
 * sees a file path. This is the **only** env file allowed to import `node:*`.
 *
 * Operators write grouped JSON env vars (see `.env.example`). Flat keys like
 * `AUTH_STRATEGY` / `API_KEY` are no longer read.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { sharedLogger as logger } from '@mcp-toolkit/core';
import type { AppConfig } from './config.ts';
import { type EnvStringMap, loadConfigFromStrings } from './env-loader.ts';

/**
 * If `POLICY` carries a `{ path }` key (Node-only convenience), read the
 * file and rewrite the env entry to `{ content: <bytes> }`. Inline `content`
 * always wins over `path` if both are present.
 *
 * Failures here are fatal — a misconfigured policy pointer should crash the
 * server, not silently disable policy.
 */
function resolvePolicyPath(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const raw = source.POLICY;
  if (!raw || raw.trim() === '') return source;

  let parsed: { content?: unknown; path?: unknown };
  try {
    parsed = JSON.parse(raw) as { content?: unknown; path?: unknown };
  } catch {
    // Let the shared loader surface the JSON-parse error with its consistent prefix.
    return source;
  }

  if (typeof parsed.content === 'string' && parsed.content.length > 0) {
    return source;
  }
  if (typeof parsed.path !== 'string' || parsed.path.trim() === '') {
    return source;
  }

  const absolute = resolvePath(process.cwd(), parsed.path.trim());
  let body: string;
  try {
    body = readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new Error(
      `Failed to read POLICY.path (${absolute}): ${(error as Error).message}`,
    );
  }
  return { ...source, POLICY: JSON.stringify({ content: body }) };
}

/**
 * Pull the grouped JSON env vars out of `process.env` into an
 * `EnvStringMap`. Anything else is ignored — the runtime config surface is
 * exactly these keys.
 */
function pickEnvVars(source: NodeJS.ProcessEnv): EnvStringMap {
  return {
    SERVER: source.SERVER,
    RUNTIME: source.RUNTIME,
    AUTH: source.AUTH,
    AUTH_KEYS: source.AUTH_KEYS,
    AUTH_OAUTH: source.AUTH_OAUTH,
    MCP: source.MCP,
    MCP_ICON: source.MCP_ICON,
    STORAGE: source.STORAGE,
    POLICY: source.POLICY,
    CONNECTED_SERVERS: source.CONNECTED_SERVERS,
  };
}

export function loadNodeConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const resolved = resolvePolicyPath(source);
  try {
    return loadConfigFromStrings(pickEnvVars(resolved));
  } catch (error) {
    logger.error('env_node', { message: (error as Error).message });
    throw error;
  }
}
