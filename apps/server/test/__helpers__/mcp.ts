/**
 * Test helpers for issuing JSON-RPC over the MCP `/mcp` endpoint. Both Node
 * Hono and Workers handlers expose `fetch(req: Request) => Promise<Response>`,
 * so a single set of helpers serves both runtimes.
 */

export interface FetchHandler {
  fetch: (req: Request) => Promise<Response>;
}

export const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  },
} as const;

/** Build a `Request` for a JSON-RPC POST to `/mcp` (or any URL). */
export function jsonReq(
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Read a JSON-or-SSE response body. The MCP transport returns
 * `text/event-stream`; the JSON-RPC payload sits in the `data:` line. This
 * helper handles both formats so tests don't have to.
 */
export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  // Strip SSE framing if present.
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  const payload = dataLine ? dataLine.slice(6) : text;
  try {
    return JSON.parse(payload);
  } catch {
    return text;
  }
}

/**
 * Issue `initialize` and return the session id from the response headers.
 * Throws if the handler doesn't return one — tests should expect that to
 * mean either auth was rejected or the request was malformed.
 */
export async function initializeSession(
  handler: FetchHandler,
  extraHeaders: Record<string, string> = {},
  url = 'http://localhost/mcp',
): Promise<{ sessionId: string; status: number }> {
  const res = await handler.fetch(jsonReq(url, INIT_BODY, extraHeaders));
  const sessionId = res.headers.get('mcp-session-id') ?? '';
  return { sessionId, status: res.status };
}

/**
 * Issue an arbitrary JSON-RPC method against the MCP endpoint. The session
 * id is threaded as `mcp-session-id`; pass any extra auth headers (e.g.
 * `x-api-key`, `authorization`) through `extraHeaders`.
 */
export async function callMcp(
  handler: FetchHandler,
  sessionId: string,
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
  url = 'http://localhost/mcp',
): Promise<{ status: number; body: JsonRpcResponse }> {
  const res = await handler.fetch(
    jsonReq(
      url,
      { jsonrpc: '2.0', id: Date.now(), method, params },
      { 'mcp-session-id': sessionId, ...extraHeaders },
    ),
  );
  return { status: res.status, body: (await readJson(res)) as JsonRpcResponse };
}

export interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
