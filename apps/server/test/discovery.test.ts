/**
 * Discovery surface regressions for the F1 / F-1 / G1 hardening.
 *
 * `.well-known/oauth-protected-resource` (and its `/mcp`-prefixed mirror)
 * used to be gated behind the doc-only `AUTH_ENABLED` flag. A deployment with
 * `AUTH_STRATEGY=oidc` + `AUTH_ENABLED=false` had a working `/mcp` (the
 * strategy enforced auth) but a 404 on the metadata endpoint, breaking the
 * 401 → metadata loop for clients. G1 drops the gate: discovery metadata is
 * always safe to publish.
 */

import { describe, expect, it } from 'bun:test';
import { bootNode } from './__helpers__/harness.ts';

describe('discovery: oauth-protected-resource is always mounted', () => {
  it('returns 200 with AUTH_STRATEGY=oidc + AUTH_ENABLED=false (Node)', async () => {
    const { app } = await bootNode({
      AUTH_STRATEGY: 'oidc',
      AUTH_ENABLED: 'false',
      OIDC_ISSUER: 'https://test.example',
      PROVIDER_CLIENT_ID: 'client-x',
      PROVIDER_CLIENT_SECRET: 'secret-y',
      OAUTH_REDIRECT_URI: 'http://localhost/oauth/callback',
    });

    const res = await app.fetch(
      new Request('http://localhost/.well-known/oauth-protected-resource'),
    );

    // Pre-G1: 404 (the if-guard skipped the route mount).
    // Post-G1: 200 with the AS metadata (or, if no AUTH_RESOURCE_URI /
    //   AUTH_DISCOVERY_URL is configured, the dynamic computed metadata).
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      authorization_servers?: string[];
      resource?: string;
    };
    // The discovery handler computes both fields from the request URL even
    // when the strategy's own protectedResourceMetadata() returns null,
    // so we expect non-empty strings.
    expect(typeof body.resource).toBe('string');
    expect(Array.isArray(body.authorization_servers)).toBe(true);
    expect((body.authorization_servers ?? []).length).toBeGreaterThan(0);
  });

  it('mirrored /mcp/.well-known/oauth-protected-resource also returns 200', async () => {
    const { app } = await bootNode({
      AUTH_STRATEGY: 'oidc',
      AUTH_ENABLED: 'false',
      OIDC_ISSUER: 'https://test.example',
      PROVIDER_CLIENT_ID: 'client-x',
      PROVIDER_CLIENT_SECRET: 'secret-y',
      OAUTH_REDIRECT_URI: 'http://localhost/oauth/callback',
    });

    const res = await app.fetch(
      new Request('http://localhost/mcp/.well-known/oauth-protected-resource'),
    );
    expect(res.status).toBe(200);
  });

  it('discovery is also published when AUTH_STRATEGY=none (always safe)', async () => {
    const { app } = await bootNode({ AUTH_STRATEGY: 'none' });

    const res = await app.fetch(
      new Request('http://localhost/.well-known/oauth-protected-resource'),
    );
    // The metadata always advertises the AS endpoints; this is harmless when
    // the server doesn't require auth (clients that read it just won't use it).
    expect(res.status).toBe(200);
  });
});
