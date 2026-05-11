/**
 * Strategy parity over the Workers transport (`buildWorkersHandler`).
 *
 * Unlike the Node Hono path, the Workers MCP handler calls `auth.verify`
 * directly after the security pre-flight, so all four shipped resource-server
 * strategies (`none`, `apikey`, `bearer`, `jwt`) get full coverage here.
 *
 * `oidc` is intentionally out of scope — exercising its RS-token mapping
 * requires simulating the OAuth code-grant flow (Exhaustive tier). The
 * existing `packages/auth/src/oidc/upstream.test.ts` covers OIDC discovery.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { resetJwtJwksCacheForTests } from '@mcp-toolkit/auth/jwt';
import { bootWorkers } from './__helpers__/harness.ts';
import { callMcp, INIT_BODY, initializeSession, jsonReq } from './__helpers__/mcp.ts';
import { withMockFetch } from './__helpers__/mock-fetch.ts';
import { createMockJwks, type MockJwks } from './__helpers__/mock-jwks.ts';

describe('strategies-workers: AUTH_STRATEGY=none', () => {
  it('initialize succeeds without any auth header', async () => {
    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
    });
    const init = await initializeSession(app);
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
  });

  it('tools/list returns the bundled examples', async () => {
    const { app } = await bootWorkers({
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
    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
    });
    const init = await initializeSession(app);
    const call = await callMcp(app, init.sessionId, 'tools/call', {
      name: 'echo',
      arguments: { message: 'hello-workers' },
    });
    expect(call.status).toBe(200);
    const result = call.body.result as
      | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
      | undefined;
    expect(result?.isError).toBeFalsy();
    expect(result?.content?.[0]?.text).toBe('hello-workers');
  });
});

describe('strategies-workers: AUTH_STRATEGY=apikey', () => {
  it('returns 401 without x-api-key', async () => {
    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'apikey',
      AUTH_ENABLED: 'true',
      API_KEY: 'secret',
      MCP_USER_AUDIT_ON_LIST: 'false',
    });
    const res = await app.fetch(jsonReq('http://localhost/mcp', INIT_BODY));
    expect(res.status).toBe(401);
  });

  it('returns 401 with the wrong x-api-key', async () => {
    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'apikey',
      AUTH_ENABLED: 'true',
      API_KEY: 'secret',
      MCP_USER_AUDIT_ON_LIST: 'false',
    });
    const res = await app.fetch(
      jsonReq('http://localhost/mcp', INIT_BODY, { 'x-api-key': 'nope' }),
    );
    expect(res.status).toBe(401);
  });

  it('initialize + tools/list succeeds with the configured x-api-key', async () => {
    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'apikey',
      AUTH_ENABLED: 'true',
      API_KEY: 'secret',
      MCP_USER_AUDIT_ON_LIST: 'false',
    });
    const init = await initializeSession(app, { 'x-api-key': 'secret' });
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();

    const list = await callMcp(
      app,
      init.sessionId,
      'tools/list',
      {},
      { 'x-api-key': 'secret' },
    );
    expect(list.status).toBe(200);
    const names = (
      (list.body.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []
    ).map((t) => t.name);
    expect(names).toContain('echo');
  });

  // G1 F-2: pre-G1 the Workers security preflight hardcoded the
  // header-presence probe to `x-api-key`/`x-auth-token` (ignoring
  // `API_KEY_HEADER`), so a deployment with a custom header name was 401'd
  // before the strategy ever ran. G1 removes the redundant pre-strategy
  // probe and lets the wired strategy's `verify()` be the gate.
  it('apikey with custom API_KEY_HEADER passes when the right header is set', async () => {
    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'apikey',
      API_KEY: 'secret',
      API_KEY_HEADER: 'X-Custom-Key',
      MCP_USER_AUDIT_ON_LIST: 'false',
    });

    const okInit = await initializeSession(app, { 'X-Custom-Key': 'secret' });
    expect(okInit.status).toBe(200);
    expect(okInit.sessionId).toBeTruthy();

    const denied = await initializeSession(app);
    expect(denied.status).toBe(401);
  });
});

describe('strategies-workers: AUTH_STRATEGY=bearer', () => {
  it('returns 401 without Authorization', async () => {
    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'bearer',
      AUTH_ENABLED: 'true',
      BEARER_TOKEN: 'tok-abc',
      MCP_USER_AUDIT_ON_LIST: 'false',
    });
    const res = await app.fetch(jsonReq('http://localhost/mcp', INIT_BODY));
    expect(res.status).toBe(401);
  });

  it('initialize succeeds with valid Bearer token; rejects a wrong one', async () => {
    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'bearer',
      AUTH_ENABLED: 'true',
      BEARER_TOKEN: 'tok-abc',
      MCP_USER_AUDIT_ON_LIST: 'false',
    });
    const init = await initializeSession(app, {
      authorization: 'Bearer tok-abc',
    });
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();

    const denied = await app.fetch(
      jsonReq('http://localhost/mcp', INIT_BODY, {
        authorization: 'Bearer wrong',
      }),
    );
    expect(denied.status).toBe(401);
  });
});

describe('strategies-workers: malformed JSON body (G1 N5)', () => {
  // Pre-G1 a malformed body was silently swallowed and replaced with `{}`,
  // then the dispatcher returned a misleading `-32600 Missing method`.
  // G1 returns a clean JSON-RPC parse error (`-32700`) with HTTP 400.
  it('returns 400 + -32700 parse error for non-JSON body', async () => {
    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'none',
      MCP_USER_AUDIT_ON_LIST: 'false',
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
    };
    expect(body.error?.code).toBe(-32700);
    expect(body.error?.message).toMatch(/Parse error/i);
  });
});

describe('strategies-workers: AUTH_STRATEGY=jwt', () => {
  const JWKS_URL = 'http://test/jwks';
  let jwks: MockJwks;

  beforeAll(async () => {
    jwks = await createMockJwks({
      issuer: 'http://test/iss',
      audience: 'mcp-aud',
    });
  });

  afterEach(() => {
    // The strategy caches `createRemoteJWKSet` per URL. Clear so each test's
    // mock fetch is exercised cleanly.
    resetJwtJwksCacheForTests();
  });

  function jwksResponder(req: Request): Response {
    if (req.url === JWKS_URL) {
      return Response.json(jwks.jwks);
    }
    return new Response('not found', { status: 404 });
  }

  it('rejects without Authorization (no Bearer token presented)', async () => {
    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'jwt',
      AUTH_ENABLED: 'true',
      JWT_JWKS_URL: JWKS_URL,
      JWT_ISSUER: jwks.issuer,
      JWT_AUDIENCE: jwks.audience,
      MCP_USER_AUDIT_ON_LIST: 'false',
    });
    await withMockFetch(jwksResponder, async () => {
      const res = await app.fetch(jsonReq('http://localhost/mcp', INIT_BODY));
      expect(res.status).toBe(401);
    });
  });

  it('accepts a valid signed JWT', async () => {
    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'jwt',
      AUTH_ENABLED: 'true',
      JWT_JWKS_URL: JWKS_URL,
      JWT_ISSUER: jwks.issuer,
      JWT_AUDIENCE: jwks.audience,
      MCP_USER_AUDIT_ON_LIST: 'false',
    });
    await withMockFetch(jwksResponder, async () => {
      const token = await jwks.sign({ sub: 'alice', groups: ['eng'] });
      const init = await initializeSession(app, {
        authorization: `Bearer ${token}`,
      });
      expect(init.status).toBe(200);
      expect(init.sessionId).toBeTruthy();
    });
  });

  it('rejects an expired JWT', async () => {
    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'jwt',
      AUTH_ENABLED: 'true',
      JWT_JWKS_URL: JWKS_URL,
      JWT_ISSUER: jwks.issuer,
      JWT_AUDIENCE: jwks.audience,
      MCP_USER_AUDIT_ON_LIST: 'false',
    });
    await withMockFetch(jwksResponder, async () => {
      // expiresIn supports negative offsets (e.g. '-1h' → expired one hour ago).
      const token = await jwks.sign({ sub: 'alice' }, { expiresIn: '-1h' });
      const res = await app.fetch(
        jsonReq('http://localhost/mcp', INIT_BODY, {
          authorization: `Bearer ${token}`,
        }),
      );
      expect(res.status).toBe(401);
    });
  });

  it('rejects a JWT with the wrong audience', async () => {
    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'jwt',
      AUTH_ENABLED: 'true',
      JWT_JWKS_URL: JWKS_URL,
      JWT_ISSUER: jwks.issuer,
      JWT_AUDIENCE: jwks.audience,
      MCP_USER_AUDIT_ON_LIST: 'false',
    });
    await withMockFetch(jwksResponder, async () => {
      const token = await jwks.sign({ sub: 'alice', aud: 'someone-else' });
      const res = await app.fetch(
        jsonReq('http://localhost/mcp', INIT_BODY, {
          authorization: `Bearer ${token}`,
        }),
      );
      expect(res.status).toBe(401);
    });
  });
});
