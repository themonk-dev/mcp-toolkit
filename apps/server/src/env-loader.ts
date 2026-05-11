/**
 * Grouped JSON config loader.
 *
 * The operator-facing config surface is a small set of env vars whose values
 * are JSON-encoded objects (per domain). This module reads those strings,
 * parses each as JSON, composes them into the `AppConfig` input shape, and
 * validates via `appConfigSchema`. Runtime-agnostic — no `node:*` imports.
 *
 * Layout (9 env vars):
 *   SERVER       — host, port, allowedOrigins
 *   RUNTIME      — nodeEnv, logLevel, rpsLimit, concurrencyLimit
 *   AUTH         — strategy, requireRs, resourceUri, discoveryUrl
 *   AUTH_KEYS    — apikey, bearer, custom, jwt sub-objects
 *   AUTH_OAUTH   — oauth, oidc, provider, cimd sub-objects
 *   MCP          — title, version, instructions, protocolVersion, userAuditOnList
 *   MCP_ICON     — { url, mime, sizes }
 *   STORAGE      — tokensFile, tokensEncKey
 *   POLICY       — { content }   (or { path } on Node — folded by env-node.ts first)
 *
 * Composition shape (what the loader passes to `appConfigSchema`):
 *   {
 *     server: { ...SERVER, ...RUNTIME },
 *     auth:   { ...AUTH, ...AUTH_KEYS, ...AUTH_OAUTH },
 *     mcp:    { ...MCP, icon: MCP_ICON },
 *     storage: STORAGE,
 *     policy:  POLICY,
 *   }
 *
 * Per-group shallow merge is safe because keys within each parent namespace
 * are disjoint by design (the layout above was picked specifically for this).
 */

import { type AppConfig, appConfigSchema } from './config.ts';

export interface EnvStringMap {
  SERVER?: string;
  RUNTIME?: string;
  AUTH?: string;
  AUTH_KEYS?: string;
  AUTH_OAUTH?: string;
  MCP?: string;
  MCP_ICON?: string;
  STORAGE?: string;
  POLICY?: string;
}

/**
 * Parse one env var as a JSON object. Returns `{}` for unset / empty values
 * so callers can rely on zod schema defaults. Throws with a clear, prefixed
 * message on malformed JSON or non-object inputs (arrays / primitives /
 * null).
 */
function parseJsonVar(name: string, raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${name}: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `${name} must be a JSON object, got ${Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed}`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Compose and validate. Returns a typed `AppConfig` or throws a single
 * `Invalid config: …` error listing all zod issues with their nested paths
 * (so operators see `server.port: …` rather than just `port: …`).
 */
export function loadConfigFromStrings(env: EnvStringMap): AppConfig {
  const server = parseJsonVar('SERVER', env.SERVER);
  const runtime = parseJsonVar('RUNTIME', env.RUNTIME);
  const authMeta = parseJsonVar('AUTH', env.AUTH);
  const authKeys = parseJsonVar('AUTH_KEYS', env.AUTH_KEYS);
  const authOauth = parseJsonVar('AUTH_OAUTH', env.AUTH_OAUTH);
  const mcpMeta = parseJsonVar('MCP', env.MCP);
  const mcpIcon = parseJsonVar('MCP_ICON', env.MCP_ICON);
  const storage = parseJsonVar('STORAGE', env.STORAGE);
  const policy = parseJsonVar('POLICY', env.POLICY);

  const composed = {
    server: { ...server, ...runtime },
    auth: { ...authMeta, ...authKeys, ...authOauth },
    mcp: { ...mcpMeta, icon: mcpIcon },
    storage,
    policy: { content: policy.content as string | undefined },
  };

  const result = appConfigSchema.safeParse(composed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid config: ${issues}`);
  }
  return result.data;
}
