/**
 * Workers entry barrel for `@mcp-toolkit/transport-http`.
 *
 * Exposes a fetch-handler factory and re-exports the router primitives so
 * `apps/server/src/worker.ts` can wire its compose layer in. **Strictly no
 * `node:*` imports**, even transitively.
 */

import type { AuthStrategy } from '@mcp-toolkit/auth';
import type { AuthConfig } from '@mcp-toolkit/auth/config';
import type {
  PromptDefinition,
  ResourceDefinition,
  ToolDefinition,
} from '@mcp-toolkit/mcp';
import type { McpConfig } from '@mcp-toolkit/mcp/config';
import type { PolicyEnforcer } from '@mcp-toolkit/policy';
import type { SessionStore, TokenStore } from '@mcp-toolkit/storage';
import {
  createWorkerRouter,
  type WorkersRouterConfig,
  type WorkersRouterDeps,
} from './router.ts';

export type { WorkersHandlerConfig, WorkersHandlerDeps } from './mcp-handler.ts';
export {
  handleMcpDelete,
  handleMcpGet,
  handleMcpRequest,
} from './mcp-handler.ts';
export { attachDiscoveryRoutes } from './routes-discovery.ts';
export type { WorkersOAuthRoutesConfig } from './routes-oauth.ts';
export { attachOAuthRoutes } from './routes-oauth.ts';
export type { WorkersSecurityConfig } from './security.ts';
export { checkAuthAndChallenge } from './security.ts';
export type { WorkersRouterConfig, WorkersRouterDeps };
export { createWorkerRouter };

/**
 * Nested config slice consumed by `buildWorkersHandler`. Mirrors the
 * `AppConfig` shape so the caller can thread already-parsed slices through
 * directly — no flat env-shaped keys. The router internally projects this
 * onto each downstream consumer (handler / discovery / oauth flow).
 *
 * Workers serves the OAuth AS endpoints from the same fetch handler, so
 * unlike the Node `BuildHttpAppConfig` slice we need the full `AuthConfig`
 * here (not just `apikey + discoveryUrl + oauth + cimd`).
 */
export interface BuildWorkersHandlerConfig {
  server: {
    /** Runtime environment (`development` / `production` / `test`). */
    nodeEnv: string;
    /** Browser-Origin allowlist (CORS + origin preflight). */
    allowedOrigins: readonly string[];
    /** Port the server listens on (used in AS metadata base-URL synthesis). */
    port: number;
  };
  mcp: McpConfig;
  /** Workers serves OAuth AS endpoints from the same handler — needs full auth slice. */
  auth: AuthConfig;
}

/**
 * Options for `buildWorkersHandler`. Mirrors `BuildHttpAppOptions` from the
 * Node entry, minus the SDK `McpServer` (the Workers transport bypasses
 * the SDK transport — `dispatchMcpMethod` handles JSON-RPC directly).
 */
export interface BuildWorkersHandlerOptions {
  auth: AuthStrategy;
  tokenStore?: TokenStore;
  sessionStore: SessionStore;
  registries: {
    tools: ToolDefinition[];
    prompts: PromptDefinition[];
    resources: ResourceDefinition[];
  };
  policy?: PolicyEnforcer;
  config: BuildWorkersHandlerConfig;
}

/**
 * Build a Workers fetch handler. The returned object exposes a single
 * `fetch(request, env, ctx)` method ready to be exported as the Worker
 * default export.
 *
 * `env` and `ctx` are accepted for compatibility with the Workers fetch
 * signature but are not consumed here — the caller composes a fresh
 * router on every request, which is fine for Workers' isolate model.
 */
export function buildWorkersHandler(opts: BuildWorkersHandlerOptions): {
  fetch: (request: Request, env?: unknown, ctx?: unknown) => Promise<Response>;
} {
  // `BuildWorkersHandlerConfig` and `WorkersRouterConfig` are structurally
  // identical by design — the router-level shape is the natural composition
  // point and the builder simply forwards it. Kept as separate names so that
  // a future divergence (e.g. builder-only knobs that don't reach the router)
  // doesn't require a type rename.
  const routerConfig: WorkersRouterConfig = opts.config;

  const router = createWorkerRouter({
    auth: opts.auth,
    tokenStore: opts.tokenStore,
    sessionStore: opts.sessionStore,
    registries: opts.registries,
    policy: opts.policy,
    config: routerConfig,
  });

  return {
    fetch: (request: Request) => router.fetch(request),
  };
}
