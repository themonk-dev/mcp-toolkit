/**
 * Proxy-tool factory.
 *
 * For each configured downstream MCP server, returns one upstream
 * `ToolDefinition` whose name is the server id and whose `inputSchema`
 * is the generic `{ action, args }` shape. The handler closes over a
 * per-server `OutboundSession` and a TTL-bounded `tools/list` cache:
 *
 *   1. Resolve the credential (fail-soft with an MCP `isError`).
 *   2. Lazily initialize the session on first use.
 *   3. Lazily fetch `tools/list` and cache for {@link DEFAULT_TOOLS_CACHE_TTL_MS}.
 *   4. Validate `action` against the cache; unknown → `isError` with the
 *      list of known actions.
 *   5. Forward to the downstream and pass the result through verbatim.
 *
 * Error handling is asymmetric on purpose:
 * - `DownstreamAuthError` (401/403) bubbles up as `isError` only — the
 *   session is still healthy; the *credential* is the problem. (When OAuth2
 *   lands, this is also the natural place to flip a "needs-reauth" flag.)
 * - `DownstreamTransportError` (network, 5xx, etc.) evicts both the cached
 *   session AND the cached `tools/list` so the next call re-initializes
 *   cleanly.
 * - `DownstreamProtocolError` (JSON-RPC error envelope) bubbles up as
 *   `isError`; the session is still valid.
 */

import { sharedLogger as logger } from '@mcp-toolkit/core';
import type { ToolDefinition, ToolResult } from '@mcp-toolkit/mcp';
import {
  type AuthInject,
  DownstreamAuthError,
  DownstreamProtocolError,
  type DownstreamTool,
  DownstreamTransportError,
  type OutboundMcpClient,
  type OutboundSession,
} from '@mcp-toolkit/mcp-client';
import { z } from 'zod';
import { buildAuthInject } from './auth-inject.ts';
import type { ConnectedServer } from './config.ts';
import type { CredentialResolver } from './creds.ts';

export const DEFAULT_TOOLS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Reserved meta-action: calling the proxy tool with `action: LIST_ACTIONS`
 * returns the downstream's action catalog (name + description + inputSchema)
 * instead of forwarding to a downstream tool. The double-underscore prefix
 * makes collision with a real downstream tool name extremely unlikely; the
 * tool description advertises the name so callers can discover it.
 */
export const LIST_ACTIONS = '__list_actions__';

export interface BuildProxyToolsOpts {
  servers: ConnectedServer[];
  resolver: CredentialResolver;
  client: OutboundMcpClient;
  /** Override the per-server `tools/list` cache TTL. */
  toolsCacheTtlMs?: number;
}

const proxyInputShape = {
  action: z
    .string()
    .min(1)
    .describe('Name of the downstream tool to invoke on this server'),
  args: z
    .record(z.unknown())
    .optional()
    .describe('Arguments object forwarded verbatim to the downstream tool'),
};
const proxyInputSchema = z.object(proxyInputShape);

interface CachedTools {
  tools: DownstreamTool[];
  fetchedAt: number;
}

/**
 * Returns one open-typed {@link ToolDefinition} per configured server.
 *
 * The `as unknown as ToolDefinition[]` cast bridges variance: each entry is
 * a `ToolDefinition<typeof proxyInputShape>` (specific generic) but the
 * dispatcher and `compose()` expect the open `ToolDefinition<ZodRawShape>[]`
 * shape. `handler` is contravariant in `TShape`, so the specific form is
 * structurally narrower than the open form even though it satisfies the
 * wider contract at runtime. Same pattern as `@mcp-toolkit/tools/examples`.
 */
export function buildProxyTools(opts: BuildProxyToolsOpts): ToolDefinition[] {
  const ttlMs = opts.toolsCacheTtlMs ?? DEFAULT_TOOLS_CACHE_TTL_MS;
  const sessions = new Map<string, OutboundSession>();
  const toolsCache = new Map<string, CachedTools>();

  return opts.servers.map((server) =>
    buildOne(server, opts, sessions, toolsCache, ttlMs),
  ) as unknown as ToolDefinition[];
}

