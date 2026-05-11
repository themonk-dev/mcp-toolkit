/**
 * Cloudflare Workers router factory.
 *
 * Originally `src/adapters/http-workers/index.ts`. The legacy file had a
 * "shared memory store fallback" + KV initialization concerns baked in;
 * those are now the caller's responsibility (`apps/server/src/worker.ts`).
 * This module focuses on routing and delegates auth/MCP to the injected
 * dependencies.
 *
 * Strictly no `node:*` imports — Workers safety.
 */

import type { AuthConfig } from '@mcp-toolkit/auth/config';
import type { DiscoveryConfigInput } from '@mcp-toolkit/auth/oauth/discovery-handlers';
import type { FlowConfigInput } from '@mcp-toolkit/auth/oauth/input-parsers';
import { corsPreflightResponse, withCors } from '@mcp-toolkit/core';
import { isLoopbackOrigin } from '@mcp-toolkit/mcp';
import type { McpConfig } from '@mcp-toolkit/mcp/config';
import { Router } from 'itty-router';
import {
  handleMcpDelete,
  handleMcpGet,
  handleMcpRequest,
  type WorkersHandlerConfig,
  type WorkersHandlerDeps,
} from './mcp-handler.ts';
import { attachDiscoveryRoutes } from './routes-discovery.ts';
import { attachOAuthRoutes } from './routes-oauth.ts';

/**
 * Resolve the `Access-Control-Allow-Origin` value for a request based on
 * the configured allowlist. Mirrors the Hono CORS middleware behaviour:
 *   - request without `Origin` header → returns `undefined` (Hono drops the
 *     header in that case; we omit it from the response to match).
 *   - allowlisted origin → echo back.
 *   - dev + loopback origin → echo back.
 *   - otherwise → empty string (so browsers reject the request).
 */
function resolveAllowedOrigin(
  request: Request,
  allowedOrigins: readonly string[],
  isDev: boolean,
): string | undefined {
  const origin = request.headers.get('Origin') ?? request.headers.get('origin');
  if (!origin) return undefined;
  if (allowedOrigins.includes(origin)) return origin;
  if (isDev && isLoopbackOrigin(origin)) return origin;
  return '';
}

const MCP_ENDPOINT_PATH = '/mcp';

/**
 * Composite config for the Workers router. Nested shape mirrors `AppConfig`
 * so callers (`apps/server/src/worker.ts` after C4) thread their already-
 * parsed slices straight through. The router internally projects this onto
 * the narrower slices each downstream consumer expects:
 *
 *   - {@link WorkersHandlerConfig}        — `server.{nodeEnv,allowedOrigins}` + `mcp` + `auth.apikey`
 *   - {@link DiscoveryConfigInput}        — `{port, oauth.scopes, cimd.enabled, auth.discoveryUrl}`
 *   - {@link FlowConfigInput}             — full OAuth-flow slice for `attachOAuthRoutes`
 */
export interface WorkersRouterConfig {
  server: {
    /** Runtime environment (development relaxes the CORS allowlist to loopbacks). */
    nodeEnv: string;
    /** Browser-Origin allowlist. */
    allowedOrigins: readonly string[];
    /** Port the server listens on (advertised in `/.well-known/oauth-authorization-server`). */
    port: number;
  };
  mcp: McpConfig;
  /** Workers serves the OAuth AS endpoints from the same handler, so it needs the full auth slice. */
  auth: AuthConfig;
}

export interface WorkersRouterDeps extends Omit<WorkersHandlerDeps, 'config'> {
  config: WorkersRouterConfig;
}

/**
 * Project the composite router config onto the slice the MCP POST handler
 * consumes: `server.{nodeEnv,allowedOrigins}` + `mcp` + `auth.apikey`.
 */
function handlerConfigFromRouterConfig(
  config: WorkersRouterConfig,
): WorkersHandlerConfig {
  return {
    server: {
      nodeEnv: config.server.nodeEnv,
      allowedOrigins: config.server.allowedOrigins,
    },
    mcp: config.mcp,
    auth: { apikey: config.auth.apikey },
  };
}

