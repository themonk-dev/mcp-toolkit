import { afterEach, describe, expect, test } from 'bun:test';
import type { ProviderConfig } from '../oauth/types.ts';
import {
  discoverAuthorizationServer,
  ensureOpenidScope,
  parseOauthClientAuth,
  pickTokenEndpointClientAuth,
  resetOidcDiscoveryCacheForTests,
  resolveProviderConfig,
  type UpstreamOidcConfig,
} from './upstream.ts';

describe('parseOauthClientAuth', () => {
  test('parses aliases', () => {
    expect(parseOauthClientAuth('post')).toBe('post');
    expect(parseOauthClientAuth('client_secret_post')).toBe('post');
    expect(parseOauthClientAuth('basic')).toBe('basic');
    expect(parseOauthClientAuth(undefined)).toBeUndefined();
  });
});

describe('ensureOpenidScope', () => {
  test('prepends openid when missing', () => {
    expect(ensureOpenidScope('email profile')).toBe('openid email profile');
  });

  test('idempotent when openid present', () => {
    expect(ensureOpenidScope('openid email')).toBe('openid email');
  });
});

describe('pickTokenEndpointClientAuth', () => {
  test('respects explicit post', () => {
    expect(
      pickTokenEndpointClientAuth(
        { issuer: 'https://x', token_endpoint_auth_methods_supported: [] },
        'post',
      ),
    ).toBe('post');
  });

  test('prefers basic when advertised', () => {
    expect(
      pickTokenEndpointClientAuth(
        {
          issuer: 'https://x',
          token_endpoint_auth_methods_supported: [
            'client_secret_post',
            'client_secret_basic',
          ],
        },
        undefined,
      ),
    ).toBe('basic');
  });

  test('falls back to post when only post advertised', () => {
    expect(
      pickTokenEndpointClientAuth(
        {
          issuer: 'https://x',
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        },
        undefined,
      ),
    ).toBe('post');
  });
});

describe('discoverAuthorizationServer (mocked fetch)', () => {
  const orig = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = orig;
    resetOidcDiscoveryCacheForTests();
  });

  test('fetches and caches OIDC discovery', async () => {
    const body = {
      issuer: 'https://id.example/',
      authorization_endpoint: 'https://id.example/authorize',
      token_endpoint: 'https://id.example/token',
      jwks_uri: 'https://id.example/jwks',
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    };

    let fetchCalls = 0;
    // Bun/TS: satisfy global fetch type (includes preconnect in lib.dom)
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    const as1 = await discoverAuthorizationServer('https://id.example');
    expect(as1.token_endpoint).toBe('https://id.example/token');

    await discoverAuthorizationServer('https://id.example');
    expect(fetchCalls).toBe(1);
  });
});

describe('resolveProviderConfig', () => {
  const orig = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = orig;
    resetOidcDiscoveryCacheForTests();
  });

  test('merges discovery for OIDC_ISSUER', async () => {
    const discovery = {
      issuer: 'https://id.example/',
      authorization_endpoint: 'https://id.example/authorize',
      token_endpoint: 'https://id.example/token',
      jwks_uri: 'https://id.example/jwks',
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
    };

    globalThis.fetch = (async () =>
      new Response(JSON.stringify(discovery), {
        status: 200,
      })) as unknown as typeof fetch;

    const base: ProviderConfig = {
      accountsUrl: 'https://legacy.example',
      oauthScopes: 'email',
      clientId: 'c',
      clientSecret: 's',
    };

    const cfg: UpstreamOidcConfig = {
      strategy: 'oidc',
      oauth: {},
      oidc: { issuer: 'https://id.example' },
    };

    const merged = await resolveProviderConfig(cfg, base);
    expect(merged.useOidc).toBe(true);
    expect(merged.oauthScopes).toContain('openid');
    expect(merged.tokenEndpointFullUrl).toBe('https://id.example/token');
    expect(merged.jwksUri).toBe('https://id.example/jwks');
  });
});
