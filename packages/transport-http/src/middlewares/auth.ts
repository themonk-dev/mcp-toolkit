/**
 * Auth middleware for the Hono MCP transport.
 *
 * Replaces the legacy in-line "parse Authorization header → look up RS token
 * → resolve provider token" body with a thin wrapper around the injected
 * {@link AuthStrategy}. The strategy is the gatekeeper: when its `verify`
 * returns `ok: false`, this middleware returns the strategy's challenge as
 * the HTTP response (or, in legacy/non-strict mode, lets the request through
 * for the route to handle).
 *
 * On success, the resolved auth fields are attached to the Hono context
 * under `c.get('auth')` so downstream handlers can build their per-request
 * `RequestContext` without re-decoding identity.
 */

import type {
  AuthStrategy,
  AuthStrategyKind,
  AuthVerifyResult,
} from '@mcp-toolkit/auth';
import {
  type ProviderTokens,
  type SessionIdentity,
  sharedLogger as logger,
} from '@mcp-toolkit/core';
import type { TokenStore } from '@mcp-toolkit/storage';
import type { Context, MiddlewareHandler } from 'hono';

/**
 * Resolved auth payload attached to the Hono context as `c.get('auth')`.
 *
 * Mirrors the shape produced by {@link AuthStrategy.verify} but adds the
 * strategy `kind` for downstream consumers (audit, session bookkeeping).
 */
export interface ResolvedAuthContext {
  /** Auth strategy `kind` (e.g. 'oidc', 'jwt', 'apikey', 'none'). */
  kind: AuthStrategyKind;
  /** Identity snapshot from the strategy, when produced. */
  identity?: SessionIdentity;
  /** Provider token snapshot (snake_case) from the strategy, when produced. */
  provider?: ProviderTokens;
  /** Headers to forward to upstream APIs. */
  resolvedHeaders: Record<string, string>;
  /** Convenience: provider access token if available. */
  providerToken?: string;
  /** Original request authorization header (Bearer prefix stripped). */
  rsToken?: string;
}

export interface AuthMiddlewareOptions {
  strategy: AuthStrategy;
  /**
   * Token store used by strategies that map RS→provider tokens (oidc).
   * Required when `strategy.kind === 'oidc'`; ignored otherwise.
   */
  tokenStore?: TokenStore;
  /**
   * When true, send the strategy's challenge response (typically 401 +
   * `WWW-Authenticate`) for every unauthenticated request.
   *
   * When false, allow unauthenticated requests through; downstream handlers
   * (security middleware, route handlers) decide whether to surface a
   * challenge. Useful for the legacy "challenge from /mcp only" behaviour.
   *
   * Default: true.
   */
  requireAuth?: boolean;
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: ResolvedAuthContext;
  }
}

/**
 * Build a Hono auth middleware that delegates to the supplied strategy.
 *
 * The middleware:
 *  1. Calls `strategy.verify(c.req.raw, { tokenStore })`.
 *  2. On `ok: false` and `requireAuth=true`, returns the challenge response.
 *  3. On `ok: true` (or when `requireAuth=false`), attaches resolved auth
 *     fields to the Hono context so route handlers can read them via
 *     `c.get('auth')`.
 */
export function createAuthHeaderMiddleware(
  opts: AuthMiddlewareOptions,
): MiddlewareHandler {
  const { strategy, tokenStore, requireAuth = true } = opts;

  return async (c: Context, next) => {
    const result: AuthVerifyResult = await strategy.verify(c.req.raw, {
      tokenStore,
    });

    if (!result.ok) {
      logger.warning('auth_verify', {
        message: 'Auth verify failed',
        kind: strategy.kind,
        requireAuth,
        challengeStatus: result.challenge?.status ?? 401,
      });
      if (requireAuth) {
        const status = result.challenge?.status ?? 401;
        const headers = result.challenge?.headers ?? {};
        const body = result.challenge?.body;
        return new Response(typeof body === 'string' ? body : (body ?? ''), {
          status,
          headers,
        });
      }
      // Legacy: let unauth requests through; downstream may still 401.
    } else {
      logger.debug('auth_verify', {
        message: 'Auth verify ok',
        kind: strategy.kind,
        hasIdentity: Boolean(result.identity),
      });
    }

    // Extract Bearer RS token from the original Authorization header for
    // downstream consumers that care (session API-key resolution, audit).
    const rawAuth = c.req.raw.headers.get('authorization') ?? '';
    const bearerMatch = rawAuth.match(/^\s*Bearer\s+(.+)$/i);
    const rsToken = bearerMatch?.[1];

    const auth: ResolvedAuthContext = {
      kind: strategy.kind,
      identity: result.identity,
      provider: result.provider,
      resolvedHeaders: result.resolvedHeaders ?? {},
      providerToken: result.provider?.access_token,
      rsToken,
    };

    c.set('auth', auth);

    await next();
  };
}
