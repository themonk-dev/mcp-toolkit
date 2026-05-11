/**
 * Inbound-request logging middleware.
 *
 * Logs one structured line per request at the top of the Hono chain so the
 * operator can see *every* connection the server accepts — including
 * `.well-known/*` OAuth discovery probes that a client may issue before any
 * MCP traffic. This is the primary diagnostic for "the client says
 * 'fetch failed' but my server logs are silent" symptoms.
 *
 * `/health` is intentionally skipped to keep load-balancer noise out of the
 * stream — health checks are constant and uninteresting.
 *
 * The {@link sharedLogger} sanitizes any field whose name looks sensitive
 * (`token`, `key`, `authorization`, etc.), so the log lines below only carry
 * non-secret signal: scheme name, presence flags, status, duration.
 */

import { sharedLogger as logger } from '@mcp-toolkit/core';
import type { MiddlewareHandler } from 'hono';

export function requestLogger(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    const url = new URL(c.req.url);
    const pathname = url.pathname;

    if (pathname === '/health') {
      await next();
      return;
    }

    const origin = c.req.header('origin') ?? c.req.header('referer') ?? null;
    const sessionId = c.req.header('mcp-session-id') ?? null;
    const authHeader = c.req.header('authorization');
    // Only the scheme (first token) — never the credential bytes.
    const scheme = authHeader ? authHeader.split(/\s+/)[0] : null;

    const start = Date.now();
    logger.info('http_request', {
      message: 'Inbound request',
      method,
      path: pathname,
      origin,
      sessionId,
      scheme,
    });

    try {
      await next();
    } finally {
      const status = c.res.status;
      const durationMs = Date.now() - start;
      const level = status >= 500 ? 'error' : status >= 400 ? 'warning' : 'info';
      logger[level]('http_request', {
        message: 'Response sent',
        method,
        path: pathname,
        status,
        durationMs,
      });
    }
  };
}
