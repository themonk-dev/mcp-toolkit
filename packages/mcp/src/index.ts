/**
 * `@mcp-toolkit/mcp` — pluggable MCP server orchestration layer.
 *
 * Exports the contract types every registry / transport package depends on,
 * the `buildServer` composer, the runtime-agnostic dispatcher, and the
 * per-request context registry.
 *
 * Subpath-exports policy: the package root re-exports the entire
 * runtime-agnostic surface (builder, dispatcher, registry, env, etc.).
 * Subpath entries in `package.json#exports` are reserved exclusively for
 * modules that consumers MUST import by path — currently the runtime-pinned
 * ALS shims that branch Node vs Workers:
 *   - `@mcp-toolkit/mcp/runtime/als-node`     (Node only; pulls in node:async_hooks)
 *   - `@mcp-toolkit/mcp/runtime/als-workers`  (Workers stub)
 * Do not add new subpath exports unless the module is runtime-pinned or
 * otherwise hostile to bundle-time tree-shaking from the root barrel.
 */

export {
  type BuildServerOptions,
  buildServer,
} from './builder.ts';
// `contextRegistry`, `startContextCleanup`, `stopContextCleanup` are intentionally
// NOT re-exported — they are package-internal (used by the dispatcher and its
// tests via relative imports). Adding them to the barrel would invite external
// consumers to call the cleanup primitives directly, bypassing `buildServer`.
export { buildCapabilities } from './capabilities.ts';
export {
  assertPromptAllowed,
  assertResourceAllowed,
} from './catalog-policy.ts';
export {
  type CancellationRegistry,
  type CancelledNotificationParams,
  dispatchMcpMethod,
  getLogLevel,
  handleMcpNotification,
  JsonRpcErrorCode,
  type JsonRpcResult,
  LATEST_PROTOCOL_VERSION,
  type McpDispatchContext,
  type McpDispatchRegistries,
  type McpServerConfig,
  type McpSessionState,
  providerToToolShape,
  SUPPORTED_PROTOCOL_VERSIONS,
} from './dispatcher.ts';
export {
  buildMcpIconsFromConfig,
  type McpIconDescriptor,
  type McpIconEnv,
} from './icons.ts';
// `MCP_AUDIT_PROMPT_NAMES` and `MCP_AUDIT_RESOURCE_URIS` are intentionally NOT
// re-exported — they are static test fixtures inlined into the audit-sink
// catalog-list behaviour and have no external consumers.
export {
  buildUnauthorizedChallenge,
  isLoopbackOrigin,
  type UnauthorizedChallenge,
  validateOrigin,
  validateProtocolVersion,
} from './security.ts';
export {
  getLowLevelServer,
  getServerWithInternals,
  isJsonRpcError,
  JSON_RPC_METHOD_NOT_FOUND,
  type JsonRpcError,
} from './server-internals.ts';
export * from './types.ts';
export {
  type AuditCatalogListEvent,
  type AuditEvent,
  type AuditSubject,
  type AuditToolCallEvent,
} from './audit-event.ts';
export { type AuditSink } from './audit-sink.ts';
export { ConsoleAuditSink } from './audit-sink-console.ts';
export { type AuditConfig, auditConfigSchema } from './audit-config.ts';
// `MCP_CATALOG_LIST_METHODS` and `redactSecretPrefix` are NOT re-exported — they
// are internal implementation details of `buildCatalogListEvent`.
export {
  buildCatalogListEvent,
  credentialPrefixFromHeaders,
  isMcpCatalogListMethod,
} from './user-audit.ts';
