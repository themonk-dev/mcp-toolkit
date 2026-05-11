import { describe, expect, it } from 'bun:test';
import { OutboundMcpClient } from './client.ts';
import {
  DownstreamAuthError,
  DownstreamProtocolError,
  DownstreamTransportError,
} from './errors.ts';
import type { AuthInject, OutboundSession } from './types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

interface Recorded {
  calls: Request[];
  fetch: typeof fetch;
}

/**
 * Build a stub `fetch` that records each outbound `Request` and returns
 * responses from a FIFO queue. Throwing a value in the queue causes the
 * matching call to reject with it (used to simulate network errors).
 *
 * The `as unknown as typeof fetch` cast bridges the Bun/undici Request type
 * mismatch — at runtime they're identical Web Fetch APIs, but the two type
 * sources disagree on `Headers` shape.
 */
function recordingFetch(responses: Array<Response | Error>): Recorded {
  const calls: Request[] = [];
  const queue = [...responses];
  const fn = (async (input: Request) => {
    calls.push(input.clone() as unknown as Request);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`recordingFetch: no response queued for call ${calls.length}`);
    }
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { calls, fetch: fn };
}

function jsonResponse(
  body: unknown,
  init: { status?: number; sessionId?: string; headers?: Record<string, string> } = {},
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json',
    ...(init.headers ?? {}),
  });
  if (init.sessionId) headers.set('Mcp-Session-Id', init.sessionId);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

const identityAuth: AuthInject = (req) => req;

const clientOpts = {
  clientInfo: { name: 'gateway', version: '1.0.0' },
};

// ─────────────────────────────────────────────────────────────────────────────
// initialize
// ─────────────────────────────────────────────────────────────────────────────

