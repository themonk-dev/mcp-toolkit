/**
 * Tests for the nested `authConfigSchema` defined in `./config.ts`.
 *
 * Covers:
 *   - Empty-input defaults (strategy='none', sub-objects populated).
 *   - Round-trip of a representative apikey input.
 *   - `boolFromString` strict-truthy semantics.
 *   - The CIMD `enabled=true when unset` special case.
 *   - `stringList` parsing for `OAUTH_REDIRECT_ALLOWLIST`.
 */

import { describe, expect, it } from 'bun:test';

import { authConfigSchema } from './config.ts';

describe('authConfigSchema', () => {
  it('parses an empty object into a sensible default shape', () => {
    const parsed = authConfigSchema.parse({});

    expect(parsed.strategy).toBe('none');
    expect(parsed.requireRs).toBe(false);
    expect(parsed.resourceUri).toBeUndefined();
    expect(parsed.discoveryUrl).toBeUndefined();

    expect(parsed.apikey).toEqual({
      key: undefined,
      headerName: 'x-api-key',
    });
    expect(parsed.bearer).toEqual({ token: undefined });
    expect(parsed.custom).toEqual({ headers: undefined });
    expect(parsed.oauth).toEqual({
      clientId: undefined,
      clientSecret: undefined,
      scopes: '',
      authorizationUrl: undefined,
      tokenUrl: undefined,
      revocationUrl: undefined,
      redirectUri: 'http://localhost:3000/callback',
      redirectAllowlist: [],
      redirectAllowAll: false,
      clientAuth: undefined,
      extraAuthParams: undefined,
    });
    expect(parsed.oidc).toEqual({ issuer: undefined });
    expect(parsed.cimd).toEqual({
      enabled: true,
      fetchTimeoutMs: 5000,
      maxResponseBytes: 65536,
      allowedDomains: [],
    });
    expect(parsed.provider).toEqual({
      clientId: undefined,
      clientSecret: undefined,
      accountsUrl: undefined,
    });
    expect(parsed.jwt).toEqual({
      jwksUrl: undefined,
      issuer: undefined,
      audience: undefined,
    });
  });

  it('round-trips a representative apikey input', () => {
    const parsed = authConfigSchema.parse({
      strategy: 'apikey',
      apikey: { key: 'secret-123', headerName: 'x-tenant-key' },
    });

    expect(parsed.strategy).toBe('apikey');
    expect(parsed.apikey.key).toBe('secret-123');
    expect(parsed.apikey.headerName).toBe('x-tenant-key');
    // Untouched sub-objects retain their own defaults.
    expect(parsed.oauth.redirectUri).toBe('http://localhost:3000/callback');
    expect(parsed.cimd.enabled).toBe(true);
  });

  it('boolFromString accepts string/bool/empty/undefined with strict-truthy semantics', () => {
    expect(authConfigSchema.parse({ requireRs: 'true' }).requireRs).toBe(true);
    expect(authConfigSchema.parse({ requireRs: 'false' }).requireRs).toBe(false);
    expect(authConfigSchema.parse({ requireRs: '' }).requireRs).toBe(false);
    expect(authConfigSchema.parse({ requireRs: undefined }).requireRs).toBe(false);
    expect(authConfigSchema.parse({}).requireRs).toBe(false);
  });

  it('cimd.enabled defaults to true when the env is unset (special case)', () => {
    expect(authConfigSchema.parse({}).cimd.enabled).toBe(true);
    expect(authConfigSchema.parse({ cimd: {} }).cimd.enabled).toBe(true);
    expect(authConfigSchema.parse({ cimd: { enabled: undefined } }).cimd.enabled).toBe(
      true,
    );
    // Explicit "false" turns it off — the default only applies when unset.
    expect(authConfigSchema.parse({ cimd: { enabled: 'false' } }).cimd.enabled).toBe(
      false,
    );
  });

  it('stringList trims, drops empties, and returns a string array', () => {
    const parsed = authConfigSchema.parse({
      oauth: { redirectAllowlist: 'a, b ,  ,c' },
    });
    expect(parsed.oauth.redirectAllowlist).toEqual(['a', 'b', 'c']);
  });
});
