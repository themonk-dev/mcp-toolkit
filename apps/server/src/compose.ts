/**
 * The lego board.
 *
 * `compose()` takes a validated nested {@link AppConfig} and (optionally)
 * overrides for any of the registries / stores / context resolver, and
 * returns a {@link ComposedRuntime} ready to be handed to a transport.
 * Selecting an auth strategy is one line; turning policy off is one line;
 * dropping prompts is one line.
 *
 * **Strictly no `node:*` imports.** Both Node and Workers entries import
 * from this file; runtime-specific concerns (file token store, ALS context
 * resolver) are passed in by the caller.
 */

import type { AuthStrategy, SessionIdentity } from '@mcp-toolkit/auth';
import {
  apiKeyStrategy,
  bearerStrategy,
  customHeadersStrategy,
  parseCustomHeaders,
} from '@mcp-toolkit/auth/apikey';
import { jwtStrategy } from '@mcp-toolkit/auth/jwt';
import { noneStrategy } from '@mcp-toolkit/auth/none';
import type { FlowConfigInput } from '@mcp-toolkit/auth/oauth/input-parsers';
import { oidcStrategy } from '@mcp-toolkit/auth/oidc';
import { sharedLogger as logger, type RequestContext } from '@mcp-toolkit/core';
import {
  buildServer,
  type PromptDefinition,
  type ResourceDefinition,
  type ToolDefinition,
} from '@mcp-toolkit/mcp';
import { getPolicyEngine, type PolicyEnforcer } from '@mcp-toolkit/policy';
import { examplePrompts } from '@mcp-toolkit/prompts/examples';
import { exampleResources, startStatusUpdates } from '@mcp-toolkit/resources/examples';
import {
  MemorySessionStore,
  MemoryTokenStore,
  type SessionStore,
  type TokenStore,
} from '@mcp-toolkit/storage';
import { exampleTools } from '@mcp-toolkit/tools/examples';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AppConfig } from './config.ts';

export interface ComposeOptions {
  config: AppConfig;
  /** Override the tool registry (default: `exampleTools`). */
  tools?: ToolDefinition[];
  /** Override the prompt registry (default: `examplePrompts`). */
  prompts?: PromptDefinition[];
  /** Override the resource registry (default: `exampleResources`). */
  resources?: ResourceDefinition[];
  /** Token store. Defaults to in-memory. */
  tokenStore?: TokenStore;
  /** Session store. Defaults to in-memory. */
  sessionStore?: SessionStore;
  /**
   * Runtime-specific request context resolver. Pass `getCurrentContext` from
   * `@mcp-toolkit/mcp/runtime/als-node` on Node; omit (or pass a no-op) on
   * Workers — the Workers transport threads the context explicitly.
   */
  getContext?: () => RequestContext | undefined;
}

