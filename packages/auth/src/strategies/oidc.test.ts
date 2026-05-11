import { describe, expect, it } from 'bun:test';
import { MemoryTokenStore } from '@mcp-toolkit/storage';
import * as jose from 'jose';
import type { FlowConfigInput } from '../oauth/input-parsers.ts';
import { oidcStrategy } from './oidc.ts';

const SECRET = new TextEncoder().encode('an-irrelevant-test-secret-32-bytes-please!!');

async function forgeIdToken(payload: Record<string, unknown>): Promise<string> {
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .sign(SECRET);
}

function baseConfig(overrides: Partial<FlowConfigInput> = {}): FlowConfigInput {
  return {
    nodeEnv: 'test',
    strategy: 'oidc',
    oauth: {
      clientId: undefined,
      clientSecret: undefined,
      scopes: 'openid email',
      authorizationUrl: undefined,
      tokenUrl: undefined,
      revocationUrl: undefined,
      redirectUri: 'https://srv.test/oauth/callback',
      redirectAllowlist: [],
      redirectAllowAll: false,
      clientAuth: undefined,
      extraAuthParams: undefined,
    },
    oidc: { issuer: undefined },
    provider: {
      clientId: undefined,
      clientSecret: undefined,
      accountsUrl: undefined,
    },
    requireRs: true,
    ...overrides,
  };
}

describe('auth/strategies/oidc', () => {
  it('verify maps a known RS token to provider tokens and emits identity from id_token', async () => {
    const tokenStore = new MemoryTokenStore();
    const idToken = await forgeIdToken({
      sub: 'oidc-user',
      email: 'u@idp.test',
      groups: ['eng'],
    });

    await tokenStore.storeRsMapping('rs-access-1', {
      access_token: 'provider-access-1',
      id_token: idToken,
    });

    const strat = oidcStrategy({ config: baseConfig(), tokenStore });
    const req = new Request('https://srv.test/mcp', {
      headers: { authorization: 'Bearer rs-access-1' },
    });

    const res = await strat.verify(req, { tokenStore });
    expect(res.ok).toBe(true);
    expect(res.provider?.access_token).toBe('provider-access-1');
    expect(res.identity?.sub).toBe('oidc-user');
    expect(res.identity?.groups).toEqual(['eng']);
    expect(res.resolvedHeaders.authorization).toBe('Bearer provider-access-1');

    tokenStore.stopCleanup();
  });

  it('verify returns Bearer challenge when no Authorization header is present', async () => {
    const tokenStore = new MemoryTokenStore();
    const strat = oidcStrategy({ config: baseConfig(), tokenStore });
    const req = new Request('https://srv.test/mcp');

    const res = await strat.verify(req, { tokenStore });
    expect(res.ok).toBe(false);
    expect(res.challenge?.status).toBe(401);
    expect(res.challenge?.headers['www-authenticate']).toContain('Bearer realm=');

    tokenStore.stopCleanup();
  });

  it('verify rejects an unknown RS token with invalid_token', async () => {
    const tokenStore = new MemoryTokenStore();
    const strat = oidcStrategy({ config: baseConfig(), tokenStore });
    const req = new Request('https://srv.test/mcp', {
      headers: { authorization: 'Bearer not-in-store' },
    });

    const res = await strat.verify(req, { tokenStore });
    expect(res.ok).toBe(false);
    expect(res.challenge?.status).toBe(401);
    expect(res.challenge?.headers['www-authenticate']).toContain('invalid_token');

    tokenStore.stopCleanup();
  });

  it('challenge body is a JSON-RPC error envelope with application/json content type', async () => {
    const tokenStore = new MemoryTokenStore();
    const strat = oidcStrategy({ config: baseConfig(), tokenStore });

    // No Authorization header → plain unauthorized challenge.
    const reqMissing = new Request('https://srv.test/mcp');
    const resMissing = await strat.verify(reqMissing, { tokenStore });
    expect(resMissing.ok).toBe(false);
    expect(resMissing.challenge?.headers['content-type']).toBe('application/json');
    const missingBody = JSON.parse(resMissing.challenge?.body ?? '{}');
    expect(missingBody.jsonrpc).toBe('2.0');
    expect(missingBody.error?.code).toBe(-32000);
    expect(missingBody.error?.message).toBe('unauthorized');
    expect(missingBody.id).toBeNull();

    // Bearer present but unknown → invalid_token challenge with error_description.
    const reqInvalid = new Request('https://srv.test/mcp', {
      headers: { authorization: 'Bearer not-in-store' },
    });
    const resInvalid = await strat.verify(reqInvalid, { tokenStore });
    expect(resInvalid.ok).toBe(false);
    expect(resInvalid.challenge?.headers['content-type']).toBe('application/json');
    const invalidBody = JSON.parse(resInvalid.challenge?.body ?? '{}');
    expect(invalidBody.jsonrpc).toBe('2.0');
    expect(invalidBody.error?.message).toBe('invalid_token');
    expect(invalidBody.error?.data?.error_description).toBe('invalid_token');
    expect(invalidBody.id).toBeNull();

    tokenStore.stopCleanup();
  });
});
