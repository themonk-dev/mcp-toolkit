import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import * as jose from 'jose';
import { jwtStrategy, resetJwtJwksCacheForTests } from './jwt.ts';

const JWKS_URL = 'https://idp.test/.well-known/jwks.json';
const ISSUER = 'https://idp.test/';
const AUDIENCE = 'mcp-resource';

let privateKey: jose.CryptoKey;
let publicJwk: jose.JWK;
const KID = 'test-kid';

async function makeToken(
  overrides: {
    sub?: string;
    iss?: string;
    aud?: string;
    exp?: number;
    groups?: unknown;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    sub: overrides.sub ?? 'jwt-user-1',
    groups: overrides.groups ?? ['admins'],
  };
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt(now - 5)
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? AUDIENCE)
    .setExpirationTime(overrides.exp ?? now + 300)
    .sign(privateKey);
}

// Inline withMockFetch helper (per constraint #3 — no apps/server import).
function withMockedJwks(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith(JWKS_URL)) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { 'content-type': 'application/jwk-set+json' },
      });
    }
    throw new Error(`unexpected fetch in jwt.test: ${url}`);
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

describe('auth/strategies/jwt', () => {
  beforeAll(async () => {
    const { privateKey: pk, publicKey: pub } = await jose.generateKeyPair('RS256', {
      extractable: true,
    });
    privateKey = pk;
    publicJwk = { ...(await jose.exportJWK(pub)), kid: KID, alg: 'RS256' };
  });

  afterEach(() => {
    resetJwtJwksCacheForTests();
  });

  it('accepts a valid token and surfaces identity from claims', async () => {
    const restore = withMockedJwks();
    try {
      const token = await makeToken();
      const strat = jwtStrategy({
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const req = new Request('https://srv.test/mcp', {
        headers: { authorization: `Bearer ${token}` },
      });
      const res = await strat.verify(req, {});
      expect(res.ok).toBe(true);
      expect(res.identity?.sub).toBe('jwt-user-1');
      expect(res.identity?.groups).toEqual(['admins']);
      expect(res.resolvedHeaders.authorization).toBe(`Bearer ${token}`);
    } finally {
      restore();
    }
  });

  it('rejects an expired token', async () => {
    const restore = withMockedJwks();
    try {
      const now = Math.floor(Date.now() / 1000);
      // exp 10 minutes ago, well outside default 60s clock tolerance.
      const token = await makeToken({ exp: now - 600 });
      const strat = jwtStrategy({
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const req = new Request('https://srv.test/mcp', {
        headers: { authorization: `Bearer ${token}` },
      });
      const res = await strat.verify(req, {});
      expect(res.ok).toBe(false);
      expect(res.challenge?.status).toBe(401);
      expect(res.challenge?.headers['www-authenticate']).toContain('invalid_token');
    } finally {
      restore();
    }
  });

  it('rejects a token with the wrong issuer', async () => {
    const restore = withMockedJwks();
    try {
      const token = await makeToken({ iss: 'https://attacker.test/' });
      const strat = jwtStrategy({
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const req = new Request('https://srv.test/mcp', {
        headers: { authorization: `Bearer ${token}` },
      });
      const res = await strat.verify(req, {});
      expect(res.ok).toBe(false);
      expect(res.challenge?.status).toBe(401);
    } finally {
      restore();
    }
  });

  it('rejects a token with the wrong audience', async () => {
    const restore = withMockedJwks();
    try {
      const token = await makeToken({ aud: 'someone-else' });
      const strat = jwtStrategy({
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const req = new Request('https://srv.test/mcp', {
        headers: { authorization: `Bearer ${token}` },
      });
      const res = await strat.verify(req, {});
      expect(res.ok).toBe(false);
      expect(res.challenge?.status).toBe(401);
    } finally {
      restore();
    }
  });

  it('returns Bearer realm challenge when Authorization header is missing', async () => {
    const strat = jwtStrategy({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const req = new Request('https://srv.test/mcp');
    const res = await strat.verify(req, {});
    expect(res.ok).toBe(false);
    expect(res.challenge?.status).toBe(401);
    expect(res.challenge?.headers['www-authenticate']).toContain('Bearer realm=');
  });
});
