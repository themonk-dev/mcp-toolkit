/**
 * Shared MCP JSON-RPC dispatcher.
 *
 * Used directly by the Workers transport (no SDK). Node also leans on this
 * dispatcher's logic via the builder when bypassing the SDK is convenient.
 *
 * Tools / prompts / resources arrays + the optional policy enforcer are
 * **dependency-injected** through `McpDispatchContext.registries` and
 * `McpDispatchContext.policy`. This file does NOT import the registry
 * packages, and NEVER calls `getPolicyEngine`.
 */

import { resolveIdentityForMcp } from '@mcp-toolkit/auth';
import {
  sharedLogger as logger,
  type ProviderInfo,
  type ProviderTokens,
  toProviderInfo,
} from '@mcp-toolkit/core';
import {
  buildPolicySubject,
  type PolicyEnforcer,
  type PolicySubject,
} from '@mcp-toolkit/policy';
import type { SessionRecord } from '@mcp-toolkit/storage';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { McpIconDescriptor } from './icons.ts';
import type {
  PromptDefinition,
  ResourceDefinition,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from './types.ts';
import {
  credentialPrefixFromHeaders,
  isMcpCatalogListMethod,
  logMcpUserAuditCatalogList,
} from './user-audit.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export const LATEST_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07', // Added for backwards compatibility per MCP spec
];

/** JSON-RPC error codes */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Application-defined: group policy denied */
  PermissionDenied: -32009,
} as const;

/** MCP server configuration */
export interface McpServerConfig {
  title: string;
  version: string;
  instructions?: string;
  /** Optional; same shape as MCP `Implementation.icons` */
  icons?: McpIconDescriptor[];
}

/** Session state for MCP connections */
export interface McpSessionState {
  initialized: boolean;
  clientInfo?: { name: string; version: string };
  protocolVersion?: string;
}

/** Cancellation controller registry for in-flight requests */
export type CancellationRegistry = Map<string | number, AbortController>;

/** Registries that the dispatcher iterates per request. */
export interface McpDispatchRegistries {
  tools: ToolDefinition[];
  prompts: PromptDefinition[];
  resources: ResourceDefinition[];
}

/** Context for MCP request handling */
export interface McpDispatchContext {
  sessionId: string;
  auth: ToolContext;
  config: McpServerConfig;
  registries: McpDispatchRegistries;
  /** Optional policy enforcer; off when undefined. */
  policy?: PolicyEnforcer;
  getSessionState: () => McpSessionState | undefined;
  setSessionState: (state: McpSessionState) => void;
  /** Registry for tracking in-flight requests that can be cancelled */
  cancellationRegistry?: CancellationRegistry;
  /** When true, log auth/session snapshot on catalog list methods */
  userAuditOnList?: boolean;
  /** Session row from store (Workers path); used for audit only */
  sessionRecord?: SessionRecord | null;
  /** API key header name for audit redaction */
  apiKeyHeader?: string;
}

