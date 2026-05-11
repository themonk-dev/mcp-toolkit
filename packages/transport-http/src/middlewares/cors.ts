// CORS middleware for Hono - uses built-in cors() helper.
// Originally `src/http/middlewares/cors.ts`; moved to `@mcp-toolkit/transport-http`
// during D5. Workers-safe (Hono `cors` is runtime-agnostic).

import { isLoopbackOrigin } from '@mcp-toolkit/mcp';
import { cors } from 'hono/cors';

export interface CorsMiddlewareOptions {
  /**
   * Comma-separated allowlist of origins permitted to call the MCP endpoint
   * from a browser. In development, loopback origins (`localhost`,
   * `127.0.0.1`, `[::1]`) are auto-allowed in addition to this list.
   */
  allowedOrigins?: readonly string[];
  /** True in development; relaxes the allowlist to also accept loopbacks. */
  isDev?: boolean;
}

/**
 * CORS middleware configured for MCP endpoints.
 *
 * Uses Hono's built-in cors() middleware. The `origin` callback consults the
 * explicit allowlist instead of reflecting whatever `Origin` was sent —
 * an unknown origin gets an empty `Access-Control-Allow-Origin` value,
 * which browsers reject.
 *
 * Note: Preflight returns 204 (Hono default) vs original 200.
 * Both are valid per CORS spec - browsers accept either.
 */
export const corsMiddleware = (opts: CorsMiddlewareOptions = {}) => {
  const allowedOrigins = opts.allowedOrigins ?? [];
  const isDev = opts.isDev ?? false;

  return cors({
    origin: (origin) => {
      if (!origin) {
        // Non-browser callers (e.g. server-to-server) — Hono will skip the
        // header altogether when this returns null. Use the empty string
        // for parity with the legacy reflect-or-localhost fallback.
        return '';
      }
      if (allowedOrigins.includes(origin)) return origin;
      if (isDev && isLoopbackOrigin(origin)) return origin;
      // Not in allowlist → empty string makes the browser block the request.
      return '';
    },
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'Mcp-Session-Id',
      'MCP-Protocol-Version',
      'Mcp-Protocol-Version',
      'X-Api-Key',
      'X-Auth-Token',
    ],
    exposeHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'],
  });
};
