/**
 * `OutboundMcpClient` — outbound JSON-RPC over MCP streamable-HTTP.
 *
 * Three methods exposed: `initialize`, `listTools`, `callTool`. Each call
 * builds a `Request`, hands it to the caller-supplied `AuthInject` for header
 * stamping, then submits via the injected `fetch`. Responses are required to
 * be `application/json` in v1 — `text/event-stream` is rejected with a clear
 * `DownstreamTransportError`. Errors are surfaced through a typed hierarchy
 * (`DownstreamAuthError`, `DownstreamTransportError`, `DownstreamProtocolError`)
 * so callers can branch on category without string-matching messages.
 *
 * No retries, no reconnect, no session-expiry handling: the proxy-tool
 * factory owns lifecycle and evicts sessions on transport failure.
 */

import {
  DownstreamAuthError,
  DownstreamProtocolError,
  DownstreamTransportError,
} from './errors.ts';
import type {
  DownstreamTool,
  DownstreamToolResult,
  InitializeOptions,
  OutboundClientDeps,
  OutboundClientOptions,
  OutboundSession,
} from './types.ts';

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const ACCEPT_HEADER = 'application/json, text/event-stream';

interface JsonRpcEnvelope {
  jsonrpc?: string;
  id?: number | string | null;
  /** Present on notifications and server-initiated requests; absent on responses. */
  method?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function isResponseEnvelope(env: JsonRpcEnvelope): boolean {
  // A JSON-RPC response carries either `result` or `error` and no `method`.
  // Notifications have `method` but no `id`; server-initiated requests have
  // both `id` and `method`. We drop both — v1 has no forwarding channel back
  // to the upstream client.
  return env.method === undefined && (env.result !== undefined || env.error !== undefined);
}

export class OutboundMcpClient {
  private readonly clientInfo: { name: string; version: string };
  private readonly protocolVersion: string;
  private readonly fetchFn: typeof fetch;
  private idCounter = 0;