/** JSON-RPC response */
export interface JsonRpcResult {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

function deriveSubject(ctx: McpDispatchContext): PolicySubject | undefined {
  if (!ctx.policy?.isEnforced()) return undefined;
  const id = resolveIdentityForMcp(
    ctx.sessionRecord?.identity ?? ctx.auth.identity,
    ctx.auth.provider ?? null,
  );
  return buildPolicySubject(id, ctx.policy.policy.principal_aliases);
}

/**
 * Execute a tool definition (validation + cancellation + handler dispatch).
 *
 * Mirrors the legacy `executeSharedTool` semantics but parameterized over the
 * tool object — no global registry lookup. Policy gating happens BEFORE this
 * is called; the caller is responsible for issuing the deny.
 */
async function executeTool(
  tool: ToolDefinition,
  args: unknown,
  toolCtx: ToolContext,
): Promise<ToolResult> {
  // Cancellation check before doing any work.
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

    // Per MCP spec: when outputSchema is defined, structuredContent is
    // required (unless isError is true).
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
// Method Handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleInitialize(
  params: Record<string, unknown> | undefined,
  ctx: McpDispatchContext,
): Promise<JsonRpcResult> {
  const clientInfo = params?.clientInfo as
    | { name: string; version: string }
    | undefined;
  const requestedVersion = String(params?.protocolVersion || LATEST_PROTOCOL_VERSION);

  // Negotiate protocol version
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
    ? requestedVersion
    : LATEST_PROTOCOL_VERSION;

  // Store session state
  ctx.setSessionState({
    initialized: false,
    clientInfo,
    protocolVersion,
  });

  logger.info('mcp_dispatch', {
    message: 'Initialize request',
    sessionId: ctx.sessionId,
    clientInfo,
    requestedVersion,
    negotiatedVersion: protocolVersion,
  });

  // Capabilities are derived from the live registries — only advertise what
  // we actually serve.
  const capabilities: Record<string, unknown> = {
    logging: {},
    experimental: {},
  };
  if (ctx.registries.tools.length > 0) {
    capabilities.tools = { listChanged: true };
  }
  if (ctx.registries.prompts.length > 0) {
    capabilities.prompts = { listChanged: true };
  }
  if (ctx.registries.resources.length > 0) {
    capabilities.resources = { listChanged: true, subscribe: true };
  }

  return {
    result: {
      protocolVersion,
      capabilities,
      serverInfo: {
        name: ctx.config.title,
        version: ctx.config.version,
        ...(ctx.config.icons?.length ? { icons: ctx.config.icons } : {}),
      },
      ...(ctx.config.instructions ? { instructions: ctx.config.instructions } : {}),
    },
  };
}

async function handleToolsList(ctx: McpDispatchContext): Promise<JsonRpcResult> {
  const catalog = ctx.registries.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema),
    ...(tool.outputSchema && {
      outputSchema: zodToJsonSchema(z.object(tool.outputSchema)),
    }),
    ...(tool.annotations && { annotations: tool.annotations }),
  }));

  if (!ctx.policy?.isEnforced()) {
    return { result: { tools: catalog } };
  }

  const subject = deriveSubject(ctx);
  if (!subject) return { result: { tools: catalog } };
  const tools = ctx.policy.filterTools(catalog, subject);
  return { result: { tools } };
}

async function handleToolsCall(
  params: Record<string, unknown> | undefined,
  ctx: McpDispatchContext,
  requestId?: string | number,
): Promise<JsonRpcResult> {
  const toolName = String(params?.name || '');
  const toolArgs = (params?.arguments || {}) as Record<string, unknown>;
  const meta = params?._meta as { progressToken?: string | number } | undefined;

  const tool = ctx.registries.tools.find((t) => t.name === toolName);
  if (!tool) {
    return {
      error: {
        code: JsonRpcErrorCode.MethodNotFound,
        message: `Unknown tool: ${toolName}`,
      },
    };
  }

  // Policy gate (before allocating an AbortController so we can deny cheaply).
  if (ctx.policy?.isEnforced()) {
    const subject = deriveSubject(ctx);
    if (subject && !ctx.policy.canAccessTool(toolName, subject)) {
      logger.info('mcp_policy', {
        message: 'Tool call denied by group policy',
        tool: toolName,
        sessionId: ctx.sessionId,
        principalGroups: [...subject.groupSet].sort(),
      });
      return {
        error: {
          code: JsonRpcErrorCode.PermissionDenied,
          message: 'Forbidden: insufficient group membership for this tool',
        },
      };
    }
  }

  // Create abort controller for this request (enables cancellation)
  const abortController = new AbortController();
  if (requestId !== undefined && ctx.cancellationRegistry) {
    ctx.cancellationRegistry.set(requestId, abortController);
  }

  // Build tool context with abort signal
  const toolContext: ToolContext = {
    ...ctx.auth,
    sessionId: ctx.sessionId,
    signal: abortController.signal,
    meta: {
      progressToken: meta?.progressToken,
      requestId: requestId !== undefined ? String(requestId) : undefined,
    },
  };

  logger.debug('mcp_dispatch', {
    message: 'Calling tool',
    tool: toolName,
    sessionId: ctx.sessionId,
    requestId,
    hasProviderToken: Boolean(ctx.auth.providerToken),
  });

  try {
    const result = await executeTool(tool, toolArgs, toolContext);
    const firstText =
      result.content[0]?.type === 'text' ? String(result.content[0].text) : '';
    if (
      result.isError &&
      firstText.startsWith('Forbidden:') &&
      ctx.policy?.isEnforced()
    ) {
      return {
        error: {
          code: JsonRpcErrorCode.PermissionDenied,
          message: firstText,
        },
      };
    }
    return { result };
  } catch (error) {
    // Check if this was a cancellation
    if (abortController.signal.aborted) {
      logger.info('mcp_dispatch', {
        message: 'Tool execution cancelled',
        tool: toolName,
        requestId,
      });
      return {
        error: {
          code: JsonRpcErrorCode.InternalError,
          message: 'Request was cancelled',
        },
      };
    }

    logger.error('mcp_dispatch', {
      message: 'Tool execution failed',
      tool: toolName,
      error: (error as Error).message,
    });
    return {
      error: {
        code: JsonRpcErrorCode.InternalError,
        message: `Tool execution failed: ${(error as Error).message}`,
      },
    };
  } finally {
    // Clean up cancellation registry
    if (requestId !== undefined && ctx.cancellationRegistry) {
      ctx.cancellationRegistry.delete(requestId);
    }
  }
}

