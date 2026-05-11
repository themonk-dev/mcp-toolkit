/**
 * Strategy parity over the Node Hono transport (`buildHttpApp`).
 *
 * After F3 the auth middleware runs with `requireAuth: true` on `/mcp` (see
 * `packages/transport-http/src/builder.ts`), so `auth.verify` is the gate:
 * missing or invalid credentials surface the strategy's own 401 challenge
 * directly, regardless of the legacy `AUTH_ENABLED` flag. The `none`
 * strategy explicitly skips the challenge — "no credentials" is its design.
 *
 * Tests cover the matrix: `none` (no challenge), `apikey` (strategy 401 on
 * missing/wrong `x-api-key`), and `bearer` (strategy 401 on missing/wrong
 * token — the legacy "silently accepts wrong Bearer" gap is closed). `jwt`
 * and `oidc` are skipped on Node — `oidc` needs OAuth code-grant simulation
 * (out of scope) and `jwt` is exercised in `strategies-workers.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import { bootNode } from './__helpers__/harness.ts';
import {
  callMcp,
  INIT_BODY,
  initializeSession,
  jsonReq,
  readJson,
} from './__helpers__/mcp.ts';

describe('strategies-node: AUTH_STRATEGY=none', () => {
  it('initialize succeeds without any auth header', async () => {
    const { app } = await bootNode({
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
    });
    const init = await initializeSession(app);
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
  });

  it('tools/list returns the bundled examples', async () => {
    const { app } = await bootNode({
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
    });
    const init = await initializeSession(app);
    const list = await callMcp(app, init.sessionId, 'tools/list', {});
    expect(list.status).toBe(200);
    const names = (
      (list.body.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []
    ).map((t) => t.name);
    expect(names).toContain('echo');
    expect(names).toContain('health');
    expect(names).toContain('whoami');
  });

  it('tools/call name=echo returns echoed text', async () => {
    const { app } = await bootNode({
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
    });
    const init = await initializeSession(app);
    const call = await callMcp(app, init.sessionId, 'tools/call', {
      name: 'echo',
      arguments: { message: 'hello-node' },
    });
    expect(call.status).toBe(200);
    const result = call.body.result as
      | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
      | undefined;
    expect(result?.isError).toBeFalsy();
    expect(result?.content?.[0]?.text).toBe('hello-node');
  });
});

describe('strategies-node: AUTH_STRATEGY=apikey', () => {
  it('returns 401 without any credential header (strategy verify gate)', async () => {
    // After F3 the auth middleware runs with `requireAuth: true` on `/mcp`,
    // so a missing x-api-key surfaces the apikey strategy's 401 challenge
    // directly instead of falling through to the security middleware's
    // session-bound challenge.
    const { app } = await bootNode({
      AUTH_STRATEGY: 'apikey',
      AUTH_ENABLED: 'true',
      API_KEY: 'secret',
      MCP_USER_AUDIT_ON_LIST: 'false',
    });
    const res = await app.fetch(jsonReq('http://localhost/mcp', INIT_BODY));
    expect(res.status).toBe(401);
  });

  it('initialize succeeds with x-api-key (strategy verify passes)', async () => {
    // After F3 the apikey strategy's verify() is the only gate. A correct
    // `x-api-key` header (no Authorization) now satisfies it regardless of
    // `AUTH_ENABLED` — the legacy security-middleware "needs Authorization
    // header" requirement is gone.
    const { app } = await bootNode({
      AUTH_STRATEGY: 'apikey',
      AUTH_ENABLED: 'true',
      API_KEY: 'secret',
      MCP_USER_AUDIT_ON_LIST: 'false',
    });
    const init = await initializeSession(app, { 'x-api-key': 'secret' });
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
  });

  it('AUTH_ENABLED=false still gates via strategy verify (F3)', async () => {
    // F3 closes the bypass: `AUTH_ENABLED=false` is no longer honoured at
    // runtime. With AUTH_STRATEGY=apikey, a missing/incorrect x-api-key is
    // rejected regardless of the legacy flag.
    const { app } = await bootNode({
      AUTH_STRATEGY: 'apikey',
      AUTH_ENABLED: 'false',
      API_KEY: 'secret',
      MCP_USER_AUDIT_ON_LIST: 'false',
    });
    const denied = await app.fetch(jsonReq('http://localhost/mcp', INIT_BODY));
    expect(denied.status).toBe(401);

    const init = await initializeSession(app, { 'x-api-key': 'secret' });
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
  });
});

describe('strategies-node: AUTH_STRATEGY=bearer', () => {
  it('returns 401 without Authorization', async () => {
    const { app } = await bootNode({
      AUTH_STRATEGY: 'bearer',
      AUTH_ENABLED: 'true',
      BEARER_TOKEN: 'tok-123',
      MCP_USER_AUDIT_ON_LIST: 'false',
    });
    const res = await app.fetch(jsonReq('http://localhost/mcp', INIT_BODY));
    expect(res.status).toBe(401);
  });

  it('accepts Authorization: Bearer <token>', async () => {
    const { app } = await bootNode({
      AUTH_STRATEGY: 'bearer',
      AUTH_ENABLED: 'true',
      BEARER_TOKEN: 'tok-123',
      MCP_USER_AUDIT_ON_LIST: 'false',
    });
    const init = await initializeSession(app, {
      authorization: 'Bearer tok-123',
    });
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();

    const list = await callMcp(
      app,
      init.sessionId,
      'tools/list',
      {},
      { authorization: 'Bearer tok-123' },
    );
    expect(list.status).toBe(200);
    const names = (
      (list.body.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []
    ).map((t) => t.name);
    expect(names).toContain('echo');
  });

  // F3 regression: a wrong Bearer token now produces a 401 challenge from
  // the bearer strategy's `verify()`. Before F3 the Node transport ran the
  // auth middleware in optional-credentials mode, so a bad Bearer slipped
  // through and the handler responded 200.
  it('rejects a wrong Bearer token with 401', async () => {
    const { app } = await bootNode({
      AUTH_STRATEGY: 'bearer',
      AUTH_ENABLED: 'true',
      BEARER_TOKEN: 'tok-123',
      MCP_USER_AUDIT_ON_LIST: 'false',
    });
    const res = await app.fetch(
      jsonReq('http://localhost/mcp', INIT_BODY, {
        authorization: 'Bearer wrong-token',
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('strategies-node: malformed JSON body (G1 N5 + H1 F-7)', () => {
  // Pre-H1 the Node Hono transport silently swallowed JSON parse errors
  // (assigning `body = undefined`), then fell through to a misleading
  // "Mcp-Session-Id required" 400. F-7 mirrors the Workers handler: return
  // a clean JSON-RPC parse error (`-32700`) with HTTP 400.
  it('returns 400 + -32700 parse error for non-JSON body', async () => {
    const { app } = await bootNode({
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
    });

    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: 'not-valid-json',
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: { code?: number; message?: string };
      id?: unknown;
    };
    expect(body.error?.code).toBe(-32700);
    expect(body.error?.message).toMatch(/Parse error/i);
    expect(body.id).toBeNull();
  });
});

describe('strategies-node: discovery surface', () => {
  it('GET /.well-known/oauth-authorization-server returns AS metadata', async () => {
    const { app } = await bootNode({
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
    });
    const res = await app.fetch(
      new Request('http://localhost/.well-known/oauth-authorization-server'),
    );
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      issuer?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
    };
    expect(typeof body.issuer).toBe('string');
    expect(typeof body.authorization_endpoint).toBe('string');
    expect(typeof body.token_endpoint).toBe('string');
  });

  it('GET /health returns 200', async () => {
    const { app } = await bootNode({
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
    });
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      status?: string;
      transport?: string;
    };
    expect(body.status).toBe('ok');
    expect(body.transport).toBe('streamable-http');
  });
});
