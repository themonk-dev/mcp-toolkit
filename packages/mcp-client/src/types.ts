/**
 * Public types for `@mcp-toolkit/mcp-client`.
 *
 * Kept dependency-free so consumers can import these without pulling the
 * runtime client (handy for proxy-tool wiring and tests).
 */

/**
 * Pure `Request → Request` transform applied to every outbound call. Each
 * downstream-MCP credential variant (api-key, bearer, …) is realized as one
 * `AuthInject`; the client never inspects the credential itself.
 */
export type AuthInject = (req: Request) => Request;

export interface OutboundClientOptions {
  /** Advertised to the downstream server via `initialize.params.clientInfo`. */
  clientInfo: { name: string; version: string };
  /** Default protocol version requested at `initialize`. Defaults to 2025-06-18. */
  protocolVersion?: string;
}

export interface OutboundClientDeps {
  /** Inject a stub for testing; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export interface InitializeOptions {
  /** Stable id used in error messages and as the upstream proxy tool name. */
  serverId: string;
  /** Downstream MCP endpoint URL (streamable-HTTP). */
  url: string;
  authInject: AuthInject;
}

/**
 * Live session against a single downstream server. Carries the negotiated
 * protocol version and (when issued by the server) the `Mcp-Session-Id`
 * echoed on subsequent calls.
 */
export interface OutboundSession {
  serverId: string;
  url: string;
  sessionId?: string;
  protocolVersion: string;
  authInject: AuthInject;
}

/** Subset of the downstream `tools/list` entry that the proxy factory needs. */
export interface DownstreamTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Pass-through shape of a downstream `tools/call` result. */
export interface DownstreamToolResult {
  content: Array<{ type: string; [k: string]: unknown }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}