async function handleResourcesList(ctx: McpDispatchContext): Promise<JsonRpcResult> {
  const catalog = ctx.registries.resources.map((r) => ({
    uri: r.uri,
    name: r.name,
    title: r.name,
    description: r.description,
    mimeType: r.mimeType,
  }));

  if (!ctx.policy?.isEnforced()) {
    return { result: { resources: catalog } };
  }

  const subject = deriveSubject(ctx);
  if (!subject) return { result: { resources: catalog } };
  const resources = ctx.policy.filterResources(catalog, subject);
  return { result: { resources } };
}

async function handleResourcesTemplatesList(): Promise<JsonRpcResult> {
  return { result: { resourceTemplates: [] } };
}

async function handlePromptsList(ctx: McpDispatchContext): Promise<JsonRpcResult> {
  const catalog = ctx.registries.prompts.map((p) => ({
    name: p.name,
    title: p.title,
    description: p.description,
    ...(p.arguments ? { arguments: p.arguments } : {}),
  }));

  if (!ctx.policy?.isEnforced()) {
    return { result: { prompts: catalog } };
  }

  const subject = deriveSubject(ctx);
  if (!subject) return { result: { prompts: catalog } };
  const prompts = ctx.policy.filterPrompts(catalog, subject);
  return { result: { prompts } };
}

async function handlePing(): Promise<JsonRpcResult> {
  return { result: {} };
}

/** Current log level (can be changed via logging/setLevel) */
let currentLogLevel:
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency' = 'info';

async function handleLoggingSetLevel(
  params: Record<string, unknown> | undefined,
): Promise<JsonRpcResult> {
  const level = params?.level as string | undefined;

  const validLevels = [
    'debug',
    'info',
    'notice',
    'warning',
    'error',
    'critical',
    'alert',
    'emergency',
  ];

  if (!level || !validLevels.includes(level)) {
    return {
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        message: `Invalid log level. Must be one of: ${validLevels.join(', ')}`,
      },
    };
  }

  currentLogLevel = level as typeof currentLogLevel;

  logger.info('mcp_dispatch', {
    message: 'Log level changed',
    level: currentLogLevel,
  });

  return { result: {} };
}

/**
 * Get the current log level set by the client.
 */
