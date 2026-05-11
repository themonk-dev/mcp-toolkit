// OAuth discovery handlers with strategy pattern for Node + Workers
// From Spotify MCP

import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from './discovery.ts';

/**
 * Subset of config needed by discovery handlers. Mirrors the nested shape of
 * `AppConfig` so callers can thread their already-parsed slices directly:
 * `config.server.port`, `config.auth.oauth.scopes`, `config.auth.cimd.enabled`,
 * `config.auth.discoveryUrl`.
 */
export interface DiscoveryConfigInput {
  /** Port the server listens on (for default base-URL construction). */
  port: number;
  /** OAuth-relevant scope advertised in `/.well-known/oauth-authorization-server`. */
  oauth: { scopes: string };
  /** CIMD knobs — only `enabled` is read here. */
  cimd: { enabled: boolean };
  /** Optional protected-resource discovery URL (auth-level). */
  auth: { discoveryUrl?: string };
}

type DiscoveryStrategy = {
  resolveAuthBaseUrl(requestUrl: URL, config: DiscoveryConfigInput): string;
  resolveAuthorizationServerUrl(requestUrl: URL, config: DiscoveryConfigInput): string;
  resolveResourceBaseUrl(requestUrl: URL, config: DiscoveryConfigInput): string;
};

export function createDiscoveryHandlers(
  config: DiscoveryConfigInput,
  strategy: DiscoveryStrategy,
): {
  authorizationMetadata: (
    requestUrl: URL,
  ) => ReturnType<typeof buildAuthorizationServerMetadata>;
  protectedResourceMetadata: (
    requestUrl: URL,
    sid?: string,
  ) => ReturnType<typeof buildProtectedResourceMetadata>;
} {
  const scopes = config.oauth.scopes
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  return {
    authorizationMetadata: (requestUrl: URL) => {
      const baseUrl = strategy.resolveAuthBaseUrl(requestUrl, config);
      // IMPORTANT: Advertise OUR proxy endpoints, not the provider's directly!
      // Our /authorize and /token endpoints will proxy to the provider.
      return buildAuthorizationServerMetadata(baseUrl, scopes, {
        // Use our endpoints (default behavior when not overriding)
        authorizationEndpoint: `${baseUrl}/authorize`,
        tokenEndpoint: `${baseUrl}/token`,
        revocationEndpoint: `${baseUrl}/revoke`,
        // SEP-991: CIMD support
        cimdEnabled: config.cimd.enabled,
      });
    },
    protectedResourceMetadata: (requestUrl: URL, sid?: string) => {
      const resourceBase = strategy.resolveResourceBaseUrl(requestUrl, config);
      const authorizationServerUrl =
        config.auth.discoveryUrl ||
        strategy.resolveAuthorizationServerUrl(requestUrl, config);
      return buildProtectedResourceMetadata(resourceBase, authorizationServerUrl, sid);
    },
  };
}

export const workerDiscoveryStrategy: DiscoveryStrategy = {
  resolveAuthBaseUrl: (requestUrl) => requestUrl.origin,
  resolveAuthorizationServerUrl: (requestUrl) =>
    `${requestUrl.origin}/.well-known/oauth-authorization-server`,
  resolveResourceBaseUrl: (requestUrl) => `${requestUrl.origin}/mcp`,
};

export const nodeDiscoveryStrategy: DiscoveryStrategy = {
  resolveAuthBaseUrl: (requestUrl, config) => {
    const authPort = config.port + 1;
    return `${requestUrl.protocol}//${requestUrl.hostname}:${authPort}`;
  },
  resolveAuthorizationServerUrl: (requestUrl, config) => {
    const authPort = config.port + 1;
    return `${requestUrl.protocol}//${requestUrl.hostname}:${authPort}/.well-known/oauth-authorization-server`;
  },
  resolveResourceBaseUrl: (requestUrl) =>
    `${requestUrl.protocol}//${requestUrl.host}/mcp`,
};