/**
 * Project onto the {@link DiscoveryConfigInput} shape consumed by
 * `createDiscoveryHandlers` (called inside `attachDiscoveryRoutes`).
 */
function discoveryConfigFromRouterConfig(
  config: WorkersRouterConfig,
): DiscoveryConfigInput {
  return {
    port: config.server.port,
    oauth: { scopes: config.auth.oauth.scopes },
    cimd: { enabled: config.auth.cimd.enabled },
    auth: { discoveryUrl: config.auth.discoveryUrl },
  };
}

/**
 * Project onto the {@link FlowConfigInput} shape consumed by
 * `attachOAuthRoutes`. Threads `nodeEnv` (transport-level) into the
 * auth-level flow context.
 */
function flowConfigFromRouterConfig(config: WorkersRouterConfig): FlowConfigInput {
  return {
    nodeEnv: config.server.nodeEnv,
    strategy: config.auth.strategy,
    oauth: config.auth.oauth,
    oidc: config.auth.oidc,
    provider: config.auth.provider,
    cimd: config.auth.cimd,
    resourceUri: config.auth.resourceUri,
    discoveryUrl: config.auth.discoveryUrl,
    requireRs: config.auth.requireRs,
  };
}

/**
 * Create a configured router for the Worker.
 */
export function createWorkerRouter(deps: WorkersRouterDeps): {
  fetch: (request: Request) => Promise<Response>;
} {
  const router = Router();
  const { auth, tokenStore, sessionStore, registries, policy, audit, config } = deps;
  const allowedOrigins = config.server.allowedOrigins;
  const isDev = config.server.nodeEnv === 'development';

  const handlerConfig = handlerConfigFromRouterConfig(config);
  const discoveryConfig = discoveryConfigFromRouterConfig(config);
  const flowConfig = flowConfigFromRouterConfig(config);

  // CORS preflight — consult the allowlist instead of mirroring `*`.
  router.options('*', (request: Request) => {
    const origin = resolveAllowedOrigin(request, allowedOrigins, isDev);
    return corsPreflightResponse(origin === undefined ? {} : { origin });
  });

  // Discovery routes (/.well-known/*)
  attachDiscoveryRoutes(router, discoveryConfig);

  // OAuth routes (/authorize, /token, /oauth/callback, etc.) — only mount
  // when a token store is available. Without one the strategy can't map
  // RS↔provider, so the AS endpoints would 500 anyway.
  if (tokenStore) {
    attachOAuthRoutes(router, tokenStore, flowConfig);
  }

  // MCP endpoints
  router.get(MCP_ENDPOINT_PATH, () => handleMcpGet());

  router.post(MCP_ENDPOINT_PATH, (request: Request) =>
    handleMcpRequest(request, {
      auth,
      tokenStore,
      sessionStore,
      registries,
      policy,
      audit,
      config: handlerConfig,
    }),
  );

  router.delete(MCP_ENDPOINT_PATH, (request: Request) =>
    handleMcpDelete(request, { sessionStore }),
  );

  // Health check
  router.get('/health', () =>
    withCors(
      new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );

  // Catch-all 404
  router.all('*', () => withCors(new Response('Not Found', { status: 404 })));

  // Wrap router.fetch so we can post-process the CORS headers — handlers
  // internally call `withCors(...)` which defaults to `Access-Control-Allow-Origin: *`.
  // After F3 we want explicit allowlist gating: override the header with the
  // resolved value (or drop it when the request has no Origin / is not
  // browser-initiated, mirroring Hono's behaviour).
  const innerFetch = router.fetch.bind(router) as (
    request: Request,
  ) => Promise<Response>;
  return {
    fetch: async (request: Request): Promise<Response> => {
      const response = await innerFetch(request);
      const resolved = resolveAllowedOrigin(request, allowedOrigins, isDev);
      if (resolved === undefined) {
        // No Origin header: drop ACAO so the response looks like a normal
        // non-CORS reply (we never emit a wildcard for non-browser callers).
        response.headers.delete('Access-Control-Allow-Origin');
      } else {
        response.headers.set('Access-Control-Allow-Origin', resolved);
      }
      return response;
    },
  };
}
