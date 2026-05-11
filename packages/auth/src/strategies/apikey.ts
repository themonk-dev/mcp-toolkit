/**
 * Static-credential strategies: API key, static bearer token, and arbitrary
 * custom headers. They share a single file because they collapse the legacy
 * `bearer` and `custom` AUTH_STRATEGY values into the same family.
 *
 * All comparisons use a constant-time compare implemented with Web APIs
 * (`TextEncoder` + bitwise XOR) so the same code runs in Node and in
 * Cloudflare Workers — `crypto.timingSafeEqual` is Node-only and is **not**
 * used here.
 */

import { sharedLogger as logger } from '@mcp-toolkit/core';
import type { AuthStrategy, AuthVerifyResult } from '../types.ts';

// ─────────────────────────────────────────────────────────────────────────
// Constant-time compare (Web Crypto safe, runtime-agnostic)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Compare two strings in constant time. Returns true iff they encode to the
 * same byte sequence under UTF-8.
 *
 * Length mismatch short-circuits to `false` — by the time an attacker can
 * influence string length they already know it. The XOR loop guarantees
 * O(min(len)) work for equal-length inputs.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse `"X-Header-1:value1,X-Header-2:value2"` into a header map.
 * Header names are lowercased to match Web Fetch normalization.
 */
export function parseCustomHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};

  const headers: Record<string, string> = {};
  const pairs = value.split(',');

  for (const pair of pairs) {
    const colonIndex = pair.indexOf(':');
    if (colonIndex === -1) continue;

    const key = pair.slice(0, colonIndex).trim();
    const val = pair.slice(colonIndex + 1).trim();

    if (key && val) {
      headers[key.toLowerCase()] = val;
    }
  }

  return headers;
}

/**
 * Build a 401 challenge whose body is a JSON-RPC error envelope. Matches the
 * shape used by `oidcStrategy` / `jwtStrategy` so every `/mcp` failure path
 * returns parseable JSON-RPC.
 */
function unauthorizedChallenge(realm: string): AuthVerifyResult['challenge'] {
  return {
    status: 401,
    headers: {
      'www-authenticate': `Bearer realm="${realm}"`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'unauthorized' },
      id: null,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// apiKeyStrategy
// ─────────────────────────────────────────────────────────────────────────

export interface ApiKeyStrategyOptions {
  /** Required API key value to compare against. */
  apiKey: string;
  /** Header name carrying the key. Defaults to `x-api-key`. */
  headerName?: string;
  /** Realm value used in the WWW-Authenticate challenge. */
  realm?: string;
}

/**
 * Static API-key strategy. Compares the configured key with the request
 * header in constant time.
 *
 * Boot-time advisory: if `opts.apiKey` is empty/unset, every request will
 * reject as a generic 401 with no operator-visible hint that the strategy
 * itself is misconfigured. `compose.ts` already throws when `API_KEY` is
 * missing in env, but emit a warning here too for callers that construct
 * the strategy directly (tests, programmatic embeds).
 */
export function apiKeyStrategy(opts: ApiKeyStrategyOptions): AuthStrategy {
  const expected = opts.apiKey;
  const headerName = (opts.headerName ?? 'x-api-key').toLowerCase();
  const realm = opts.realm ?? 'mcp';

  if (!expected || typeof expected !== 'string') {
    logger.warning('apikey_strategy', {
      message:
        'apikey strategy selected but no key configured (auth.apikey.key is empty); every request will be rejected',
    });
  }

  return {
    kind: 'apikey',
    async verify(req): Promise<AuthVerifyResult> {
      const presented = req.headers.get(headerName) ?? '';
      if (!presented || !expected) {
        return {
          ok: false,
          resolvedHeaders: {},
          challenge: unauthorizedChallenge(realm),
        };
      }

      const ok = constantTimeEqual(presented, expected);
      if (!ok) {
        return {
          ok: false,
          resolvedHeaders: {},
          challenge: unauthorizedChallenge(realm),
        };
      }

      return {
        ok: true,
        resolvedHeaders: { [headerName]: expected },
      };
    },
    protectedResourceMetadata() {
      return null;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// bearerStrategy (static Bearer token)
// ─────────────────────────────────────────────────────────────────────────

export interface BearerStrategyOptions {
  /** Required static bearer token value. */
  token: string;
  /** Realm for WWW-Authenticate challenge. */
  realm?: string;
}

/**
 * Static-bearer-token strategy. The configured token is compared against the
 * `Authorization: Bearer …` header in constant time.
 */
export function bearerStrategy(opts: BearerStrategyOptions): AuthStrategy {
  const expected = opts.token;
  const realm = opts.realm ?? 'mcp';

  return {
    kind: 'bearer',
    async verify(req): Promise<AuthVerifyResult> {
      const auth = req.headers.get('authorization') ?? '';
      const match = auth.match(/^\s*Bearer\s+(.+)$/i);
      const presented = match?.[1] ?? '';

      if (!presented || !expected || !constantTimeEqual(presented, expected)) {
        return {
          ok: false,
          resolvedHeaders: {},
          challenge: unauthorizedChallenge(realm),
        };
      }

      return {
        ok: true,
        resolvedHeaders: { authorization: `Bearer ${expected}` },
      };
    },
    protectedResourceMetadata() {
      return null;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// customHeadersStrategy (arbitrary header map, no per-request validation)
// ─────────────────────────────────────────────────────────────────────────

export interface CustomHeadersStrategyOptions {
  /**
   * Header map to attach to every authorized request. Keys are lowercased
   * before exposure to be consistent with `Headers.get()`.
   */
  headers: Record<string, string>;
}

/**
 * Static custom-headers strategy. Inject configured headers into every
 * outbound API call. There is no per-request authentication check — this
 * strategy is intended for trusted-network deployments where the headers
 * themselves are the credential.
 */
export function customHeadersStrategy(
  opts: CustomHeadersStrategyOptions,
): AuthStrategy {
  const lowered: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (k && v) lowered[k.toLowerCase()] = v;
  }

  // Boot-time advisory: this strategy authorizes every request unconditionally
  // and relies on the surrounding network to gatekeep. Surface a warning
  // outside of `development` (tests still fire — that's by design; suppress
  // in test setup if it's noisy) so production deployments never hit this
  // silently.
  const nodeEnv = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process
    ?.env?.NODE_ENV;
  if (nodeEnv !== 'development') {
    logger.warning('auth_strategy', {
      message:
        'custom-headers strategy assumes trusted-network deployment; verify() always returns ok',
      strategy: 'custom',
    });
  }

  return {
    kind: 'custom',
    async verify(): Promise<AuthVerifyResult> {
      return {
        ok: true,
        resolvedHeaders: { ...lowered },
      };
    },
    protectedResourceMetadata() {
      return null;
    },
  };
}
