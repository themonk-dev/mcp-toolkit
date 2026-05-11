/**
 * `@mcp-toolkit/mcp-client` — outbound MCP client.
 *
 * Speaks streamable-HTTP JSON-RPC against a downstream MCP server. Pure
 * `fetch`, no Node-only dependencies — runs identically on Node and
 * Cloudflare Workers. Auth is injected per-request via a caller-supplied
 * `AuthInject` transform on the outbound `Request`.
 */

export { OutboundMcpClient } from './client.ts';
export {
  DownstreamAuthError,
  DownstreamProtocolError,
  DownstreamTransportError,
} from './errors.ts';
export type {
  AuthInject,
  DownstreamTool,
  DownstreamToolResult,
  InitializeOptions,
  OutboundClientOptions,
  OutboundSession,
} from './types.ts';
