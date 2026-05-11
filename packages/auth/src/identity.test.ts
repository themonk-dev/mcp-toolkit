import { describe, expect, it } from 'bun:test';
import * as jose from 'jose';
import {
  extractIdentityFromIdToken,
  extractIdentityFromProvider,
  identityEquals,
  identityFromClaims,
} from './identity.ts';

const SECRET = new TextEncoder().encode(
  'a-test-secret-that-is-at-least-32-bytes-long!!',
);

async function forgeIdToken(payload: Record<string, unknown>): Promise<string> {
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .sign(SECRET);
}

describe('auth/identity', () => {
  it('extractIdentityFromIdToken decodes a forged token to a SessionIdentity', async () => {
    const token = await forgeIdToken({
      sub: 'user-1',
      email: 'a@b.test',
      groups: ['admins', 'devs'],
      iss: 'https://idp.example/',
      aud: 'mcp-resource',
    });

    const id = extractIdentityFromIdToken(token);
    expect(id).not.toBeNull();
    expect(id?.sub).toBe('user-1');
    expect(id?.email).toBe('a@b.test');
    expect(id?.groups).toEqual(['admins', 'devs']);
    expect(id?.iss).toBe('https://idp.example/');
    expect(id?.aud).toBe('mcp-resource');
  });

  it('extractIdentityFromIdToken returns null for malformed JWT', () => {
    // No dots → fewer than 2 parts → decoder returns null.
    expect(extractIdentityFromIdToken('not-a-jwt')).toBeNull();
    // Two parts but second segment is not base64url JSON → decoder returns null.
    expect(extractIdentityFromIdToken('aaa.bbb')).toBeNull();
  });

  it('extractIdentityFromIdToken returns null when payload has no identifying claims', async () => {
    const token = await forgeIdToken({});
    expect(extractIdentityFromIdToken(token)).toBeNull();
  });

  it('extractIdentityFromProvider picks id_token from ProviderTokens and idToken from ProviderInfo', async () => {
    const token = await forgeIdToken({ sub: 'pt-user' });

    // ProviderTokens shape: snake_case id_token
    const fromTokens = extractIdentityFromProvider({
      access_token: 'a',
      id_token: token,
    });
    expect(fromTokens?.sub).toBe('pt-user');

    // ProviderInfo shape: camelCase idToken
    const token2 = await forgeIdToken({ sub: 'pi-user' });
    const fromInfo = extractIdentityFromProvider({
      idToken: token2,
    } as unknown as Parameters<typeof extractIdentityFromProvider>[0]);
    expect(fromInfo?.sub).toBe('pi-user');

    // null/undefined provider → null
    expect(extractIdentityFromProvider(null)).toBeNull();
    expect(extractIdentityFromProvider(undefined)).toBeNull();
  });

  it('identityEquals returns true for the same shape and false when groups differ', () => {
    const a = { sub: 'u1', email: 'a@b.test', groups: ['x', 'y'] };
    const b = { sub: 'u1', email: 'a@b.test', groups: ['y', 'x'] };
    const c = { sub: 'u1', email: 'a@b.test', groups: ['x', 'z'] };

    expect(identityEquals(a, b)).toBe(true);
    expect(identityEquals(a, c)).toBe(false);
    expect(identityEquals(undefined, undefined)).toBe(true);
    expect(identityEquals(a, undefined)).toBe(false);
  });

  it('identityFromClaims handles array, CSV string, and single-string group claims', () => {
    const fromArray = identityFromClaims({ sub: 'u', groups: ['a', 'b'] });
    expect(fromArray?.groups).toEqual(['a', 'b']);

    const fromCsv = identityFromClaims({ sub: 'u', groups: 'a,b' });
    expect(fromCsv?.groups).toEqual(['a', 'b']);

    const fromSemi = identityFromClaims({ sub: 'u', groups: 'a;b' });
    expect(fromSemi?.groups).toEqual(['a', 'b']);

    const fromSingle = identityFromClaims({ sub: 'u', groups: 'admins' });
    expect(fromSingle?.groups).toEqual(['admins']);

    // Empty / whitespace / missing → groups omitted
    const empty = identityFromClaims({ sub: 'u', groups: '' });
    expect(empty?.groups).toBeUndefined();
  });
});
