/**
 * F3 regression: Origin allowlist for `/mcp`.
 *
 * After F3 the CORS middleware no longer reflects whatever `Origin` was sent.
 * Browser requests from origins that are not in `ALLOWED_ORIGINS` (and that
 * are not loopback in development) get rejected — either by the validateOrigin
 * pre-flight inside the security middleware (production), or by an empty
 * `Access-Control-Allow-Origin` header that the browser refuses to honour.
 */

import { describe, expect, it } from 'bun:test';
import { bootNode, bootWorkers } from './__helpers__/harness.ts';
import { INIT_BODY, jsonReq } from './__helpers__/mcp.ts';

describe('cors: production origin allowlist', () => {
  it('rejects an origin not in the allowlist (Node, NODE_ENV=production)', async () => {
    const { app } = await bootNode({
      NODE_ENV: 'production',
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
      ALLOWED_ORIGINS: 'https://app.example.com',
    });

    const res = await app.fetch(
      jsonReq('http://localhost/mcp', INIT_BODY, {
        Origin: 'https://evil.example.com',
      }),
    );

    // validateOrigin throws -> security middleware surfaces a 500 JSON-RPC
    // error (per the Hono security middleware shape). Either way the request
    // is rejected — the key invariant is that the response does NOT echo the
    // attacker-controlled origin back as Access-Control-Allow-Origin.
    expect(res.status).not.toBe(200);
    const acao = res.headers.get('access-control-allow-origin') ?? '';
    expect(acao).not.toBe('https://evil.example.com');
  });

  it('rejects an origin not in the allowlist (Workers, NODE_ENV=production)', async () => {
    const { app } = await bootWorkers({
      NODE_ENV: 'production',
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
      ALLOWED_ORIGINS: 'https://app.example.com',
    });

    const res = await app.fetch(
      jsonReq('http://localhost/mcp', INIT_BODY, {
        Origin: 'https://evil.example.com',
      }),
    );

    expect(res.status).not.toBe(200);
    const acao = res.headers.get('access-control-allow-origin') ?? '';
    expect(acao).not.toBe('https://evil.example.com');
  });

  it('accepts an allowlisted origin (Node, NODE_ENV=production)', async () => {
    const { app } = await bootNode({
      NODE_ENV: 'production',
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
      ALLOWED_ORIGINS: 'https://app.example.com',
    });

    const res = await app.fetch(
      jsonReq('http://localhost/mcp', INIT_BODY, {
        Origin: 'https://app.example.com',
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://app.example.com',
    );
  });

  it('rejects LAN/.local origins in development (no longer auto-allowed)', async () => {
    // Pre-F3 the dev-mode predicate also accepted 192.168.*, 10.*, and *.local.
    // F3 tightens to literal loopback only.
    const { app } = await bootNode({
      NODE_ENV: 'development',
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
    });

    const res = await app.fetch(
      jsonReq('http://localhost/mcp', INIT_BODY, {
        Origin: 'http://192.168.1.42',
      }),
    );

    expect(res.status).not.toBe(200);
  });
});
