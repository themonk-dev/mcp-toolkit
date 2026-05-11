/**
 * Upstream OpenID Connect: discovery, scope helpers, optional JWT id_token verification (jose).
 * MCP-facing OAuth 2.1 AS is unchanged; this module only supports the IdP leg.
 */

import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import * as oauth from 'oauth4webapi';
import { assertSsrfSafe } from '../oauth/ssrf.ts';
import type { ProviderConfig } from '../oauth/types.ts';

/**
 * Subset of nested config needed to resolve a {@link ProviderConfig} for the
 * upstream OIDC/OAuth flow.
 *
 * Structurally compatible with `Pick<FlowConfigInput, 'strategy' | 'oauth' | 'oidc'>`
 * — callers that already hold a `FlowConfigInput` can pass it directly (TS
 * accepts wider auth/oidc sub-objects on the input side; only the narrower
 * fields named here are read).
 */
export interface UpstreamOidcConfig {
  strategy?: string;
  oauth: {
    authorizationUrl?: string;
    tokenUrl?: string;
    clientAuth?: string;
  };
  oidc: {
    issuer?: string;
  };
}

const discoveryCache = new Map<
  string,
  { as: oauth.AuthorizationServer; expires: number }
>();
const DISCOVERY_TTL_MS = 5 * 60 * 1000;

/** Test helper: clear cached discovery documents */
export function resetOidcDiscoveryCacheForTests(): void {
  discoveryCache.clear();
}

/**
 * Fetch and validate OpenID Provider metadata (OIDC discovery).
 */
export async function discoverAuthorizationServer(
  issuerInput: string,
): Promise<oauth.AuthorizationServer> {
  const normalized = issuerInput.replace(/\/$/, '');
  // SSRF guard: operator-supplied `OIDC_ISSUER` is fetched here on every
  // cold cache hit. Reject obvious targets (loopback, private IPs, cloud
  // metadata endpoints) before issuing the discovery request. Root-path
  // URLs like `https://accounts.example` are valid issuers — allow them.
  assertSsrfSafe(normalized, { requireNonRootPath: false });
  const issuerUrl = new URL(normalized);
  const key = issuerUrl.toString();
  const now = Date.now();
  const hit = discoveryCache.get(key);
  if (hit && hit.expires > now) {
    return hit.as;
  }

  const response = await oauth.discoveryRequest(issuerUrl, { algorithm: 'oidc' });
  const as = await oauth.processDiscoveryResponse(issuerUrl, response);
  discoveryCache.set(key, { as, expires: now + DISCOVERY_TTL_MS });
  return as;
}

export function parseOauthClientAuth(value: unknown): 'post' | 'basic' | undefined {
  const v = String(value || '')
    .trim()
    .toLowerCase();
  if (v === 'post' || v === 'client_secret_post') return 'post';
  if (v === 'basic' || v === 'client_secret_basic') return 'basic';
  return undefined;
}

/**
 * Resolve token endpoint client authentication method.
 * Explicit env wins; otherwise prefer basic when advertised, else post.
 */
export function pickTokenEndpointClientAuth(
  as: oauth.AuthorizationServer,
  explicit: 'post' | 'basic' | undefined,
): 'post' | 'basic' {
  if (explicit === 'post') return 'post';
  if (explicit === 'basic') return 'basic';
  const supported = as.token_endpoint_auth_methods_supported;
  if (Array.isArray(supported)) {
    if (supported.includes('client_secret_basic')) return 'basic';
    if (supported.includes('client_secret_post')) return 'post';
  }
  return 'basic';
}

/** Ensure `openid` scope is present for OIDC upstream requests */
export function ensureOpenidScope(scopes: string): string {
  const parts = scopes.split(/\s+/).filter(Boolean);
  if (!parts.includes('openid')) {
    parts.unshift('openid');
  }
  return parts.join(' ');
}

/**
 * Verify `id_token` as a JWT using JWKS (signature + issuer + audience + nonce).
 * No-op when the token does not look like a JWT (e.g. opaque id_token).
 */
export async function verifyIdTokenJwtSignature(
  idToken: string,
  jwksUri: string,
  issuer: string,
  clientId: string,
  expectedNonce: string,
): Promise<void> {
  const segments = idToken.split('.');
  if (segments.length !== 3) {
    return;
  }

  const JWKS: JWTVerifyGetKey = createRemoteJWKSet(new URL(jwksUri));
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer,
    audience: clientId,
    clockTolerance: 60,
  });

  if (payload.nonce !== expectedNonce) {
    throw new Error('id_token_nonce_mismatch');
  }
}

/**
 * Merge discovery, env overrides, and OIDC flags into {@link ProviderConfig}.
 */
export async function resolveProviderConfig(
  config: UpstreamOidcConfig,
  base: ProviderConfig,
): Promise<ProviderConfig> {
  const merged: ProviderConfig = { ...base };
  const useOidc = config.strategy === 'oidc';
  merged.useOidc = useOidc;

  const explicitAuth = parseOauthClientAuth(config.oauth.clientAuth);

  if (useOidc) {
    merged.oauthScopes = ensureOpenidScope(merged.oauthScopes || '');
  }

  const issuerInput = config.oidc.issuer?.trim();
  if (issuerInput) {
    const as = await discoverAuthorizationServer(issuerInput);
    const issuer =
      typeof as.issuer === 'string' && as.issuer.length > 0 ? as.issuer : issuerInput;
    merged.issuer = issuer;
    merged.authorizationEndpointFullUrl = as.authorization_endpoint;
    merged.tokenEndpointFullUrl = as.token_endpoint;
    merged.jwksUri = as.jwks_uri;
    merged.accountsUrl = issuer;
    merged.tokenEndpointClientAuth = pickTokenEndpointClientAuth(as, explicitAuth);
  } else {
    merged.tokenEndpointClientAuth = explicitAuth ?? 'basic';
    if (useOidc) {
      merged.issuer = merged.issuer || base.accountsUrl;
    }
  }

  const authzOverride = config.oauth.authorizationUrl?.trim();
  if (authzOverride) {
    merged.authorizationEndpointFullUrl = authzOverride;
  }
  const tokenOverride = config.oauth.tokenUrl?.trim();
  if (tokenOverride) {
    merged.tokenEndpointFullUrl = tokenOverride;
  }

  if (!merged.tokenEndpointClientAuth) {
    merged.tokenEndpointClientAuth = explicitAuth ?? 'basic';
  }

  return merged;
}