describe('mcp-client/client/initialize', () => {
  it('sends a JSON-RPC initialize POST and returns a session bearing the negotiated protocol version and Mcp-Session-Id', async () => {
    const rec = recordingFetch([
      jsonResponse(
        {
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2025-06-18',
            serverInfo: { name: 'downstream', version: '1.0' },
            capabilities: {},
          },
        },
        { sessionId: 'sess-abc' },
      ),
      new Response(null, { status: 202 }),
    ]);
    const client = new OutboundMcpClient(clientOpts, { fetch: rec.fetch });

    const session = await client.initialize({
      serverId: 'github',
      url: 'https://example.com/mcp',
      authInject: identityAuth,
    });

    expect(session.serverId).toBe('github');
    expect(session.url).toBe('https://example.com/mcp');
    expect(session.sessionId).toBe('sess-abc');
    expect(session.protocolVersion).toBe('2025-06-18');

    expect(rec.calls.length).toBe(2);
    expect(rec.calls[0].method).toBe('POST');
    expect(rec.calls[0].url).toBe('https://example.com/mcp');
    expect(rec.calls[0].headers.get('Content-Type')).toBe('application/json');
    expect(rec.calls[0].headers.get('Accept')).toContain('application/json');

    const sentBody = (await rec.calls[0].json()) as {
      method: string;
      params: { protocolVersion: string; clientInfo: unknown };
    };
    expect(sentBody.method).toBe('initialize');
    expect(sentBody.params.clientInfo).toEqual(clientOpts.clientInfo);
    expect(sentBody.params.protocolVersion).toBeDefined();
  });

  it('sends notifications/initialized as a second call with the session id', async () => {
    const rec = recordingFetch([
      jsonResponse(
        { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } },
        { sessionId: 'sess-xyz' },
      ),
      new Response(null, { status: 202 }),
    ]);
    const client = new OutboundMcpClient(clientOpts, { fetch: rec.fetch });

    await client.initialize({
      serverId: 'linear',
      url: 'https://example.com/mcp',
      authInject: identityAuth,
    });

    expect(rec.calls.length).toBe(2);
    expect(rec.calls[1].headers.get('Mcp-Session-Id')).toBe('sess-xyz');
    const noteBody = (await rec.calls[1].json()) as { method: string; id?: unknown };
    expect(noteBody.method).toBe('notifications/initialized');
    expect(noteBody.id).toBeUndefined();
  });

  it('applies authInject to outbound requests', async () => {
    const rec = recordingFetch([
      jsonResponse(
        { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } },
        { sessionId: 's1' },
      ),
      new Response(null, { status: 202 }),
    ]);
    const client = new OutboundMcpClient(clientOpts, { fetch: rec.fetch });

    const stampAuth: AuthInject = (req) => {
      const h = new Headers(req.headers);
      h.set('Authorization', 'Bearer test-token');
      return new Request(req, { headers: h });
    };

    await client.initialize({
      serverId: 'github',
      url: 'https://example.com/mcp',
      authInject: stampAuth,
    });

    expect(rec.calls[0].headers.get('Authorization')).toBe('Bearer test-token');
    expect(rec.calls[1].headers.get('Authorization')).toBe('Bearer test-token');
  });

  it('raises DownstreamAuthError on HTTP 401, carrying the response body', async () => {
    const rec = recordingFetch([new Response('token expired', { status: 401 })]);
    const client = new OutboundMcpClient(clientOpts, { fetch: rec.fetch });

    const promise = client.initialize({
      serverId: 'github',
      url: 'https://example.com/mcp',
      authInject: identityAuth,
    });

    await expect(promise).rejects.toBeInstanceOf(DownstreamAuthError);
    try {
      await promise;
    } catch (err) {
      const e = err as DownstreamAuthError;
      expect(e.status).toBe(401);
      expect(e.serverId).toBe('github');
      expect(e.body).toBe('token expired');
    }
  });

  it('raises DownstreamAuthError on HTTP 403', async () => {
    const rec = recordingFetch([new Response('forbidden', { status: 403 })]);
    const client = new OutboundMcpClient(clientOpts, { fetch: rec.fetch });

    const promise = client.initialize({
      serverId: 'linear',
      url: 'https://example.com/mcp',
      authInject: identityAuth,
    });

    await expect(promise).rejects.toBeInstanceOf(DownstreamAuthError);
  });

  it('parses a text/event-stream initialize response and extracts the JSON-RPC result', async () => {
    const sseBody =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}\n' +
      '\n';
    const rec = recordingFetch([
      new Response(sseBody, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Mcp-Session-Id': 'sse-sess-1',
        },
      }),
      new Response(null, { status: 202 }),
    ]);
    const client = new OutboundMcpClient(clientOpts, { fetch: rec.fetch });

    const session = await client.initialize({
      serverId: 'github',
      url: 'https://example.com/mcp',
      authInject: identityAuth,
    });

    expect(session.sessionId).toBe('sse-sess-1');
    expect(session.protocolVersion).toBe('2025-06-18');
  });

  it('raises DownstreamTransportError on non-2xx other than 401/403', async () => {
    const rec = recordingFetch([new Response('boom', { status: 500 })]);
    const client = new OutboundMcpClient(clientOpts, { fetch: rec.fetch });

    await expect(
      client.initialize({
        serverId: 'github',
        url: 'https://example.com/mcp',
        authInject: identityAuth,
      }),
    ).rejects.toBeInstanceOf(DownstreamTransportError);
  });

  it('raises DownstreamProtocolError when the JSON-RPC envelope returns an error', async () => {
    const rec = recordingFetch([
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32603, message: 'internal error', data: { hint: 'x' } },
      }),
    ]);
    const client = new OutboundMcpClient(clientOpts, { fetch: rec.fetch });

    const promise = client.initialize({
      serverId: 'github',
      url: 'https://example.com/mcp',
      authInject: identityAuth,
    });

    await expect(promise).rejects.toBeInstanceOf(DownstreamProtocolError);
    try {
      await promise;
    } catch (err) {
      const e = err as DownstreamProtocolError;
      expect(e.code).toBe(-32603);
      expect(e.data).toEqual({ hint: 'x' });
    }
  });

  it('raises DownstreamTransportError when fetch itself throws', async () => {
    const rec = recordingFetch([new TypeError('fetch failed: ECONNREFUSED')]);
    const client = new OutboundMcpClient(clientOpts, { fetch: rec.fetch });

    const promise = client.initialize({
      serverId: 'github',
      url: 'https://example.com/mcp',
      authInject: identityAuth,
    });

    await expect(promise).rejects.toBeInstanceOf(DownstreamTransportError);
    try {
      await promise;
    } catch (err) {
      const e = err as DownstreamTransportError;
      expect(e.cause).toBeInstanceOf(TypeError);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listTools
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a client that has already completed `initialize` and return both the
 * live session and a fresh recording fetch for subsequent calls. Keeps each
 * test focused on the method under test.
 */
async function initializedClient(opts: {
  serverId?: string;
  sessionId?: string;
  responses: Array<Response | Error>;
}): Promise<{ client: OutboundMcpClient; session: OutboundSession; rec: Recorded }> {
  const initRec = recordingFetch([
    jsonResponse(
      {
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-06-18' },
      },
      { sessionId: opts.sessionId ?? 'sess-default' },
    ),
    new Response(null, { status: 202 }),
  ]);
  const client = new OutboundMcpClient(clientOpts, { fetch: initRec.fetch });
  const session = await client.initialize({
    serverId: opts.serverId ?? 'github',
    url: 'https://example.com/mcp',
    authInject: identityAuth,
  });

  // Swap the fetch for the new recording; bind it on the existing client
  // by creating a fresh instance is cleaner but here we just track follow-up
  // calls through a closure.
  const rec = recordingFetch(opts.responses);
  // The constructor captures fetchFn; for follow-up calls reuse the same
  // client by creating a sibling with the new fetch.
  const followUpClient = new OutboundMcpClient(clientOpts, { fetch: rec.fetch });
  return { client: followUpClient, session, rec };
}

describe('mcp-client/client/listTools', () => {
  it('returns the downstream tools array', async () => {
    const { client, session, rec } = await initializedClient({
      responses: [
        jsonResponse({
          jsonrpc: '2.0',
          id: 2,
          result: {
            tools: [
              { name: 'create_pr', description: 'Open a PR', inputSchema: {} },
              { name: 'list_issues', description: 'List issues' },
            ],
          },
        }),
      ],
    });

    const tools = await client.listTools(session);

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('create_pr');
    expect(tools[0].description).toBe('Open a PR');
    expect(tools[1].name).toBe('list_issues');
    expect(rec.calls.length).toBe(1);
    const body = (await rec.calls[0].json()) as { method: string };
    expect(body.method).toBe('tools/list');
  });

  it('echoes the negotiated Mcp-Session-Id and MCP-Protocol-Version on the request', async () => {
    const { client, session, rec } = await initializedClient({
      sessionId: 'sess-xyz',
      responses: [
        jsonResponse({
          jsonrpc: '2.0',
          id: 2,
          result: { tools: [] },
        }),
      ],
    });

    await client.listTools(session);

    expect(rec.calls[0].headers.get('Mcp-Session-Id')).toBe('sess-xyz');
    expect(rec.calls[0].headers.get('MCP-Protocol-Version')).toBe('2025-06-18');
  });

  it('returns an empty array when the result has no tools field', async () => {
    const { client, session } = await initializedClient({
      responses: [jsonResponse({ jsonrpc: '2.0', id: 2, result: {} })],
    });

    const tools = await client.listTools(session);
    expect(tools).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// callTool
// ─────────────────────────────────────────────────────────────────────────────

describe('mcp-client/client/callTool', () => {
  it('forwards action as name and args as arguments in the tools/call body', async () => {
    const { client, session, rec } = await initializedClient({
      responses: [
        jsonResponse({
          jsonrpc: '2.0',
          id: 2,
          result: {
            content: [{ type: 'text', text: 'ok' }],
          },
        }),
      ],
    });

    await client.callTool(session, 'create_pr', { title: 'hello', body: 'world' });

    expect(rec.calls.length).toBe(1);
    const sent = (await rec.calls[0].json()) as {
      method: string;
      params: { name: string; arguments: Record<string, unknown> };
    };
    expect(sent.method).toBe('tools/call');
    expect(sent.params.name).toBe('create_pr');
    expect(sent.params.arguments).toEqual({ title: 'hello', body: 'world' });
  });

  it('returns the downstream result envelope verbatim, including isError', async () => {
    const { client, session } = await initializedClient({
      responses: [
        jsonResponse({
          jsonrpc: '2.0',
          id: 2,
          result: {
            content: [{ type: 'text', text: 'pr opened #42' }],
            structuredContent: { number: 42 },
          },
        }),
      ],
    });

    const result = await client.callTool(session, 'create_pr', {});
    expect(result.content).toEqual([{ type: 'text', text: 'pr opened #42' }]);
    expect(result.structuredContent).toEqual({ number: 42 });
    expect(result.isError).toBeUndefined();
  });

  it('passes through downstream isError: true results', async () => {
    const { client, session } = await initializedClient({
      responses: [
        jsonResponse({
          jsonrpc: '2.0',
          id: 2,
          result: {
            content: [{ type: 'text', text: 'invalid title' }],
            isError: true,
          },
        }),
      ],
    });

    const result = await client.callTool(session, 'create_pr', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: 'invalid title' });
  });

  it('defaults arguments to an empty object when args is null/undefined', async () => {
    const { client, session, rec } = await initializedClient({
      responses: [
        jsonResponse({
          jsonrpc: '2.0',
          id: 2,
          result: { content: [] },
        }),
      ],
    });

    await client.callTool(session, 'list_repos', undefined);

    const sent = (await rec.calls[0].json()) as {
      params: { arguments: unknown };
    };
    expect(sent.params.arguments).toEqual({});
  });

  it('propagates AbortSignal — aborting before fetch resolves rejects with the abort reason', async () => {
    const controller = new AbortController();
    // Set up a fetch that never resolves naturally — we'll abort externally.
    const rec: { calls: Request[]; fetch: typeof fetch } = {
      calls: [],
      fetch: (async (input: Request) => {
        rec.calls.push(input.clone() as unknown as Request);
        // Forward the signal: a real fetch would reject when aborted.
        return await new Promise<Response>((_resolve, reject) => {
          input.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }) as unknown as typeof fetch,
    };

    // We need a separately-initialized client whose follow-up calls use this fetch.
    const initRec = recordingFetch([
      jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { sessionId: 's' }),
      new Response(null, { status: 202 }),
    ]);
    const initClient = new OutboundMcpClient(clientOpts, { fetch: initRec.fetch });
    const session = await initClient.initialize({
      serverId: 'github',
      url: 'https://example.com/mcp',
      authInject: identityAuth,
    });

    const followUp = new OutboundMcpClient(clientOpts, { fetch: rec.fetch });
    const pending = followUp.callTool(session, 'slow', {}, controller.signal);

    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(DownstreamTransportError);
  });

  it('raises DownstreamAuthError on 401 during callTool', async () => {
    const { client, session } = await initializedClient({
      responses: [new Response('expired', { status: 401 })],
    });

    await expect(client.callTool(session, 'create_pr', {})).rejects.toBeInstanceOf(
      DownstreamAuthError,
    );
  });

  it('parses a text/event-stream tools/call response and returns the result', async () => {
    const sseBody =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"opened #42"}]}}\n' +
      '\n';
    const { client, session } = await initializedClient({
      responses: [
        new Response(sseBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ],
    });

    const result = await client.callTool(session, 'create_pr', { title: 'x' });
    expect(result.content[0]).toEqual({ type: 'text', text: 'opened #42' });
  });

  it('skips non-response events (notifications) in an SSE stream and returns the eventual response', async () => {
    const sseBody =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":0.5}}\n' +
      '\n' +
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"done"}]}}\n' +
      '\n';
    const { client, session } = await initializedClient({
      responses: [
        new Response(sseBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ],
    });

    const result = await client.callTool(session, 'slow', {});
    expect(result.content[0]).toEqual({ type: 'text', text: 'done' });
  });

  it('joins multi-line SSE data fields per spec before JSON-parsing', async () => {
    const sseBody =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":3,\n' +
      'data: "result":{"content":[{"type":"text","text":"multi"}]}}\n' +
      '\n';
    const { client, session } = await initializedClient({
      responses: [
        new Response(sseBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ],
    });

    const result = await client.callTool(session, 'multi', {});
    expect(result.content[0]).toEqual({ type: 'text', text: 'multi' });
  });

  it('raises DownstreamTransportError when the SSE stream ends without a response envelope', async () => {
    const sseBody =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n' +
      '\n';
    const { client, session } = await initializedClient({
      responses: [
        new Response(sseBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ],
    });

    const promise = client.callTool(session, 'orphan', {});
    await expect(promise).rejects.toBeInstanceOf(DownstreamTransportError);
    try {
      await promise;
    } catch (err) {
      expect((err as Error).message.toLowerCase()).toContain('sse');
    }
  });

  it('surfaces a JSON-RPC error envelope from an SSE stream as DownstreamProtocolError', async () => {
    const sseBody =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":3,"error":{"code":-32603,"message":"oops"}}\n' +
      '\n';
    const { client, session } = await initializedClient({
      responses: [
        new Response(sseBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ],
    });

    const promise = client.callTool(session, 'fails', {});
    await expect(promise).rejects.toBeInstanceOf(DownstreamProtocolError);
  });
});
