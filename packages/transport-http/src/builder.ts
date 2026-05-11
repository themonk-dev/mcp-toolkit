/**
 * Hono builder for the MCP HTTP transport (Node).
 *
 * Originally `src/http/app.ts`. The new builder accepts every dependency
 * via an options object — there are no global config imports, no singletons,
 * and no implicit registry pulls. The caller (`apps/server/src/main.ts`) is
 * responsible for composing the pieces and wiring them in.
 *
 * No `node:*` imports. The Node-only ALS adapter is imported by
 * `routes/mcp-node.ts`, which the Node barrel re-exports.
 */

import type { AuthStrategy } from '@mcp-toolkit/auth';
import type {
  AuthApikeyConfig,
  AuthCimdConfig,
  AuthOauthConfig,
  AuthOidcConfig,
  AuthProviderConfig,
  AuthStrategyName,
} from '@mcp-toolkit/auth/config';
import type {
  PromptDefinition,
  ResourceDefinition,
  ToolDefinition,
} from '@mcp-toolkit/mcp';
import type { McpConfig } from '@mcp-toolkit/mcp/config';
import type { PolicyEnforcer } from '@mcp-toolkit/policy';
import type { SessionStore, TokenStore } from '@mcp-toolkit/storage';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { createAuthHeaderMiddleware } from './middlewares/auth.ts';
import { corsMiddleware } from './middlewares/cors.ts';
import { requestLogger } from './middlewares/request-log.ts';
import { createMcpSecurityMiddleware } from './middlewares/security.ts';
import { buildDiscoveryRoutes } from './routes/discovery.ts';
import { healthRoutes } from './routes/health.ts';
import { buildMcpRoutes } from './routes/mcp-node.ts';

/**
 * Nested config slice required by the Node MCP HTTP transport.
 *
 * Mirrors the composed `AppConfig` shape from `apps/server/src/config.ts` —
 * callers project from their already-parsed config rather than threading
 * 25 flat env-shaped keys. The Node OAuth Authorization Server lives in
 * a separate Hono app (`buildOAuthServerApp`), so the auth slice here only
 * needs what `/mcp` + `/.well-known/*` discovery routes consume.
 */
export interface BuildHttpAppConfig {
  /** Runtime context for security middleware + dev branches. */
  server: {
    nodeEnv: string;
    allowedOrigins: readonly string[];
    /** Used by `nodeDiscoveryStrategy` to derive the AS base URL (PORT+1). */
    port: number;
  };
  /** MCP catalog metadata + audit-on-list toggle. */
  mcp: McpConfig;
  /** Auth slice — only what the transport needs for routing/audit/discovery. */
  auth: {
    strategy: AuthStrategyName;
    /** Audit `apiKeyHeader` + static key lookup for session bookkeeping. */
    apikey: AuthApikeyConfig;
    /** Optional protected-resource discovery URL (advertised in metadata). */
    discoveryUrl?: string;
    /** OAuth discovery + redirects (consumed by `routes/discovery.ts`). */
    oauth: AuthOauthConfig;
    /** OIDC issuer (read indirectly through discovery handlers). */
    oidc: AuthOidcConfig;
    /** CIMD knobs — `enabled` is read by the discovery metadata builder. */
    cimd: AuthCimdConfig;
    /** Legacy compat; reserved for future use. */
    provider: AuthProviderConfig;
  };
}

