import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { createMcpSecurityMiddleware } from './security.ts';

const baseConfig = {
  nodeEnv: 'development',
  protocolVersion: '2025-06-18',
  allowedOrigins: [] as string[],
};

function mountApp(config: typeof baseConfig) {
  const app = new Hono();
  app.use('*', createMcpSecurityMiddleware({ config }));
  app.all('/mcp', (c) => c.json({ ok: true }));
  return app;
}

describe('transport-http/middlewares/security', () => {
  it('passes when origin is localhost in development', async () => {
    const app = mountApp({ ...baseConfig });
    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { Origin: 'http://localhost:3000' },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({ ok: true });
  });

  it('returns a 500 JSON-RPC error when origin is non-localhost in development', async () => {
    const app = mountApp({ ...baseConfig });
    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { Origin: 'https://evil.example.com' },
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? '').toContain('Invalid origin');
  });

  it('returns a 500 JSON-RPC error when MCP-Protocol-Version header is unsupported', async () => {
    const app = mountApp({ ...baseConfig });
    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Mcp-Protocol-Version': '1900-01-01' },
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? '').toContain('Unsupported MCP protocol version');
  });

  it('passes when MCP-Protocol-Version header is missing (backwards compat)', async () => {
    const app = mountApp({ ...baseConfig });
    const res = await app.fetch(
      new Request('http://localhost/mcp', { method: 'POST' }),
    );
    expect(res.status).toBe(200);
  });
});
