/**
 * In-memory JWKS for JWT-strategy tests. Generates an RS256 keypair, exposes
 * the JWK Set in the format `jose.createRemoteJWKSet` expects, and provides a
 * `sign(claims)` helper for crafting signed bearer tokens.
 *
 * Generate once per `beforeAll` and reuse — keypair generation is the slowest
 * part. Use {@link withMockFetch} to serve `jwks` at the URL the strategy
 * resolves.
 */
import * as jose from 'jose';

export interface MockJwks {
  /** Sign a JWT with the issued private key. */
  sign: (
    claims: Record<string, unknown>,
    opts?: { expiresIn?: string },
  ) => Promise<string>;
  /** JWK Set in the shape `createRemoteJWKSet` expects. */
  jwks: { keys: jose.JWK[] };
  /** Issuer baked into all signed tokens (overridable per claim). */
  issuer: string;
  /** Audience baked into all signed tokens (overridable per claim). */
  audience: string;
}

export async function createMockJwks(
  opts: { issuer?: string; audience?: string; alg?: 'RS256' | 'ES256' } = {},
): Promise<MockJwks> {
  const alg = opts.alg ?? 'RS256';
  const { publicKey, privateKey } = await jose.generateKeyPair(alg, {
    extractable: true,
  });
  const kid = `test-${alg.toLowerCase()}`;
  const issuer = opts.issuer ?? 'https://test.example';
  const audience = opts.audience ?? 'test-aud';

  const sign: MockJwks['sign'] = async (claims, signOpts) => {
    const builder = new jose.SignJWT({ ...claims })
      .setProtectedHeader({ alg, kid })
      .setIssuedAt();
    if (typeof claims.iss !== 'string') builder.setIssuer(issuer);
    if (claims.aud === undefined) builder.setAudience(audience);
    builder.setExpirationTime(signOpts?.expiresIn ?? '1h');
    return builder.sign(privateKey);
  };

  const publicJwk = await jose.exportJWK(publicKey);
  return {
    sign,
    jwks: { keys: [{ ...publicJwk, kid, alg, use: 'sig' }] },
    issuer,
    audience,
  };
}
