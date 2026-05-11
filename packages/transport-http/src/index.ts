/**
 * `@mcp-toolkit/transport-http` — root barrel.
 *
 * Exposes the runtime-agnostic pieces (middlewares, route builders that
 * don't depend on Node/Workers specifics, types). Consumers that need the
 * Node-specific or Workers-specific entry points should import from the
 * subpaths:
 *
 *   import { buildHttpApp, buildOAuthServerApp } from '@mcp-toolkit/transport-http/node';
 *   import { buildWorkersHandler } from '@mcp-toolkit/transport-http/workers';
 *
 * The root barrel re-exports primitives that are safe in either runtime:
 * the auth and security middlewares, the CORS factory, the discovery /
 * OAuth route builders, and the option types for both entry points.
 */

export type {
  BuildHttpAppConfig,
  BuildHttpAppOptions,
} from './builder.ts';
export {
  type AuthMiddlewareOptions,
  createAuthHeaderMiddleware,
  type ResolvedAuthContext,
} from './middlewares/auth.ts';
export { corsMiddleware } from './middlewares/cors.ts';
export {
  createMcpSecurityMiddleware,
  type SecurityMiddlewareConfig,
  type SecurityMiddlewareOptions,
} from './middlewares/security.ts';
export type {
  BuildOAuthServerConfig,
  BuildOAuthServerOptions,
} from './oauth-server.ts';
export {
  buildDiscoveryRoutes,
  type DiscoveryRoutesConfig,
} from './routes/discovery.ts';
export { healthRoutes } from './routes/health.ts';
export { buildOAuthRoutes, type OAuthRoutesConfig } from './routes/oauth.ts';