function buildOne(
  server: ConnectedServer,
  opts: BuildProxyToolsOpts,
  sessions: Map<string, OutboundSession>,
  toolsCache: Map<string, CachedTools>,
  ttlMs: number,
): ToolDefinition<typeof proxyInputShape> {
  return {
    name: server.id,
    title: `Proxy: ${server.id}`,
    description:
      `Proxy to the "${server.id}" downstream MCP server. ` +
      `Call with action="<downstream-tool-name>" and args=<that-tool's-arguments>. ` +
      `To discover available actions and their argument schemas, call with action="${LIST_ACTIONS}".`,
    inputSchema: proxyInputSchema,
    handler: async ({ action, args }, ctx) => {
      // 1. Credential
      let credInject: AuthInject;
      try {
        const cred = opts.resolver.resolve(server.id);
        credInject = buildAuthInject(cred);
      } catch (cause) {
        return errorResult(
          `No credential configured for "${server.id}": ${(cause as Error).message}`,
        );
      }

      // 2. Ensure session
      let session = sessions.get(server.id);
      if (!session) {
        try {
          session = await opts.client.initialize({
            serverId: server.id,
            url: server.url,
            authInject: credInject,
          });
          sessions.set(server.id, session);
        } catch (cause) {
          return mapClientError(server.id, cause, sessions, toolsCache);
        }
      }

      // 3. Ensure tools cache
      let cached = toolsCache.get(server.id);
      if (!cached || Date.now() - cached.fetchedAt > ttlMs) {
        try {
          const tools = await opts.client.listTools(session);
          cached = { tools, fetchedAt: Date.now() };
          toolsCache.set(server.id, cached);
        } catch (cause) {
          return mapClientError(server.id, cause, sessions, toolsCache);
        }
      }

      // 4. Meta-action: return the downstream catalog without forwarding.
      if (action === LIST_ACTIONS) {
        return buildListActionsResult(server.id, cached.tools);
      }

      // 5. Validate action
      const known = cached.tools.map((t) => t.name);
      if (!known.includes(action)) {
        return errorResult(
          `Unknown action "${action}" on "${server.id}". Known actions: ${
            known.length > 0 ? known.join(', ') : '<none>'
          }.`,
        );
      }

      // 6. Forward
      try {
        const result = await opts.client.callTool(
          session,
          action,
          args ?? {},
          ctx.signal,
        );
        return result as ToolResult;
      } catch (cause) {
        return mapClientError(server.id, cause, sessions, toolsCache);
      }
    },
  };
}

function mapClientError(
  serverId: string,
  cause: unknown,
  sessions: Map<string, OutboundSession>,
  toolsCache: Map<string, CachedTools>,
): ToolResult {
  if (cause instanceof DownstreamAuthError) {
    logger.warning('proxy_tool', {
      message: 'Downstream rejected credential',
      serverId,
      status: cause.status,
    });
    return errorResult(
      `Downstream "${serverId}" rejected credential (${cause.status}). Reconfigure the credential and retry.`,
    );
  }
  if (cause instanceof DownstreamProtocolError) {
    return errorResult(
      `Downstream "${serverId}" protocol error (${cause.code}): ${cause.message}`,
    );
  }
  if (cause instanceof DownstreamTransportError) {
    // Transport-level failure: the session is suspect. Evict caches so the
    // next call rebuilds cleanly. We do NOT retry inline — single
    // round-trip semantics keep the upstream's view of failures deterministic.
    sessions.delete(serverId);
    toolsCache.delete(serverId);
    logger.warning('proxy_tool', {
      message: 'Downstream transport error; evicted session',
      serverId,
      detail: cause.message,
    });
    return errorResult(`Downstream "${serverId}" transport error: ${cause.message}`);
  }
  return errorResult(`Downstream "${serverId}" error: ${(cause as Error).message}`);
}

function errorResult(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

/**
 * Render the downstream catalog for the `__list_actions__` meta-action.
 *
 * Both representations are returned: a human-readable text block (for
 * clients that only consume `content`) and a structured payload (for
 * clients / LLMs that parse `structuredContent`). The structured form
 * mirrors the downstream's `tools/list` entries 1:1 so callers can plug
 * the inputSchema straight into their reasoning.
 */
function buildListActionsResult(
  serverId: string,
  tools: DownstreamTool[],
): ToolResult {
  const actions = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  const lines =
    actions.length > 0
      ? actions
          .map((a) => `- ${a.name}${a.description ? `: ${a.description}` : ''}`)
          .join('\n')
      : '<no actions exposed by this server>';
  return {
    content: [
      {
        type: 'text',
        text: `Available actions on "${serverId}":\n${lines}`,
      },
    ],
    structuredContent: { serverId, actions },
  };
}
