/**
 * Standalone OAuth Authorization Server (Hono) for the Node transport.
 *
 * Originally `src/http/auth-app.ts`. The legacy file pulled the token store
 * from a process-wide singleton and reparsed `process.env`; the new shape
 * accepts both as parameters so the server runs as cleanly under tests as
 * it does in production.
 *
 * The OAuth Authorization Server is normally exposed on `PORT+1` so the
 * MCP `/mcp` endpoint and the AS endpoints don't clash. The MCP transport
 * (built by `buildHttpApp`) advertises this AS via the discovery routes.
 *
 * G1 hardening (N3): `corsMiddleware()` is now configured with the
 * `allowedOrigins` + `isDev` plumbing the rest of the transport uses.
 * Calling it bare meant `allowedOrigins: []` + `isDev: false`, which rejected
 * every browser origin (including localhost). The AS lives in the same trust
 * domain as the main MCP port — reuse the same allowlist.
 *
 * No `node:*` imports — the `apps/server` Node entry binds this Hono app
 * to `@hono/node-server` itself.
 */

import type {
  AuthCimdConfig,
  AuthOauthConfig,
  AuthOidcConfig,
  AuthProviderConfig,
  AuthStrategyName,
} from '@mcp-toolkit/auth/config';
import { buildAuthorizationServerMetadata } from '@mcp-toolkit/auth/oauth/discovery';
import type { FlowConfigInput } from '@mcp-toolkit/auth/oauth/input-parsers';
import type { TokenStore } from '@mcp-toolkit/storage';
import { Hono } from 'hono';
import { corsMiddleware } from './middlewares/cors.ts';
import { buildOAuthRoutes } from './routes/oauth.ts';

/**
 * Nested config slice consumed by the standalone OAuth Authorization Server.
 *
 * Mirrors the composed `AppConfig` shape from `apps/server/src/config.ts`:
 * the caller passes already-parsed slices instead of flat env-shaped keys.
 * `auth` includes everything the `FlowConfigInput` projection needs plus the
 * `cimd` knobs used by `/authorize`.
 */
export interface BuildOAuthServerConfig {
  /** Runtime context for CORS allowlist + dev-loopback relaxation. */
  server: {
    nodeEnv: string;
    allowedOrigins: readonly string[];
    /** Reserved for future use (e.g. explicit AS base-URL construction). */
    port: number;
  };
  /** Auth slice — projected onto `FlowConfigInput` for the routes. */
  auth: {
    strategy: AuthStrategyName;
    oauth: AuthOauthConfig;
    oidc: AuthOidcConfig;
    cimd: AuthCimdConfig;
    provider: AuthProviderConfig;
    discoveryUrl?: string;
  };
}

export interface BuildOAuthServerOptions {
  /** Token store shared with the MCP transport (RS↔provider mappings). */
  tokenStore: TokenStore;
  /** Nested config slice — see {@link BuildOAuthServerConfig}. */
  config: BuildOAuthServerConfig;
  /**
   * Optional explicit base URL override (defaults to `${protocol}//${host}`
   * derived from the request URL).
   */
  baseUrl?: string;
}

/**
 * Project the nested {@link BuildOAuthServerConfig} onto the
 * {@link FlowConfigInput} shape consumed by the OAuth route builder.
 *
 * `nodeEnv` lives on the `server` slice; everything else passes through
 * unchanged from the `auth` slice.
 */
function toFlowConfig(config: BuildOAuthServerConfig): FlowConfigInput {
  return {
    nodeEnv: config.server.nodeEnv,
    strategy: config.auth.strategy,
    oauth: config.auth.oauth,
    oidc: config.auth.oidc,
    provider: config.auth.provider,
    cimd: config.auth.cimd,
    discoveryUrl: config.auth.discoveryUrl,
  };
}

export function buildOAuthServerApp(opts: BuildOAuthServerOptions): Hono {
  const { tokenStore, config, baseUrl } = opts;
  const allowedOrigins = config.server.allowedOrigins;
  const isDev = config.server.nodeEnv === 'development';

  const app = new Hono();

  // Middleware
  app.use('*', corsMiddleware({ allowedOrigins, isDev }));

  // Discovery — advertise OUR proxy endpoints, not the provider's directly!
  app.get('/.well-known/oauth-authorization-server', (c) => {
    const here = new URL(c.req.url);
    const base = baseUrl ?? `${here.protocol}//${here.host}`;
    const scopes = config.auth.oauth.scopes.split(' ').filter(Boolean);

    const metadata = buildAuthorizationServerMetadata(base, scopes, {
      authorizationEndpoint: `${base}/authorize`,
      tokenEndpoint: `${base}/token`,
      revocationEndpoint: `${base}/revoke`,
      cimdEnabled: config.auth.cimd.enabled,
    });

    return c.json(metadata);
  });

  // Mount OAuth routes (/authorize, /token, /oauth/callback, /register, /revoke)
  app.route('/', buildOAuthRoutes(tokenStore, toFlowConfig(config)));

  return app;
}
