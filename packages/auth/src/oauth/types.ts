// OAuth flow types and DTOs
// Provider-agnostic version from Spotify MCP

import type { ProviderTokens } from '@mcp-toolkit/core';

export type AuthorizeInput = {
  clientId?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  requestedScope?: string;
  state?: string;
  sid?: string;
};

// Re-export CIMD types for convenience
export type { CimdConfig, ClientMetadata } from './cimd.ts';

export type AuthorizeResult = {
  redirectTo: string;
  txnId: string;
};

/** Full IdP redirect URL (`/oauth/callback?code=...&state=...`); required for oauth4webapi validateAuthResponse branding. */
export type CallbackInput = {
  callbackUrl: URL;
};

export type CallbackResult = {
  redirectTo: string;
  txnId: string;
  providerTokens: ProviderTokens;
};

export type TokenInput =
  | {
      grant: 'authorization_code';
      code: string;
      codeVerifier: string;
    }
  | {
      grant: 'refresh_token';
      refreshToken: string;
    };

export type TokenResult = {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
  scope: string;
};

export type RegisterInput = {
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  client_name?: string;
};

export type RegisterResult = {
  client_id: string;
  client_id_issued_at: number;
  client_secret_expires_at: number;
  token_endpoint_auth_method: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  registration_client_uri: string;
  registration_access_token: string;
  client_name?: string;
};

export type ProviderConfig = {
  clientId?: string;
  clientSecret?: string;
  accountsUrl: string;
  oauthScopes: string;
  /** Extra query params for authorization URL (e.g., "access_type=offline&prompt=consent") */
  extraAuthParams?: string;
  /** Path to authorization endpoint (default: /authorize for most providers) */
  authorizationEndpointPath?: string;
  /** Path to token endpoint - varies by provider (Spotify: /api/token, Google: /token, GitHub: /login/oauth/access_token) */
  tokenEndpointPath?: string;
  /** Full authorization endpoint URL (OIDC discovery or manual OAUTH_AUTHORIZATION_URL) */
  authorizationEndpointFullUrl?: string;
  /** Full token endpoint URL (OIDC discovery or manual OAUTH_TOKEN_URL) */
  tokenEndpointFullUrl?: string;
  /** OIDC issuer identifier (`iss` on id_token); defaults to accountsUrl when omitted */
  issuer?: string;
  /** JWKS URI for optional JWT `id_token` signature verification */
  jwksUri?: string;
  /** When true, send nonce and require/validate upstream OIDC id_token */
  useOidc?: boolean;
  /** Token endpoint authentication: client_secret_post vs client_secret_basic */
  tokenEndpointClientAuth?: 'post' | 'basic';
};

export type OAuthConfig = {
  redirectUri: string;
  redirectAllowlist: string[];
  redirectAllowAll: boolean;
};
