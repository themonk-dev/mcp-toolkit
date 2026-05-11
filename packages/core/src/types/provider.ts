/**
 * Provider token types and conversion utilities.
 *
 * ProviderTokens (snake_case) - storage / OAuth API format. Defined here as the
 *   canonical token shape used across the workspace; storage drivers and auth
 *   strategies import from `@mcp-toolkit/core/types`.
 * ProviderInfo (camelCase) - tool handler format.
 */

/**
 * Canonical provider token record.
 *
 * snake_case mirrors the storage / OAuth wire format. Use {@link toProviderInfo}
 * to bridge to camelCase for tool handler ergonomics.
 */
export type ProviderTokens = {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scopes?: string[];
  /** Raw OIDC id_token (JWT), when returned by the IdP */
  id_token?: string;
  /** `sub` claim from validated id_token */
  id_token_sub?: string;
};

/**
 * Provider info in camelCase for tool handlers.
 * Converted from ProviderTokens when passing to tools.
 */
export interface ProviderInfo {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  idToken?: string;
  idTokenSub?: string;
}

/**
 * Convert snake_case ProviderTokens to camelCase ProviderInfo.
 * Use when bridging storage layer to tool context.
 */
export function toProviderInfo(tokens: ProviderTokens): ProviderInfo {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_at,
    scopes: tokens.scopes,
    idToken: tokens.id_token,
    idTokenSub: tokens.id_token_sub,
  };
}

/**
 * Convert camelCase ProviderInfo to snake_case ProviderTokens.
 * Use when storing tool-provided data.
 */
export function toProviderTokens(info: ProviderInfo): ProviderTokens {
  return {
    access_token: info.accessToken,
    refresh_token: info.refreshToken,
    expires_at: info.expiresAt,
    scopes: info.scopes,
    id_token: info.idToken,
    id_token_sub: info.idTokenSub,
  };
}
