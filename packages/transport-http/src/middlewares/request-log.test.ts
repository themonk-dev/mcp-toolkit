import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { requestLogger } from './request-log.ts';

function mountApp(): Hono {
  const app = new Hono();
  app.use('*', requestLogger());
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.post('/mcp', (c) => c.json({ ok: true }));
  app.get('/boom', () => {
    throw new Error('boom');
  });
  return app;
}

describe('transport-http/middlewares/request-log', () => {
  it('passes the request through to the handler unchanged', async () => {
    const app = mountApp();
    const res = await app.fetch(
      new Request('http://srv.test/health', { method: 'GET' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('preserves the response from the downstream handler', async () => {
    const app = mountApp();
    const res = await app.fetch(
      new Request('http://srv.test/mcp', {
        method: 'POST',
        headers: { 'mcp-session-id': 'sess-1' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('does not swallow exceptions thrown by downstream handlers', async () => {
    const app = mountApp();
    // Hono converts unhandled throws into 500s by default — confirm that
    // pathway is intact (the logger middleware must not eat the error).
    const res = await app.fetch(new Request('http://srv.test/boom'));
    expect(res.status).toBe(500);
  });
});
