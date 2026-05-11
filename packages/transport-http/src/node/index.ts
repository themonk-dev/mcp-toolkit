/**
 * Node entry barrel for `@mcp-toolkit/transport-http`.
 *
 * `apps/server/src/main.ts` imports from here. Pulls in the Node-only
 * `@mcp-toolkit/mcp/runtime/als-node` adapter transitively via the MCP route
 * handler — that's the single sanctioned `node:*` ingress point.
 */

export {
  type BuildHttpAppConfig,
  type BuildHttpAppOptions,
  buildHttpApp,
} from '../builder.ts';
export {
  type AuthMiddlewareOptions,
  createAuthHeaderMiddleware,
  type ResolvedAuthContext,
} from '../middlewares/auth.ts';
export { corsMiddleware } from '../middlewares/cors.ts';
export {
  createMcpSecurityMiddleware,
  type SecurityMiddlewareConfig,
  type SecurityMiddlewareOptions,
} from '../middlewares/security.ts';
export {
  type BuildOAuthServerConfig,
  type BuildOAuthServerOptions,
  buildOAuthServerApp,
} from '../oauth-server.ts';
export {
  buildDiscoveryRoutes,
  type DiscoveryRoutesConfig,
} from '../routes/discovery.ts';
export { healthRoutes } from '../routes/health.ts';
export {
  buildMcpRoutes,
  type McpNodeRoutesOptions,
} from '../routes/mcp-node.ts';
export { buildOAuthRoutes, type OAuthRoutesConfig } from '../routes/oauth.ts';
