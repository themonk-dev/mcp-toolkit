// Shared OAuth input parsing for both Node.js and Cloudflare Workers

import type {
  AuthCimdConfig,
  AuthOauthConfig,
  AuthOidcConfig,
  AuthProviderConfig,
  AuthStrategyName,
} from '../config.ts';
import { resolveProviderConfig } from '../oidc/upstream.ts';
import type {
  AuthorizeInput,
  OAuthConfig,
  ProviderConfig,
  TokenInput,
} from './types.ts';

/**
 * Subset of the unified `AuthConfig` (plus shared `nodeEnv`) consumed by the
 * OAuth flow helpers. Mirrors the nested shape composed in
 * `apps/server/src/config.ts` so callers thread their already-parsed
 * `AppConfig` slices through here directly — no flat env-shaped keys.
 */
export interface FlowConfigInput {
  /** Runtime environment (development/production/test). Used for dev-only behavior in this layer. */
  nodeEnv: string;
  /** Strategy (oauth/oidc/jwt/apikey/bearer/custom/none). Some flow helpers branch on this. */
  strategy: AuthStrategyName;
  oauth: AuthOauthConfig;
  oidc: AuthOidcConfig;
  provider: AuthProviderConfig;
  /** Optional; only `oidcStrategy` callers thread it. */
  cimd?: AuthCimdConfig;
  /** Optional resource indicator URI per RFC 8707. */
  resourceUri?: string;
  /** Optional protected-resource discovery URL. */
  discoveryUrl?: string;
  /** When `AUTH_REQUIRE_RS=true`, OIDC must produce an RS token before allowing access. */
  requireRs?: boolean;
}

/**
 * Parse authorization request from URL search params.
 */
export function parseAuthorizeInput(url: URL, sessionId?: string): AuthorizeInput {
  return {
    clientId: url.searchParams.get('client_id') ?? undefined,
    codeChallenge: url.searchParams.get('code_challenge') || '',
    codeChallengeMethod: url.searchParams.get('code_challenge_method') || '',
    redirectUri: url.searchParams.get('redirect_uri') || '',
    requestedScope: url.searchParams.get('scope') ?? undefined,
    state: url.searchParams.get('state') ?? undefined,
    sid: url.searchParams.get('sid') || sessionId || undefined,
  };
}

/**
 * Parse callback request from URL search params.
 * IdPs redirect with `code` + `state` on success, or `error` + `error_description` on failure.
 */
export function parseCallbackInput(url: URL): {
  code: string | null;
  state: string | null;
  oauthError: string | null;
  oauthErrorDescription: string | null;
} {
  return {
    code: url.searchParams.get('code'),
    state: url.searchParams.get('state'),
    oauthError: url.searchParams.get('error'),
    oauthErrorDescription: url.searchParams.get('error_description'),
  };
}

/**
 * Parse token request from form data or JSON body.
 */
export async function parseTokenInput(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const text = await request.text();
    return new URLSearchParams(text);
  }

  // Try JSON fallback
  const json = (await request.json().catch(() => ({}))) as Record<string, string>;
  return new URLSearchParams(json);
}

/**
 * Build TokenInput from parsed form data.
 */
export function buildTokenInput(form: URLSearchParams): TokenInput | { error: string } {
  const grant = form.get('grant_type');

  if (grant === 'refresh_token') {
    const refreshToken = form.get('refresh_token');
    if (!refreshToken) {
      return { error: 'missing_refresh_token' };
    }
    return { grant: 'refresh_token', refreshToken };
  }

  if (grant === 'authorization_code') {
    const code = form.get('code');
    const codeVerifier = form.get('code_verifier');
    if (!code || !codeVerifier) {
      return { error: 'missing_code_or_verifier' };
    }
    return { grant: 'authorization_code', code, codeVerifier };
  }

  return { error: 'unsupported_grant_type' };
}

/**
 * Build ProviderConfig from FlowConfigInput.
 */
export function buildProviderConfig(config: FlowConfigInput): ProviderConfig {
  const authUrl = config.oauth.authorizationUrl?.trim();
  const tokenUrl = config.oauth.tokenUrl?.trim();
  return {
    clientId: config.provider.clientId,
    clientSecret: config.provider.clientSecret,
    accountsUrl: config.provider.accountsUrl || 'https://provider.example.com',
    oauthScopes: config.oauth.scopes,
    extraAuthParams: config.oauth.extraAuthParams,
    authorizationEndpointFullUrl: authUrl || undefined,
    tokenEndpointFullUrl: tokenUrl || undefined,
  };
}

/**
 * Resolve provider config including optional OIDC discovery (async).
 *
 * `FlowConfigInput` is structurally compatible with `UpstreamOidcConfig`
 * (the upstream-OIDC module reads only the `strategy` / `oauth.*` / `oidc.*`
 * sub-fields it needs), so the value is passed straight through — no
 * flat-shape adapter is needed.
 */
export async function resolveProviderConfigForFlow(
  config: FlowConfigInput,
): Promise<ProviderConfig> {
  return resolveProviderConfig(config, buildProviderConfig(config));
}

/**
 * Build OAuthConfig from FlowConfigInput.
 */
export function buildOAuthConfig(config: FlowConfigInput): OAuthConfig {
  return {
    redirectUri: config.oauth.redirectUri,
    redirectAllowlist: config.oauth.redirectAllowlist,
    redirectAllowAll: config.oauth.redirectAllowAll,
  };
}

/**
 * Build flow options from request URL.
 */
export function buildFlowOptions(
  url: URL,
  config: FlowConfigInput,
  overrides: { callbackPath?: string; tokenEndpointPath?: string } = {},
): {
  baseUrl: string;
  isDev: boolean;
  callbackPath: string;
  tokenEndpointPath: string;
} {
  return {
    baseUrl: url.origin,
    isDev: config.nodeEnv === 'development',
    callbackPath: overrides.callbackPath ?? '/oauth/callback',
    tokenEndpointPath: overrides.tokenEndpointPath ?? '/api/token',
  };
}
