/**
 * Pluggable MCP server builder.
 *
 * Replaces the legacy hard-coded `registerTools/Prompts/Resources` calls
 * with a composer that takes arrays + an optional auth strategy + an
 * optional policy enforcer. This is the single place that touches the SDK's
 * `server.registerTool` / `server.registerPrompt` / `server.registerResource`
 * APIs — downstream registry packages just publish their definitions.
 */

import type { AuthStrategy } from '@mcp-toolkit/auth';
import { resolveIdentityForMcp } from '@mcp-toolkit/auth';
import { sharedLogger as logger, type RequestContext } from '@mcp-toolkit/core';
import { buildPolicySubject, type PolicyEnforcer } from '@mcp-toolkit/policy';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type Implementation,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  type ServerCapabilities,
  SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ZodObject, ZodRawShape, ZodTypeAny } from 'zod';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { buildCapabilities } from './capabilities.ts';
import { providerToToolShape } from './dispatcher.ts';
import type { McpIconDescriptor } from './icons.ts';
import { getLowLevelServer } from './server-internals.ts';
import type {
  PromptDefinition,
  PromptResult,
  ResourceContent,
  ResourceDefinition,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from './types.ts';

/**
 * Options accepted by `buildServer`.
 *
 * `auth` and `policy` are the two pluggable extension points; both are
 * optional. When `policy` is omitted, gating is off and every request reaches
 * its handler. When `auth` is omitted, the caller is responsible for staffing
 * the request via its own middleware (the builder does not wire auth into
 * the SDK transport — that's the transport package's job).
 */
export interface BuildServerOptions {
  name: string;
  version: string;
  instructions?: string;
  tools?: ToolDefinition[];
  prompts?: PromptDefinition[];
  resources?: ResourceDefinition[];
  /**
   * Active auth strategy. Reserved for transport-package wiring; the builder
   * itself does not call `verify()` (that lives in `@mcp-toolkit/transport-http`).
   */
  auth?: AuthStrategy;
  /** Optional policy enforcer; gating is off when undefined. */
  policy?: PolicyEnforcer;
  /** Override the derived capabilities advertised on `initialize`. */
  capabilities?: ServerCapabilities;
  icons?: McpIconDescriptor[];
  oninitialized?: () => void;
  /**
   * Optional resolver that returns the live `RequestContext` for the
   * currently in-flight request. Pass `getCurrentContext` from
   * `@mcp-toolkit/mcp/runtime/als-node` on Node, or a no-op (`() => undefined`)
   * on Workers.
   */
  getContext?: () => RequestContext | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the shape from a Zod schema, handling ZodEffects (refined schemas).
 * ZodEffects wraps the inner schema when using .refine(), .transform(), etc.
 */
function getSchemaShape(schema: ZodTypeAny): ZodRawShape | undefined {
  if ('shape' in schema && typeof schema.shape === 'object') {
    return (schema as ZodObject<ZodRawShape>).shape;
  }
  if ('_def' in schema && schema._def && typeof schema._def === 'object') {
    const def = schema._def as { schema?: ZodTypeAny; innerType?: ZodTypeAny };
    if (def.schema) return getSchemaShape(def.schema);
    if (def.innerType) return getSchemaShape(def.innerType);
  }
  return undefined;
}

function buildToolContextFromRequest(
  ctx: RequestContext | undefined,
  extra: {
    sessionId?: string;
    requestId?: string | number;
    signal?: AbortSignal;
    _meta?: { progressToken?: string | number };
  },
): ToolContext {
  return {
    sessionId: ctx?.sessionId ?? extra.sessionId ?? crypto.randomUUID(),
    signal: extra.signal,
    meta: {
      progressToken: extra._meta?.progressToken,
      requestId: extra.requestId !== undefined ? String(extra.requestId) : undefined,
    },
    authStrategy: ctx?.authStrategy,
    providerToken: ctx?.providerToken,
    provider: providerToToolShape(ctx?.provider),
    resolvedHeaders: ctx?.resolvedHeaders,
    identity: ctx?.identity,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool execution wrapper
// ─────────────────────────────────────────────────────────────────────────────

async function runToolWithGate(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  toolCtx: ToolContext,
  policy: PolicyEnforcer | undefined,
): Promise<ToolResult> {
  // Policy gate (skipped when policy is off / not enforced).
  if (policy?.isEnforced()) {
    const id = resolveIdentityForMcp(toolCtx.identity, toolCtx.provider ?? null);
    const subject = buildPolicySubject(id, policy.policy.principal_aliases);
    if (!policy.canAccessTool(tool.name, subject)) {
      logger.info('mcp_policy', {
        message: 'Tool call denied by group policy',
        tool: tool.name,
        sessionId: toolCtx.sessionId,
        principalGroups: [...subject.groupSet].sort(),
      });
      return {
        content: [
          {
            type: 'text',
            text: 'Forbidden: insufficient group membership for this tool',
          },
        ],
        isError: true,
      };
    }
  }

  if (toolCtx.signal?.aborted) {
    return {
      content: [{ type: 'text', text: 'Operation was cancelled' }],
      isError: true,
    };
  }

  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    const errors = parsed.error.errors
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join(', ');
    return {
      content: [{ type: 'text', text: `Invalid input: ${errors}` }],
      isError: true,
    };
  }

  try {
    const result = await tool.handler(
      parsed.data as Parameters<typeof tool.handler>[0],
      toolCtx,
    );

    if (tool.outputSchema && !result.isError && !result.structuredContent) {
      return {
        content: [
          {
            type: 'text',
            text: 'Tool with outputSchema must return structuredContent (unless isError is true)',
          },
        ],
        isError: true,
      };
    }
    return result;
  } catch (error) {
    if (toolCtx.signal?.aborted) {
      return {
        content: [{ type: 'text', text: 'Operation was cancelled' }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: `Tool error: ${(error as Error).message}` }],
      isError: true,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────────────

interface ToolHandlerExtra {
  sessionId?: string;
  requestId?: string | number;
  signal?: AbortSignal;
  _meta?: {
    progressToken?: string | number;
  };
}

/**
 * Build a configured `McpServer` from the supplied tools / prompts / resources
 * arrays + optional auth / policy. The returned instance has all SDK handlers
 * registered; callers attach it to a transport.
 */
export function buildServer(opts: BuildServerOptions): McpServer {
  const tools = opts.tools ?? [];
  const prompts = opts.prompts ?? [];
  const resources = opts.resources ?? [];

  const capabilities =
    opts.capabilities ?? buildCapabilities({ tools, prompts, resources });

  const serverInfo: Implementation = {
    name: opts.name,
    version: opts.version,
    ...(opts.icons?.length ? { icons: opts.icons } : {}),
  };

  const server = new McpServer(serverInfo, {
    capabilities,
    ...(opts.instructions ? { instructions: opts.instructions } : {}),
  });

  const lowLevel = getLowLevelServer(server);
  if (opts.oninitialized) {
    lowLevel.oninitialized = () => {
      logger.info('mcp', {
        message: 'Client initialization complete (notifications/initialized received)',
        clientVersion: lowLevel.getClientVersion?.(),
      });
      opts.oninitialized?.();
    };
  }

  // ───── Tools ─────
  for (const tool of tools) {
    const inputShape = getSchemaShape(tool.inputSchema);
    if (!inputShape) {
      throw new Error(`Failed to extract schema shape for tool: ${tool.name}`);
    }

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: inputShape,
        ...(tool.outputSchema && { outputSchema: tool.outputSchema }),
        ...(tool.annotations && { annotations: tool.annotations }),
      },
      async (args: Record<string, unknown>, extra: ToolHandlerExtra) => {
        const requestCtx = opts.getContext?.();
        const toolCtx = buildToolContextFromRequest(requestCtx, extra);
        const result = await runToolWithGate(tool, args, toolCtx, opts.policy);
        return result as never; // SDK's CallToolResult; structurally identical.
      },
    );
  }

  // Override tools/list to honour optional policy filtering. The SDK's
  // built-in handler doesn't know about policy. Skip registration entirely
  // when no tools are configured — the SDK refuses to install a tools/list
  // handler unless the `tools` capability is advertised, which only happens
  // when at least one tool is present (mirrors the prompts/resources guards
  // below).
  if (tools.length > 0) {
    server.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const catalog = tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.inputSchema),
        ...(t.outputSchema && {
          outputSchema: zodToJsonSchema(z.object(t.outputSchema)),
        }),
        ...(t.annotations && { annotations: t.annotations }),
      }));
      if (!opts.policy?.isEnforced()) return { tools: catalog };
      const requestCtx = opts.getContext?.();
      const id = resolveIdentityForMcp(requestCtx?.identity, requestCtx?.provider);
      const subject = buildPolicySubject(id, opts.policy.policy.principal_aliases);
      return { tools: opts.policy.filterTools(catalog, subject) };
    });
  }

  // ───── Prompts ─────
  for (const prompt of prompts) {
    server.registerPrompt(
      prompt.name,
      {
        ...(prompt.title ? { title: prompt.title } : {}),
        description: prompt.description,
        ...(prompt.argsSchema ? { argsSchema: prompt.argsSchema } : {}),
      },
      async (args: Record<string, unknown>) => {
        // Per-request policy gate.
        if (opts.policy?.isEnforced()) {
          const requestCtx = opts.getContext?.();
          const id = resolveIdentityForMcp(requestCtx?.identity, requestCtx?.provider);
          const subject = buildPolicySubject(id, opts.policy.policy.principal_aliases);
          if (!opts.policy.canAccessPrompt(prompt.name, subject)) {
            throw new Error(
              `Forbidden: insufficient group membership for prompt "${prompt.name}"`,
            );
          }
        }
        const result: PromptResult = await prompt.handler(args);
        return result as never;
      },
    );
  }

  if (prompts.length > 0) {
    server.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      const rows = prompts.map((p) => ({
        name: p.name,
        title: p.title,
        description: p.description,
        ...(p.arguments ? { arguments: p.arguments } : {}),
      }));
      if (!opts.policy?.isEnforced()) return { prompts: rows };
      const requestCtx = opts.getContext?.();
      const id = resolveIdentityForMcp(requestCtx?.identity, requestCtx?.provider);
      const subject = buildPolicySubject(id, opts.policy.policy.principal_aliases);
      return { prompts: opts.policy.filterPrompts(rows, subject) };
    });
  }

  // ───── Resources ─────
  for (const resource of resources) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.name,
        ...(resource.description ? { description: resource.description } : {}),
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
      },
      async () => {
        if (opts.policy?.isEnforced()) {
          const requestCtx = opts.getContext?.();
          const id = resolveIdentityForMcp(requestCtx?.identity, requestCtx?.provider);
          const subject = buildPolicySubject(id, opts.policy.policy.principal_aliases);
          if (!opts.policy.canAccessResource(resource.uri, subject)) {
            throw new Error(
              `Forbidden: insufficient group membership for resource "${resource.uri}"`,
            );
          }
        }
        const result = await resource.handler();
        // Match SDK ReadResourceResult shape.
        return { contents: result.contents as ResourceContent[] } as never;
      },
    );
  }

  if (resources.length > 0) {
    server.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const list = resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        title: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
      if (!opts.policy?.isEnforced()) return { resources: list };
      const requestCtx = opts.getContext?.();
      const id = resolveIdentityForMcp(requestCtx?.identity, requestCtx?.provider);
      const subject = buildPolicySubject(id, opts.policy.policy.principal_aliases);
      return { resources: opts.policy.filterResources(list, subject) };
    });
  }

  // logging/setLevel — required when the `logging` capability is advertised.
  server.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    const level = request.params.level;
    logger.info('mcp', { message: 'Log level changed', level });
    return {};
  });

  logger.info('mcp', {
    message: 'MCP server built',
    tools: tools.length,
    prompts: prompts.length,
    resources: resources.length,
    policy: Boolean(opts.policy?.isEnforced()),
    auth: opts.auth?.kind ?? 'none',
  });

  return server;
}