export interface ComposedRuntime {
  /**
   * Factory producing a fresh `McpServer` per session. The Node transport
   * calls this on every `initialize` because the MCP SDK's `Protocol` binds
   * one transport per server lifetime — sharing a single instance across
   * sessions throws "Already connected to a transport" on the second
   * `connect()`. The Workers transport bypasses `McpServer` and does not
   * call this factory.
   */
  buildServer: () => McpServer;
  /**
   * Live per-session `McpServer` instances. The Node transport adds on
   * session create and removes on session close; long-running lifecycle
   * helpers (e.g., the example-4 status updater) iterate this set to fan
   * out notifications to every connected client.
   */
  liveServers: Set<McpServer>;
  auth: AuthStrategy;
  policy: PolicyEnforcer | null;
  tokenStore: TokenStore;
  sessionStore: SessionStore;
  registries: {
    tools: ToolDefinition[];
    prompts: PromptDefinition[];
    resources: ResourceDefinition[];
  };
  /**
   * Cleanup hook for the registry-side timers / subscriptions wired up by
   * `compose` (e.g., the example-4 status-resource updater). Caller is
   * responsible for stopping its own stores' cleanup loops.
   */
  shutdown: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth strategy selection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Project the nested {@link AppConfig} onto the {@link FlowConfigInput} shape
 * the auth package expects. Pure data movement — no coercion, no defaults.
 */
function buildFlowConfig(config: AppConfig): FlowConfigInput {
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

/** Compile-time exhaustiveness check; throws if a new AUTH_STRATEGY slips past the switch. */
function assertNever(x: never): never {
  throw new Error(`Unhandled AUTH_STRATEGY value: ${String(x)}`);
}

/**
 * Select and build the auth strategy. Adding a strategy means adding one
 * branch here; removing one means deleting one branch. There is no inherited
 * "switch with six cases" any more — each branch is self-contained.
 */
export function selectAuthStrategy(
  config: AppConfig,
  tokenStore: TokenStore,
): AuthStrategy {
  const { auth } = config;
  const kind = auth.strategy;
  switch (kind) {
    case 'oidc':
    case 'oauth':
      return oidcStrategy({
        config: buildFlowConfig(config),
        tokenStore,
        kind: kind === 'oauth' ? 'oauth' : 'oidc',
      });
    case 'jwt': {
      if (!auth.jwt.jwksUrl) {
        throw new Error('AUTH_STRATEGY=jwt requires JWT_JWKS_URL');
      }
      return jwtStrategy({
        jwksUrl: auth.jwt.jwksUrl,
        issuer: auth.jwt.issuer,
        audience: auth.jwt.audience,
      });
    }
    case 'apikey': {
      if (!auth.apikey.key) {
        throw new Error('AUTH_STRATEGY=apikey requires API_KEY');
      }
      return apiKeyStrategy({
        apiKey: auth.apikey.key,
        headerName: auth.apikey.headerName,
      });
    }
    case 'bearer': {
      if (!auth.bearer.token) {
        throw new Error('AUTH_STRATEGY=bearer requires BEARER_TOKEN');
      }
      return bearerStrategy({ token: auth.bearer.token });
    }
    case 'custom': {
      const headers = parseCustomHeaders(auth.custom.headers);
      if (Object.keys(headers).length === 0) {
        throw new Error('AUTH_STRATEGY=custom requires CUSTOM_HEADERS');
      }
      return customHeadersStrategy({ headers });
    }
    case 'none':
      return noneStrategy();
    default:
      return assertNever(kind);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compose
// ─────────────────────────────────────────────────────────────────────────────

export async function compose(opts: ComposeOptions): Promise<ComposedRuntime> {
  const { config, getContext } = opts;

  const tokenStore: TokenStore = opts.tokenStore ?? new MemoryTokenStore();
  const sessionStore: SessionStore = opts.sessionStore ?? new MemorySessionStore();

  // Example arrays are already typed as the open `ToolDefinition[]` /
  // `PromptDefinition[]` / `ResourceDefinition[]` shapes (see each package's
  // `examples/index.ts`), so no variance casts are needed.
  const tools: ToolDefinition[] = opts.tools ?? exampleTools;
  const prompts: PromptDefinition[] = opts.prompts ?? examplePrompts;
  const resources: ResourceDefinition[] = opts.resources ?? exampleResources;

  const auth = selectAuthStrategy(config, tokenStore);
  const policy = getPolicyEngine({ content: config.policy.content });

  // Warm any per-strategy caches (OIDC discovery, JWKS) before the first
  // request lands. Failures are logged but non-fatal — verify() will surface
  // them per request anyway.
  if (auth.init) {
    try {
      await auth.init();
    } catch (error) {
      logger.warning('compose', {
        message: 'auth.init() failed',
        kind: auth.kind,
        error: (error as Error).message,
      });
    }
  }

  // Closure-captured factory: each call produces a fresh `McpServer` wired
  // to the same registries / auth / policy. The Node transport invokes this
  // on every `initialize`; the Workers transport ignores it.
  const buildMcpServer = (): McpServer =>
    buildServer({
      name: config.mcp.title,
      version: config.mcp.version,
      instructions: config.mcp.instructions,
      tools,
      prompts,
      resources,
      auth,
      policy: policy ?? undefined,
      getContext,
    });

  const liveServers = new Set<McpServer>();

  // Wire example-4's background updater iff the example resource is in the
  // registry. Custom registries that drop the status resource will skip this
  // automatically. Keep the cleanup so `shutdown()` can stop the timer.
  let stopStatusUpdates: (() => void) | undefined;
  const hasStatusResource = resources.some((r) => r.uri === 'status://server');
  if (hasStatusResource) {
    stopStatusUpdates = startStatusUpdates(liveServers);
  }

  const shutdown = (): void => {
    try {
      stopStatusUpdates?.();
    } catch (error) {
      logger.warning('compose', {
        message: 'shutdown: stopStatusUpdates threw',
        error: (error as Error).message,
      });
    }
  };

  logger.info('compose', {
    message: 'Runtime composed',
    auth: auth.kind,
    policy: policy?.isEnforced() ?? false,
    tools: tools.length,
    prompts: prompts.length,
    resources: resources.length,
  });

  return {
    buildServer: buildMcpServer,
    liveServers,
    auth,
    policy,
    tokenStore,
    sessionStore,
    registries: { tools, prompts, resources },
    shutdown,
  };
}

// Re-exports for convenience (handlers built on `ComposedRuntime` may want
// these types without dipping into multiple packages).
export type { AuthStrategy, SessionIdentity };
