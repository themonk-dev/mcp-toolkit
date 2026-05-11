/**
 * Negative-path coverage for `buildOAuthServerApp` (the standalone Hono
 * Authorization Server mounted on `PORT+1` in production).
 *
 * The full code-grant round-trip is out of scope (Exhaustive tier). These
 * tests cover the surface that's reachable without a configured upstream IdP:
 * discovery metadata, malformed-input rejections, and the dynamic-client
 * registration shape from `handleRegister`.
 *
 * Key behaviours documented inline:
 *   - `/.well-known/oauth-authorization-server` is unauthenticated discovery.
 *   - `GET /authorize` validates redirect_uri + PKCE before doing anything else.
 *   - `POST /token` validates grant_type + required fields via
 *     `buildTokenInput` and returns `{ error: ... }` with status 400.
 *   - `POST /register` accepts an empty body and synthesises sensible
 *     defaults (it is not strictly RFC-7591-compliant about required fields).
 *   - `POST /revoke` is a no-op that always returns `{ status: 'ok' }`
 *     (see `packages/auth/src/oauth/endpoints.ts`). Asserting a 400 on a
 *     missing token would be wrong — the test below pins the actual shape.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MemoryTokenStore } from '@mcp-toolkit/storage';
import {
  type BuildOAuthServerConfig,
  buildOAuthServerApp,
} from '@mcp-toolkit/transport-http/oauth-server';
import { envFor } from './__helpers__/env.ts';

describe('oauth-server: discovery + AS endpoints (negative paths)', () => {
  let tokenStore: MemoryTokenStore;
  let app: { fetch: (req: Request) => Promise<Response> };

  beforeAll(() => {
    tokenStore = new MemoryTokenStore();
    // Build the nested config slice via `envFor` so the flat-overrides input
    // shape stays consistent with every other test. Deliberately no
    // OIDC_ISSUER / PROVIDER_CLIENT_ID so the routes don't attempt upstream
    // discovery during the tests we run.
    const parsed = envFor({
      AUTH_STRATEGY: 'oidc',
      OAUTH_SCOPES: 'openid email profile',
      OAUTH_REDIRECT_URI: 'http://localhost/oauth/callback',
      OAUTH_REDIRECT_ALLOW_ALL: 'false',
      CIMD_ENABLED: 'true',
    });
    const config: BuildOAuthServerConfig = {
      server: {
        nodeEnv: parsed.server.nodeEnv,
        allowedOrigins: parsed.server.allowedOrigins,
        port: parsed.server.port,
      },
      auth: {
        strategy: parsed.auth.strategy,
        oauth: parsed.auth.oauth,
        oidc: parsed.auth.oidc,
        cimd: parsed.auth.cimd,
        provider: parsed.auth.provider,
        discoveryUrl: parsed.auth.discoveryUrl,
      },
    };
    const hono = buildOAuthServerApp({ tokenStore, config });
    // Normalise `Response | Promise<Response>` to the strict `Promise<Response>`
    // shape (matches the harness's `bootNode` wrapper).
    app = { fetch: async (req: Request) => hono.fetch(req) };
  });

  afterAll(() => {
    tokenStore.stopCleanup();
  });

  it('GET /.well-known/oauth-authorization-server returns 200 + valid metadata', async () => {
    const res = await app.fetch(
      new Request('http://localhost/.well-known/oauth-authorization-server'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issuer?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
      revocation_endpoint?: string;
      registration_endpoint?: string;
      response_types_supported?: string[];
      grant_types_supported?: string[];
      code_challenge_methods_supported?: string[];
      scopes_supported?: string[];
    };
    expect(typeof body.issuer).toBe('string');
    expect(body.authorization_endpoint).toBe('http://localhost/authorize');
    expect(body.token_endpoint).toBe('http://localhost/token');
    expect(body.revocation_endpoint).toBe('http://localhost/revoke');
    expect(body.registration_endpoint).toBe('http://localhost/register');
    expect(body.response_types_supported).toContain('code');
    expect(body.grant_types_supported).toContain('authorization_code');
    expect(body.code_challenge_methods_supported).toContain('S256');
    // Configured scopes flow through the metadata.
    expect(body.scopes_supported).toContain('openid');
  });

  it('GET /authorize with no params returns 400', async () => {
    const res = await app.fetch(new Request('http://localhost/authorize'));
    expect(res.status).toBe(400);
    const text = await res.text();
    // The handler surfaces the underlying error message; `redirect_uri` is the
    // first thing `handleAuthorize` checks, so the message mentions it.
    expect(text).toContain('redirect_uri');
  });

  it('POST /token with empty body returns 400 + error envelope', async () => {
    const res = await app.fetch(
      new Request('http://localhost/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    // `buildTokenInput` returns `{ error: 'unsupported_grant_type' }` when
    // `grant_type` is absent.
    expect(typeof body.error).toBe('string');
    expect(body.error).toBe('unsupported_grant_type');
  });

  it('POST /token with grant_type=refresh_token but no refresh_token returns 400', async () => {
    const res = await app.fetch(
      new Request('http://localhost/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=refresh_token',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('missing_refresh_token');
  });

  it('POST /register with an empty JSON body returns 201 + a synthesised client_id', async () => {
    // `handleRegister` does not enforce required RFC-7591 fields — it accepts
    // an empty body and falls back to the configured default redirect_uri.
    // Pinning that shape here so future tightening (if any) shows up as a
    // failing test rather than silent drift.
    const res = await app.fetch(
      new Request('http://localhost/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      client_id?: string;
      redirect_uris?: string[];
      grant_types?: string[];
      response_types?: string[];
    };
    expect(typeof body.client_id).toBe('string');
    expect(body.client_id?.length).toBeGreaterThan(0);
    expect(body.redirect_uris).toContain('http://localhost/oauth/callback');
    expect(body.grant_types).toContain('authorization_code');
    expect(body.response_types).toContain('code');
  });

  it('POST /register with an explicit redirect_uris list echoes them back', async () => {
    const res = await app.fetch(
      new Request('http://localhost/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['https://client.test/cb'] }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { redirect_uris?: string[] };
    expect(body.redirect_uris).toEqual(['https://client.test/cb']);
  });

  it('POST /revoke is a no-op that returns 200 + { status: "ok" } regardless of input', async () => {
    // `handleRevoke` (in `packages/auth/src/oauth/endpoints.ts`) ignores its
    // arguments and always returns `{ status: 'ok' }`. RFC 7009 §2.2 allows
    // this — successful revocation is signalled by 200 OK and the server
    // need not differentiate unknown tokens. We pin the actual behaviour;
    // a future spec-tightening change would require updating this test.
    const res = await app.fetch(
      new Request('http://localhost/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe('ok');
  });
});