  constructor(opts: OutboundClientOptions, deps: OutboundClientDeps = {}) {
    this.clientInfo = opts.clientInfo;
    this.protocolVersion = opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.fetchFn = deps.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async initialize(opts: InitializeOptions): Promise<OutboundSession> {
    const session: OutboundSession = {
      serverId: opts.serverId,
      url: opts.url,
      protocolVersion: this.protocolVersion,
      authInject: opts.authInject,
    };

    const { envelope, response } = await this.send(
      session,
      this.buildRequestBody('initialize', {
        protocolVersion: this.protocolVersion,
        clientInfo: this.clientInfo,
        capabilities: {},
      }),
    );

    const negotiated = (envelope.result as { protocolVersion?: string } | undefined)
      ?.protocolVersion;
    if (typeof negotiated === 'string') session.protocolVersion = negotiated;

    const sessionId = response.headers.get('Mcp-Session-Id');
    if (sessionId) session.sessionId = sessionId;

    await this.sendNotification(session, 'notifications/initialized');

    return session;
  }

  async listTools(session: OutboundSession): Promise<DownstreamTool[]> {
    const { envelope } = await this.send(session, this.buildRequestBody('tools/list'));
    const result = envelope.result as { tools?: DownstreamTool[] } | undefined;
    return result?.tools ?? [];
  }

  async callTool(
    session: OutboundSession,
    action: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<DownstreamToolResult> {
    const { envelope } = await this.send(
      session,
      this.buildRequestBody('tools/call', { name: action, arguments: args ?? {} }),
      signal,
    );
    return envelope.result as DownstreamToolResult;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────────

  private buildRequestBody(method: string, params?: unknown): string {
    const id = ++this.idCounter;
    return JSON.stringify(
      params === undefined
        ? { jsonrpc: '2.0', id, method }
        : { jsonrpc: '2.0', id, method, params },
    );
  }

  private buildRequest(
    session: OutboundSession,
    body: string,
    signal?: AbortSignal,
  ): Request {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: ACCEPT_HEADER,
      'MCP-Protocol-Version': session.protocolVersion,
    };
    if (session.sessionId) headers['Mcp-Session-Id'] = session.sessionId;
    const base = new Request(session.url, {
      method: 'POST',
      headers,
      body,
      signal,
    });
    return session.authInject(base);
  }

  private async send(
    session: OutboundSession,
    body: string,
    signal?: AbortSignal,
  ): Promise<{ envelope: JsonRpcEnvelope; response: Response }> {
    const request = this.buildRequest(session, body, signal);
    const response = await this.fetchOrThrow(session, request);

    if (response.status === 401 || response.status === 403) {
      const text = await safeText(response);
      throw new DownstreamAuthError(session.serverId, response.status, text);
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new DownstreamTransportError(
        session.serverId,
        `HTTP ${response.status}: ${text.slice(0, 256)}`,
      );
    }

    const contentType = response.headers.get('Content-Type') ?? '';
    const envelope = contentType.includes('text/event-stream')
      ? await parseSseEnvelope(session.serverId, response)
      : await parseJsonEnvelope(session.serverId, response);

    if (envelope.error) {
      throw new DownstreamProtocolError(
        session.serverId,
        envelope.error.code,
        envelope.error.message,
        envelope.error.data,
      );
    }

    return { envelope, response };
  }

  private async sendNotification(
    session: OutboundSession,
    method: string,
    params?: unknown,
  ): Promise<void> {
    const body = JSON.stringify(
      params === undefined
        ? { jsonrpc: '2.0', method }
        : { jsonrpc: '2.0', method, params },
    );
    const request = this.buildRequest(session, body);
    const response = await this.fetchOrThrow(session, request);
    if (response.status === 401 || response.status === 403) {
      const text = await safeText(response);
      throw new DownstreamAuthError(
        session.serverId,
        response.status as 401 | 403,
        text,
      );
    }
    // Notifications: any 2xx is acceptable; body is ignored.
  }

  private async fetchOrThrow(
    session: OutboundSession,
    request: Request,
  ): Promise<Response> {
    try {
      return await this.fetchFn(request);
    } catch (cause) {
      throw new DownstreamTransportError(
        session.serverId,
        `fetch failed: ${(cause as Error)?.message ?? String(cause)}`,
        cause,
      );
    }
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function parseJsonEnvelope(
  serverId: string,
  response: Response,
): Promise<JsonRpcEnvelope> {
  try {
    return (await response.json()) as JsonRpcEnvelope;
  } catch (cause) {
    throw new DownstreamTransportError(
      serverId,
      `unparseable response body: ${(cause as Error).message}`,
      cause,
    );
  }
}

/**
 * Consume a `text/event-stream` response body until the first JSON-RPC
 * response envelope (one carrying `result` or `error`), then cancel the
 * stream. Notifications (envelopes with `method` but no `id`) and
 * server-initiated requests (`id` + `method`) are skipped — v1 has no
 * forwarding channel back to the upstream client, so we drop them.
 *
 * If the stream closes without a response envelope, throw a transport
 * error so the caller (proxy factory) can evict the session.
 *
 * SSE framing per the WHATWG spec: events are separated by a blank line,
 * fields by `\n`, multi-line `data:` joined with `\n`, lines starting with
 * `:` are comments. The MCP streamable-HTTP spec uses `event: message` for
 * response payloads but the field is optional (default event name is
 * "message"); we don't filter on it.
 *
 * Each outbound call has at most one in-flight response on its own stream,
 * so we deliberately don't match on JSON-RPC `id` — the first response
 * envelope on this stream IS our response.
 */
async function parseSseEnvelope(
  serverId: string,
  response: Response,
): Promise<JsonRpcEnvelope> {
  if (!response.body) {
    throw new DownstreamTransportError(
      serverId,
      'SSE response had no body to read',
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const eventBoundary = /\r?\n\r?\n/;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });

      // Drain every complete event currently in the buffer.
      let match = eventBoundary.exec(buffer);
      while (match) {
        const eventText = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const envelope = decodeSseEvent(serverId, eventText);
        if (envelope && isResponseEnvelope(envelope)) {
          return envelope;
        }
        match = eventBoundary.exec(buffer);
      }

      if (done) break;
    }
    throw new DownstreamTransportError(
      serverId,
      'SSE stream ended without a JSON-RPC response envelope',
    );
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Best-effort: the upstream may have already closed the stream.
    }
  }
}

function decodeSseEvent(serverId: string, eventText: string): JsonRpcEnvelope | null {
  const dataLines: string[] = [];
  for (const rawLine of eventText.split(/\r?\n/)) {
    if (rawLine === '' || rawLine.startsWith(':')) continue;
    if (rawLine.startsWith('data:')) {
      // Per SSE spec: a single leading space after `data:` is stripped.
      const value = rawLine.slice(5);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
    // Other fields (event, id, retry) carry no JSON-RPC meaning for us.
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join('\n');
  try {
    return JSON.parse(payload) as JsonRpcEnvelope;
  } catch (cause) {
    throw new DownstreamTransportError(
      serverId,
      `unparseable SSE event data: ${(cause as Error).message}`,
      cause,
    );
  }
}
