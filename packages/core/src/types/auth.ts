/**
 * Canonical authentication types.
 * Single source of truth for auth strategy definitions.
 *
 * NOTE: this string union mirrors `AuthStrategyKind` in `@mcp-toolkit/auth`.
 * `@mcp-toolkit/core` cannot import from `@mcp-toolkit/auth` (auth depends on core),
 * so the union is duplicated by hand. Keep the two in lockstep — if you add
 * or rename a strategy kind, update both files.
 */

/**
 * Supported authentication strategies.
 *
 * - 'oauth': Full OAuth 2.1 PKCE flow with RS token → provider token mapping
 * - 'oidc': Same RS mapping; upstream IdP uses OpenID Connect (nonce, id_token, optional discovery)
 * - 'jwt': Verify Bearer JWT against a remote JWKS (pure resource-server)
 * - 'apikey': API key in custom header (from API_KEY env)
 * - 'bearer': Static Bearer token (from BEARER_TOKEN env)
 * - 'custom': Arbitrary headers from CUSTOM_HEADERS config (trusted network)
 * - 'none': No authentication required
 */
export type AuthStrategy =
  | 'oidc'
  | 'oauth'
  | 'jwt'
  | 'apikey'
  | 'bearer'
  | 'custom'
  | 'none';

/**
 * Auth headers extracted from incoming requests.
 */
export interface AuthHeaders {
  authorization?: string;
  'x-api-key'?: string;
  'x-auth-token'?: string;
  [key: string]: string | undefined;
}

/**
 * Resolved authentication result.
 * Contains headers ready for API calls and token information.
 */
export interface ResolvedAuth {
  /** Auth strategy used */
  strategy: AuthStrategy;
  /** Headers to pass to API calls */
  headers: Record<string, string>;
  /** Raw access token (if bearer/oauth) */
  accessToken?: string;
}
