/**
 * MCP security middleware (origin / protocol-version validation).
 *
 * Originally `src/adapters/http-hono/middleware.security.ts`. In the legacy
 * monolith this middleware also did RS-token mapping, proactive provider-
 * token refresh, and an "Authorization header presence" challenge. Token
 * mapping/refresh moved into the {@link AuthStrategy}; the
 * "no Authorization header" challenge is now produced by the auth middleware
 * (mounted on `/mcp` with `requireAuth: true`) as part of `strategy.verify`'s
 * normal failure path — so this middleware is now a thin origin / protocol
 * preflight.
 *
 * No `node:*` imports. `crypto.randomUUID()` is Web Crypto API.
 */

import { sharedLogger as logger } from '@mcp-toolkit/core';
import { validateOrigin, validateProtocolVersion } from '@mcp-toolkit/mcp';
import type { MiddlewareHandler } from 'hono';

/**
 * Slice of unified config consumed by this middleware. Mirrors the nested
 * `AppConfig` shape composed in `apps/server/src/config.ts` — the builder
 * projects from `config.server.{nodeEnv,allowedOrigins}` + `config.mcp.protocolVersion`.
 */
export interface SecurityMiddlewareConfig {
  /** Runtime environment (development relaxes the origin check to allow loopbacks). */
  nodeEnv: string;
  /** MCP protocol version advertised + validated against the `MCP-Protocol-Version` header. */
  protocolVersion: string;
  /**
   * Browser origin allowlist. In development loopback origins are always
   * allowed; in production this is the only way a browser origin can pass
   * {@link validateOrigin}.
   */
  allowedOrigins?: readonly string[];
}

export interface SecurityMiddlewareOptions {
  config: SecurityMiddlewareConfig;
}

/**
 * Build the MCP security middleware. Runs validateOrigin + validateProtocolVersion
 * and surfaces any thrown error as a 500 JSON-RPC response. Auth gating
 * happens in the upstream auth middleware (which is `requireAuth: true` on
 * `/mcp` per the F3 hardening) — this middleware no longer issues its own
 * unauthenticated challenge.
 */
export function createMcpSecurityMiddleware(
  opts: SecurityMiddlewareOptions,
): MiddlewareHandler {
  const { config } = opts;

  return async (c, next) => {
    try {
      validateOrigin(
        c.req.raw.headers,
        config.nodeEnv === 'development',
        config.allowedOrigins ?? [],
      );
      validateProtocolVersion(c.req.raw.headers, config.protocolVersion);
      return next();
    } catch (error) {
      logger.error('mcp_security', {
        message: 'Security check failed',
        error: (error as Error).message,
      });

      return c.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: (error as Error).message || 'Internal server error',
          },
          id: null,
        },
        500,
      );
    }
  };
}
