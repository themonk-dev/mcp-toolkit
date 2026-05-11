/**
 * Contract types owned by `@mcp-toolkit/mcp`.
 *
 * Downstream registry packages (`@mcp-toolkit/tools`, `@mcp-toolkit/prompts`,
 * `@mcp-toolkit/resources`) depend on these types — never the reverse. Keep this
 * surface runtime-agnostic: no `node:*` imports, no SDK imports.
 */

import type {
  AuthStrategy as AuthStrategyName,
  ProviderInfo,
  SessionIdentity,
} from '@mcp-toolkit/core';
import type { ZodObject, ZodRawShape, z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Tool
// ─────────────────────────────────────────────────────────────────────────────

export type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; uri: string; mimeType?: string; text?: string };

export interface ToolResult {
  content: ToolContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/**
 * Provider snapshot attached to a `ToolContext`.
 *
 * Strategies populate this in either the storage shape (snake_case
 * `ProviderTokens`) or the tool-handler shape (camelCase `ProviderInfo`).
 * The dispatcher / builder normalize to camelCase before invoking handlers.
 */
export type ToolProvider = ProviderInfo;

/**
 * Context passed to every tool handler. Auth is **resolved** — the strategy
 * has already verified the request and produced these fields. Policy is NOT
 * here; gating happens in the dispatcher / builder before the handler runs.
 */
export interface ToolContext {
  /** Current MCP session ID. */
  sessionId: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Request metadata from the JSON-RPC envelope. */
  meta?: { progressToken?: string | number; requestId?: string };

  /** Strategy that authorized this request (e.g. `oidc`, `jwt`, `apikey`, `none`). */
  authStrategy?: AuthStrategyName;
  /** Convenience: provider access token, if any. */
  providerToken?: string;
  /** Full provider snapshot in tool-handler form (camelCase). */
  provider?: ToolProvider;
  /** Headers ready to forward to upstream APIs. */
  resolvedHeaders?: Record<string, string>;
  /** Resolved identity claims for policy / personalization. */
  identity?: SessionIdentity;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition<TShape extends ZodRawShape = ZodRawShape> {
  name: string;
  title?: string;
  description: string;
  inputSchema: ZodObject<TShape>;
  outputSchema?: ZodRawShape;
  handler: (args: z.infer<ZodObject<TShape>>, ctx: ToolContext) => Promise<ToolResult>;
  annotations?: ToolAnnotations;
}

/** Helper for type-safe tool definitions. */
export function defineTool<T extends ZodRawShape>(
  d: ToolDefinition<T>,
): ToolDefinition<T> {
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────────

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: string; [k: string]: unknown };
}

export interface PromptResult {
  messages: PromptMessage[];
}

export interface PromptDefinition {
  name: string;
  title?: string;
  description: string;
  /**
   * Optional zod-style argument shape for the SDK's `registerPrompt` call.
   * Use this when the registry should expose validated arguments.
   */
  argsSchema?: ZodRawShape;
  /**
   * Advertise-only argument descriptors for catalogs that don't drive a
   * zod schema (e.g. server templates).
   */
  arguments?: PromptArgument[];
  handler: (args: Record<string, unknown>) => Promise<PromptResult> | PromptResult;
}

export function definePrompt(d: PromptDefinition): PromptDefinition {
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource
// ─────────────────────────────────────────────────────────────────────────────

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface ResourceDefinition {
  name: string;
  uri: string;
  description?: string;
  mimeType?: string;
  handler: () =>
    | Promise<{ contents: ResourceContent[] }>
    | { contents: ResourceContent[] };
}

export function defineResource(d: ResourceDefinition): ResourceDefinition {
  return d;
}
