import { describe, expect, it } from 'bun:test';
import type {
  AuthStrategy,
  AuthStrategyKind,
  AuthVerifyResult,
} from '@mcp-toolkit/auth';
import { Hono } from 'hono';
import { createAuthHeaderMiddleware } from './auth.ts';

/**
 * Build a stub AuthStrategy with a controllable verify result. Records every
 * (req, deps) pair so tests can assert call counts and forwarded args.
 */
function stubStrategy(opts: {
  kind?: AuthStrategyKind;
  result: AuthVerifyResult;
}): AuthStrategy & { calls: Array<{ req: Request; deps: unknown }> } {
  const calls: Array<{ req: Request; deps: unknown }> = [];
  return {
    kind: opts.kind ?? 'apikey',
    async verify(req, deps) {
      calls.push({ req, deps });
      return opts.result;
    },
    calls,
  };
}

/** Mount the middleware on a tiny Hono app and return a fetch helper. */
function mountApp(strategy: AuthStrategy, requireAuth = true) {
  const app = new Hono();
  app.use('*', createAuthHeaderMiddleware({ strategy, requireAuth }));
  app.all('/echo', (c) => c.json(c.get('auth') ?? null));
  return app;
}

describe('transport-http/middlewares/auth', () => {
  it('calls strategy.verify exactly once with the incoming Request', async () => {
    const strat = stubStrategy({ result: { ok: true, resolvedHeaders: {} } });
    const app = mountApp(strat);

    const req = new Request('https://srv.test/echo', { method: 'POST' });
    await app.fetch(req);

    expect(strat.calls).toHaveLength(1);
    expect(strat.calls[0]?.req).toBe(req);
  });

  it('on ok=true sets c.var.auth with kind/identity/provider/headers/tokens and calls next', async () => {
    const strat = stubStrategy({
      kind: 'oidc',
      result: {
        ok: true,
        identity: { sub: 'user-1', email: 'a@b.test' },
        provider: { access_token: 'prov-tok' },
        resolvedHeaders: { Authorization: 'Bearer prov-tok' },
      },
    });
    const app = mountApp(strat);

    const res = await app.fetch(
      new Request('https://srv.test/echo', {
        headers: { authorization: 'Bearer rs-token-xyz' },
      }),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe('oidc');
    expect(body.identity).toEqual({ sub: 'user-1', email: 'a@b.test' });
    expect(body.provider).toEqual({ access_token: 'prov-tok' });
    expect(body.resolvedHeaders).toEqual({ Authorization: 'Bearer prov-tok' });
    expect(body.providerToken).toBe('prov-tok');
    expect(body.rsToken).toBe('rs-token-xyz');
  });

  it('on ok=false with requireAuth=true returns the strategy challenge response', async () => {
    const strat = stubStrategy({
      result: {
        ok: false,
        resolvedHeaders: {},
        challenge: {
          status: 401,
          headers: { 'www-authenticate': 'Bearer realm="MCP"' },
          body: 'no creds',
        },
      },
    });
    const app = mountApp(strat, true);

    const res = await app.fetch(new Request('https://srv.test/echo'));
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="MCP"');
    expect(await res.text()).toBe('no creds');
  });

  it('on ok=false with requireAuth=false calls next and the request proceeds', async () => {
    const strat = stubStrategy({
      result: {
        ok: false,
        resolvedHeaders: {},
        challenge: {
          status: 401,
          headers: { 'www-authenticate': 'Bearer realm="MCP"' },
        },
      },
    });
    const app = mountApp(strat, false);

    const res = await app.fetch(new Request('https://srv.test/echo'));
    // Route handler ran, no challenge: 200 with the (empty / missing) auth body
    expect(res.status).toBe(200);
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
  });

  it('the kind set on context matches the strategy kind', async () => {
    const strat = stubStrategy({
      kind: 'jwt',
      result: { ok: true, resolvedHeaders: {} },
    });
    const app = mountApp(strat);

    const res = await app.fetch(new Request('https://srv.test/echo'));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe('jwt');
  });
});
