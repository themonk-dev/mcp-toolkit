/**
 * End-to-end coverage for `AUTH_STRATEGY=oidc` over both transports.
 *
 * The verify path is the only OIDC seam testable without simulating the full
 * code-grant round-trip (Exhaustive tier). This file exercises it by:
 *
 *   1. Building a `MemoryTokenStore` and pre-populating it with an RS-token →
 *      provider-tokens mapping (the same shape `handleToken` would write).
 *   2. Passing the store into `compose({ config, tokenStore })` so the strategy
 *      and the transport share a single store instance.
 *   3. Booting `buildHttpApp` (Node) and `buildWorkersHandler` (Workers)
 *      against the composed runtime.
 *   4. Hitting `/mcp` with `Authorization: Bearer <rs-access-token>` and
 *      asserting the runtime resolves provider tokens + identity.
 *
 * Notes on transport asymmetry:
 *   - Node mounts the auth middleware with `requireAuth: false` (see
 *     `transport-http/src/builder.ts`), so a wrong/unknown RS token does not
 *     surface as 401 on Node. The Workers MCP handler explicitly returns the
 *     strategy's challenge when `auth.verify` fails. Negative-path 401 tests
 *     are therefore Workers-only.
 *   - Identity is attached to the dispatch context by the Workers handler
 *     directly. The Node Hono path requires an ALS-bound `getContext` to
 *     thread identity into tool handlers — the harness does not wire one in,
 *     so the `whoami` identity-reflection assertion is Workers-only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MemoryTokenStore } from '@mcp-toolkit/storage';
import { buildHttpApp } from '@mcp-toolkit/transport-http/node';
import { buildWorkersHandler } from '@mcp-toolkit/transport-http/workers';
import { type ComposedRuntime, compose } from '../src/compose.ts';
import { envFor } from './__helpers__/env.ts';
import { configFromEnv } from './__helpers__/harness.ts';
import { callMcp, INIT_BODY, initializeSession, jsonReq } from './__helpers__/mcp.ts';
import { createMockJwks, type MockJwks } from './__helpers__/mock-jwks.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Local boot helpers — mirror `__helpers__/harness.ts` but accept an explicit
// `tokenStore` so the test can pre-populate RS↔provider mappings before the
// runtime starts. We don't extend the shared harness because no other test
// needs this seam (the harness's `bootNode`/`bootWorkers` always allocate a
// fresh store via `compose()`). The config builder itself is reused from the
// harness via `configFromEnv`.
// ─────────────────────────────────────────────────────────────────────────────

interface BootedAppWithStore {
  app: { fetch: (req: Request) => Promise<Response> };
  runtime: ComposedRuntime;
  tokenStore: MemoryTokenStore;
}

async function bootNodeWithStore(
  overrides: Record<string, string | undefined>,
  tokenStore: MemoryTokenStore,
): Promise<BootedAppWithStore> {
  const config = envFor(overrides);
  const runtime = await compose({ config, tokenStore });
  const hono = buildHttpApp({
    buildServer: runtime.buildServer,
    liveServers: runtime.liveServers,
    auth: runtime.auth,
    policy: runtime.policy ?? undefined,
    tokenStore: runtime.tokenStore,
    sessionStore: runtime.sessionStore,
    registries: runtime.registries,
    config: configFromEnv(config),
  });
  const app = { fetch: async (req: Request) => hono.fetch(req) };
  return { app, runtime, tokenStore };
}

async function bootWorkersWithStore(
  overrides: Record<string, string | undefined>,
  tokenStore: MemoryTokenStore,
): Promise<BootedAppWithStore> {
  const config = envFor(overrides);
  const runtime = await compose({ config, tokenStore });
  const handler = buildWorkersHandler({
    auth: runtime.auth,
    tokenStore: runtime.tokenStore,
    sessionStore: runtime.sessionStore,
    registries: runtime.registries,
    policy: runtime.policy ?? undefined,
    config: configFromEnv(config),
  });
  return { app: handler, runtime, tokenStore };
}

// Common env knobs for an OIDC boot. We deliberately do not set OIDC_ISSUER
// or PROVIDER_CLIENT_ID — the verify path doesn't need either, and leaving
// them unset avoids any accidental discovery fetch during compose.
const OIDC_ENV = {
  AUTH_STRATEGY: 'oidc',
  AUTH_ENABLED: 'true',
  AUTH_REQUIRE_RS: 'true',
  OAUTH_SCOPES: 'openid email profile',
  OAUTH_REDIRECT_URI: 'http://localhost/oauth/callback',
};

describe('oidc-e2e: shared setup', () => {
  // Single keypair across the suite — keypair generation is the slowest piece.
  let jwks: MockJwks;
  let idToken: string;

  beforeAll(async () => {
    jwks = await createMockJwks({
      issuer: 'https://idp.test',
      audience: 'mcp-aud',
    });
    idToken = await jwks.sign({
      sub: 'oidc-user-123',
      email: 'oidc@idp.test',
      preferred_username: 'oidc-user',
      groups: ['eng', 'admin'],
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Node transport
  // ───────────────────────────────────────────────────────────────────────────
  describe('node transport', () => {
    let booted: BootedAppWithStore;

    beforeAll(async () => {
      const tokenStore = new MemoryTokenStore();
      await tokenStore.storeRsMapping('rs-access-node', {
        access_token: 'provider-access-node',
        refresh_token: 'provider-refresh-node',
        expires_at: Date.now() + 3_600_000,
        scopes: ['openid', 'email', 'profile'],
        id_token: idToken,
        id_token_sub: 'oidc-user-123',
      });
      booted = await bootNodeWithStore(OIDC_ENV, tokenStore);
    });

    afterAll(() => {
      booted.tokenStore.stopCleanup();
      booted.runtime.shutdown();
    });

    it('initialize succeeds and tools/list returns the example tools', async () => {
      const init = await initializeSession(booted.app, {
        authorization: 'Bearer rs-access-node',
      });
      expect(init.status).toBe(200);
      expect(init.sessionId).toBeTruthy();

      const list = await callMcp(
        booted.app,
        init.sessionId,
        'tools/list',
        {},
        { authorization: 'Bearer rs-access-node' },
      );
      expect(list.status).toBe(200);
      const names = (
        (list.body.result as { tools?: Array<{ name: string }> } | undefined)?.tools ??
        []
      ).map((t) => t.name);
      expect(names).toContain('echo');
      expect(names).toContain('health');
      expect(names).toContain('whoami');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Workers transport
  // ───────────────────────────────────────────────────────────────────────────
  describe('workers transport', () => {
    let booted: BootedAppWithStore;

    beforeAll(async () => {
      const tokenStore = new MemoryTokenStore();
      await tokenStore.storeRsMapping('rs-access-workers', {
        access_token: 'provider-access-workers',
        refresh_token: 'provider-refresh-workers',
        expires_at: Date.now() + 3_600_000,
        scopes: ['openid', 'email', 'profile'],
        id_token: idToken,
        id_token_sub: 'oidc-user-123',
      });
      // Pre-populate an *expired* mapping for the expiry test; expiry is on the
      // provider-token side, not the RS-record TTL — the strategy logs a
      // warning but still resolves the mapping (no refresh is performed in
      // `verify`; refresh only fires from the `/token` grant or
      // `ensureFreshToken`). See report below.
      await tokenStore.storeRsMapping('rs-access-expired', {
        access_token: 'provider-access-expired',
        refresh_token: 'provider-refresh-expired',
        expires_at: Date.now() - 60_000,
        scopes: ['openid'],
        id_token: idToken,
        id_token_sub: 'oidc-user-123',
      });
      booted = await bootWorkersWithStore(OIDC_ENV, tokenStore);
    });

    afterAll(() => {
      booted.tokenStore.stopCleanup();
      booted.runtime.shutdown();
    });

    it('initialize succeeds and tools/list returns the example tools', async () => {
      const init = await initializeSession(booted.app, {
        authorization: 'Bearer rs-access-workers',
      });
      expect(init.status).toBe(200);
      expect(init.sessionId).toBeTruthy();

      const list = await callMcp(
        booted.app,
        init.sessionId,
        'tools/list',
        {},
        { authorization: 'Bearer rs-access-workers' },
      );
      expect(list.status).toBe(200);
      const names = (
        (list.body.result as { tools?: Array<{ name: string }> } | undefined)?.tools ??
        []
      ).map((t) => t.name);
      expect(names).toContain('echo');
      expect(names).toContain('health');
      expect(names).toContain('whoami');
    });

    it('rejects an unknown RS token with 401 + invalid_token challenge', async () => {
      const res = await booted.app.fetch(
        jsonReq('http://localhost/mcp', INIT_BODY, {
          authorization: 'Bearer rs-access-not-in-store',
        }),
      );
      expect(res.status).toBe(401);
      const challenge = res.headers.get('www-authenticate') ?? '';
      expect(challenge.toLowerCase()).toContain('bearer');
    });

    it('rejects a malformed Authorization (no Bearer prefix) with 401', async () => {
      // The Workers security pre-flight only checks header *presence*, so a
      // present-but-malformed header reaches `auth.verify`. The OIDC strategy's
      // regex (`/^\s*Bearer\s+(.+)$/i`) doesn't match, and it returns the
      // generic Bearer challenge.
      const res = await booted.app.fetch(
        jsonReq('http://localhost/mcp', INIT_BODY, {
          authorization: 'Basic dXNlcjpwYXNz',
        }),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')?.toLowerCase()).toContain('bearer');
    });

    it('expired provider tokens still resolve in verify (refresh is NOT triggered here)', async () => {
      // Documenting the actual behaviour: `oidcStrategy.verify` only logs a
      // warning when `expires_at` is in the past — it does not call
      // `refreshProviderToken` or `ensureFreshToken`. Refresh is the
      // responsibility of `/token` (refresh_token grant) and of
      // `ensureFreshToken()` invoked from tool execution paths. So the lookup
      // succeeds and the request proceeds to MCP normally. If verify is later
      // changed to enforce expiry, this assertion will need updating.
      const init = await initializeSession(booted.app, {
        authorization: 'Bearer rs-access-expired',
      });
      expect(init.status).toBe(200);
      expect(init.sessionId).toBeTruthy();
    });

    it('whoami reflects the identity decoded from the provider id_token', async () => {
      const init = await initializeSession(booted.app, {
        authorization: 'Bearer rs-access-workers',
      });
      expect(init.status).toBe(200);

      const res = await callMcp(
        booted.app,
        init.sessionId,
        'tools/call',
        { name: 'whoami', arguments: {} },
        { authorization: 'Bearer rs-access-workers' },
      );
      expect(res.status).toBe(200);
      const result = res.body.result as
        | { structuredContent?: Record<string, unknown>; isError?: boolean }
        | undefined;
      expect(result?.isError).toBeFalsy();

      const sc = result?.structuredContent;
      expect(sc).toBeDefined();
      expect(sc?.authenticated).toBe(true);
      expect(sc?.sub).toBe('oidc-user-123');
      expect(sc?.email).toBe('oidc@idp.test');
      expect(Array.isArray(sc?.groups)).toBe(true);
      expect(sc?.groups as string[]).toContain('eng');
      expect(sc?.groups as string[]).toContain('admin');
    });
  });
});
