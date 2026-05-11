/**
 * `jwt` strategy — verify a Bearer JWT against a JWKS URL.
 *
 * Unlike the `oidc` strategy, this is a pure resource-server strategy: there
 * is no Authorization Server to mount, no token-store mapping, and no
 * id_token nonce. The presented JWT IS the access token.
 *
 * Verification uses `jose.jwtVerify` against a cached `createRemoteJWKSet`.
 * `decodeJwt` is **not** called on the verify path — we only ever trust the
 * verified payload.
 */

import { sharedLogger as logger } from '@mcp-toolkit/core';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { identityFromClaims } from '../identity.ts';
import type { AuthStrategy, AuthVerifyResult } from '../types.ts';

export interface JwtStrategyOptions {
  /** Required JWKS endpoint URL (HTTPS recommended). */
  jwksUrl: string;
  /** Required `iss` claim value (or list of accepted issuers). */
  issuer?: string | string[];
  /** Required `aud` claim value (or list of accepted audiences). */
  audience?: string | string[];
  /** Allowed clock skew in seconds. Defaults to 60. */
  clockToleranceSeconds?: number;
  /** Realm string for the WWW-Authenticate challenge. */
  realm?: string;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, jwks);
  }
  return jwks;
}

/**
 * Build a 401 challenge whose body is a JSON-RPC error envelope. Matches the
 * shape used by `oidcStrategy` / `apiKeyStrategy` so every `/mcp` failure
 * path returns parseable JSON-RPC.
 */
function challenge(realm: string, error?: string): AuthVerifyResult['challenge'] {
  const params = [`realm="${realm}"`];
  if (error) params.push(`error="${error}"`);
  const message = error ?? 'unauthorized';
  return {
    status: 401,
    headers: {
      'www-authenticate': `Bearer ${params.join(', ')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message,
        ...(error ? { data: { error_description: message } } : {}),
      },
      id: null,
    }),
  };
}

/**
 * Test helper: clear the JWKS cache between tests.
 */
export function resetJwtJwksCacheForTests(): void {
  jwksCache.clear();
}

export function jwtStrategy(opts: JwtStrategyOptions): AuthStrategy {
  if (!opts.jwksUrl) {
    throw new Error('jwtStrategy: jwksUrl is required');
  }
  const realm = opts.realm ?? 'mcp';
  const clockTolerance = opts.clockToleranceSeconds ?? 60;

  return {
    kind: 'jwt',
    async verify(req): Promise<AuthVerifyResult> {
      const auth = req.headers.get('authorization') ?? '';
      const match = auth.match(/^\s*Bearer\s+(.+)$/i);
      const token = match?.[1];

      if (!token) {
        return {
          ok: false,
          resolvedHeaders: {},
          challenge: challenge(realm),
        };
      }

      try {
        const JWKS = getJwks(opts.jwksUrl);
        const { payload } = await jwtVerify(token, JWKS, {
          issuer: opts.issuer,
          audience: opts.audience,
          clockTolerance,
        });

        const identity = identityFromClaims(
          payload as unknown as Record<string, unknown>,
        );

        return {
          ok: true,
          identity: identity ?? undefined,
          resolvedHeaders: { authorization: `Bearer ${token}` },
        };
      } catch (error) {
        logger.warning('jwt_strategy', {
          message: 'JWT verification failed',
          error: (error as Error).message,
        });
        return {
          ok: false,
          resolvedHeaders: {},
          challenge: challenge(realm, 'invalid_token'),
        };
      }
    },
    protectedResourceMetadata() {
      return null;
    },
  };
}