export interface BuildHttpAppOptions {
  /**
   * Factory that produces a fresh `McpServer` (from `buildServer` in
   * `@mcp-toolkit/mcp`) per session. Required because the MCP SDK's `Protocol`
   * binds one transport per server lifetime — sharing a single instance
   * across sessions throws "Already connected to a transport" on the second
   * `initialize`.
   */
  buildServer: () => McpServer;
  /**
   * Optional registry of live per-session servers. The Node transport adds
   * on session create and removes on close; lifecycle helpers (e.g., the
   * example-4 status updater) iterate this set to fan notifications to every
   * connected client. Defaults to an internal set when omitted.
   */
  liveServers?: Set<McpServer>;
  /** Active auth strategy. */
  auth: AuthStrategy;
  /**
   * Optional policy enforcer. Currently unused inside the transport
   * (gating happens in the dispatcher / builder). Accepted for forward
   * compatibility — passing it here keeps a single source of truth for
   * the composed app shape.
   */
  policy?: PolicyEnforcer;
  /**
   * Token store. Required when the strategy maps RS tokens to provider
   * tokens (`oidc`); ignored by other strategies.
   */
  tokenStore?: TokenStore;
  /** Session store. */
  sessionStore: SessionStore;
  /**
   * Registries — only used by the Workers dispatcher path. Accepted here
   * so the same options object can drive both `buildHttpApp` and
   * `buildWorkersHandler` without re-shaping. Unused by the Node Hono
   * route (the SDK transport reads handlers off `server`).
   */
  registries?: {
    tools: ToolDefinition[];
    prompts: PromptDefinition[];
    resources: ResourceDefinition[];
  };
  config: BuildHttpAppConfig;
}

/**
 * Build the Hono app exposing `/health`, the `.well-known/*` discovery
 * routes, and the `/mcp` MCP endpoint.
 *
 * The returned app is unwrapped — i.e. the caller is responsible for
 * dropping it into `@hono/node-server`'s `serve()` (Node) or attaching
 * its `fetch` to a Workers handler. This package never imports
 * `@hono/node-server` so it stays Workers-safe at the source level.
 */
export function buildHttpApp(opts: BuildHttpAppOptions): Hono {
  const { buildServer, auth, tokenStore, sessionStore, config } = opts;
  const liveServers = opts.liveServers ?? new Set<McpServer>();

  const app = new Hono();

  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const allowedOrigins = config.server.allowedOrigins;
  const isDev = config.server.nodeEnv === 'development';

  // Global middleware. The request logger runs first so we see *every*
  // inbound request — including ones that CORS / auth would reject — which
  // is the only way to diagnose "client says fetch failed but server logs
  // are silent" issues.
  app.use('*', requestLogger());
  app.use('*', corsMiddleware({ allowedOrigins, isDev }));

  // Routes (discovery / health are unauthenticated by spec — only `/mcp`
  // runs through the auth + security middlewares).
  app.route('/', healthRoutes());
  app.route(
    '/',
    buildDiscoveryRoutes({
      port: config.server.port,
      oauth: { scopes: config.auth.oauth.scopes },
      cimd: { enabled: config.auth.cimd.enabled },
      auth: { discoveryUrl: config.auth.discoveryUrl },
    }),
  );

  // MCP endpoint: security pre-flight + strategy verification. After F3 the
  // auth middleware is `requireAuth: true` here, so any strategy whose
  // verify() fails surfaces its 401 challenge directly (closing the
  // "Node bypasses Bearer validation" seam documented in
  // strategies-node.test.ts before F3). `none` strategy's verify always
  // returns ok, so wide-open dev servers are unaffected.
  app.use(
    '/mcp',
    createAuthHeaderMiddleware({
      strategy: auth,
      tokenStore,
      requireAuth: true,
    }),
  );
  app.use(
    '/mcp',
    createMcpSecurityMiddleware({
      config: {
        nodeEnv: config.server.nodeEnv,
        protocolVersion: config.mcp.protocolVersion,
        allowedOrigins: config.server.allowedOrigins,
      },
    }),
  );
  app.route(
    '/mcp',
    buildMcpRoutes({
      buildServer,
      liveServers,
      transports,
      sessionStore,
      userAuditOnList: config.mcp.userAuditOnList,
      apiKeyHeader: config.auth.apikey.headerName,
      staticApiKey: config.auth.apikey.key,
      registries: opts.registries,
      policy: opts.policy,
    }),
  );

  return app;
}