export function getLogLevel(): string {
  return currentLogLevel;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a `provider` snapshot to camelCase for tool handlers regardless
 * of which strategy populated it. Convenience for transports building a
 * `ToolContext` from a stored `RequestContext`.
 */
export function providerToToolShape(
  provider?: ProviderTokens | ProviderInfo | null,
): ProviderInfo | undefined {
  if (!provider) return undefined;
  if ('access_token' in provider) {
    return toProviderInfo(provider);
  }
  return provider;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Dispatcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatch an MCP JSON-RPC method.
 *
 * @param method - The JSON-RPC method name
 * @param params - The method parameters
 * @param ctx - Dispatch context with session, auth, and registry info
 * @param requestId - Optional request ID for cancellation tracking
 * @returns JSON-RPC result or error
 */
export async function dispatchMcpMethod(
  method: string | undefined,
  params: Record<string, unknown> | undefined,
  ctx: McpDispatchContext,
  requestId?: string | number,
): Promise<JsonRpcResult> {
  if (!method) {
    return {
      error: { code: JsonRpcErrorCode.InvalidRequest, message: 'Missing method' },
    };
  }

  if (ctx.userAuditOnList && isMcpCatalogListMethod(method)) {
    const header = ctx.apiKeyHeader ?? 'x-api-key';
    logMcpUserAuditCatalogList({
      methods: [method],
      sessionId: ctx.sessionId,
      requestId,
      authStrategy: ctx.auth.authStrategy,
      credentialPrefix: credentialPrefixFromHeaders(ctx.auth.resolvedHeaders, header),
      provider: ctx.auth.provider,
      sessionRecord: ctx.sessionRecord ?? null,
      policy: ctx.policy,
      tools: ctx.registries.tools,
      prompts: ctx.registries.prompts,
      resources: ctx.registries.resources,
    });
  }

  switch (method) {
    case 'initialize':
      return handleInitialize(params, ctx);

    case 'tools/list':
      return handleToolsList(ctx);

    case 'tools/call':
      return handleToolsCall(params, ctx, requestId);

    case 'resources/list':
      return handleResourcesList(ctx);

    case 'resources/templates/list':
      return handleResourcesTemplatesList();

    case 'prompts/list':
      return handlePromptsList(ctx);

    case 'ping':
      return handlePing();

    case 'logging/setLevel':
      return handleLoggingSetLevel(params);

    default:
      logger.debug('mcp_dispatch', { message: 'Unknown method', method });
      return {
        error: {
          code: JsonRpcErrorCode.MethodNotFound,
          message: `Method not found: ${method}`,
        },
      };
  }
}

/** Parameters for notifications/cancelled */
export interface CancelledNotificationParams {
  requestId: string | number;
  reason?: string;
}

/**
 * Handle MCP notification (no response expected).
 *
 * @param method - The notification method name
 * @param params - Notification parameters
 * @param ctx - Dispatch context
 * @returns true if handled, false if unknown
 */
export function handleMcpNotification(
  method: string,
  params: Record<string, unknown> | undefined,
  ctx: McpDispatchContext,
): boolean {
  if (method === 'notifications/initialized') {
    const session = ctx.getSessionState();
    if (session) {
      ctx.setSessionState({ ...session, initialized: true });
    }
    logger.info('mcp_dispatch', {
      message: 'Client initialized',
      sessionId: ctx.sessionId,
    });
    return true;
  }

  if (method === 'notifications/cancelled') {
    const cancelParams = params as CancelledNotificationParams | undefined;
    const requestId = cancelParams?.requestId;

    if (requestId !== undefined && ctx.cancellationRegistry) {
      const controller = ctx.cancellationRegistry.get(requestId);
      if (controller) {
        logger.info('mcp_dispatch', {
          message: 'Cancelling request',
          requestId,
          reason: cancelParams?.reason,
          sessionId: ctx.sessionId,
        });
        controller.abort(cancelParams?.reason ?? 'Client requested cancellation');
        return true;
      }
      logger.debug('mcp_dispatch', {
        message: 'Cancellation request for unknown requestId',
        requestId,
        sessionId: ctx.sessionId,
      });
    }
    return true; // Always acknowledge cancellation notifications
  }

  logger.debug('mcp_dispatch', {
    message: 'Unhandled notification',
    method,
    sessionId: ctx.sessionId,
  });
  return false;
}
