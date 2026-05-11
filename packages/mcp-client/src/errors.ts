/**
 * Typed error hierarchy raised by `OutboundMcpClient`.
 *
 * Three disjoint categories that callers (e.g. the proxy-tool factory)
 * surface differently:
 *
 * - `DownstreamAuthError` (401/403) → the configured credential was rejected
 *   by the downstream server; surface to the upstream as an MCP `isError`
 *   with a "rejected credential" message and, in future iterations, mark
 *   the credential as needing reauthentication.
 * - `DownstreamTransportError` → network failure, non-2xx other than 401/403,
 *   unparseable body, or unsupported response framing (e.g. SSE in v1).
 * - `DownstreamProtocolError` → the downstream returned a valid JSON-RPC
 *   envelope with an `error` field. The `code` is the JSON-RPC error code.
 */

export class DownstreamAuthError extends Error {
  readonly name = 'DownstreamAuthError';
  readonly serverId: string;
  readonly status: 401 | 403;
  readonly body: string;

  constructor(serverId: string, status: 401 | 403, body: string) {
    super(`Downstream ${serverId} rejected credential (${status})`);
    this.serverId = serverId;
    this.status = status;
    this.body = body;
  }
}

export class DownstreamTransportError extends Error {
  readonly name = 'DownstreamTransportError';
  readonly serverId: string;
  readonly cause?: unknown;

  constructor(serverId: string, message: string, cause?: unknown) {
    super(`Downstream ${serverId}: ${message}`);
    this.serverId = serverId;
    this.cause = cause;
  }
}

export class DownstreamProtocolError extends Error {
  readonly name = 'DownstreamProtocolError';
  readonly serverId: string;
  readonly code: number;
  readonly data?: unknown;

  constructor(serverId: string, code: number, message: string, data?: unknown) {
    super(`Downstream ${serverId} protocol error (${code}): ${message}`);
    this.serverId = serverId;
    this.code = code;
    this.data = data;
  }
}
