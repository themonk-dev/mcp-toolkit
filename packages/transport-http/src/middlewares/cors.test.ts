import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { corsMiddleware } from './cors.ts';

function mountApp() {
  const app = new Hono();
  // Dev-mode auto-allows loopback origins, matching the production-runtime
  // ergonomics expected by these tests.
  app.use('*', corsMiddleware({ isDev: true }));
  app.all('/mcp', (c) => c.json({ ok: true }));
  return app;
}

describe('transport-http/middlewares/cors', () => {
  it('responds to OPTIONS preflight with the appropriate access-control headers', async () => {
    const app = mountApp();
    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3000',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type, Mcp-Session-Id',
        },
      }),
    );
    // Hono cors() returns 204 by default for preflight.
    expect([200, 204]).toContain(res.status);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:3000',
    );
    const allowMethods = res.headers.get('access-control-allow-methods') ?? '';
    expect(allowMethods).toContain('POST');
    expect(allowMethods).toContain('OPTIONS');
    const allowHeaders = res.headers.get('access-control-allow-headers') ?? '';
    expect(allowHeaders).toContain('Mcp-Session-Id');
  });

  it('passes through main (non-preflight) requests with allow-origin set', async () => {
    const app = mountApp();
    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { Origin: 'http://localhost:3000' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:3000',
    );
    expect((await res.json()) as Record<string, unknown>).toEqual({ ok: true });
  });
});
