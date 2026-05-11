import { describe, expect, it } from 'bun:test';
import type { ToolContext, ToolResult } from '@mcp-toolkit/mcp';
import { OutboundMcpClient } from '@mcp-toolkit/mcp-client';
import type { ConnectedServer } from './config.ts';
import { EnvCredentialResolver } from './creds.ts';
import { buildProxyTools, LIST_ACTIONS } from './factory.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

interface Recorded {
  calls: Request[];
  fetch: typeof fetch;
}

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

function jsonResponse(body: unknown, sessionId?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (sessionId) headers.set('Mcp-Session-Id', sessionId);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

const initResponses = (sessionId = 'sess-x'): Response[] => [
  jsonResponse(
    { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } },
    sessionId,
  ),
  new Response(null, { status: 202 }),
];

const listToolsResponse = (tools: Array<{ name: string; description?: string }>) =>
  jsonResponse({ jsonrpc: '2.0', id: 2, result: { tools } });

const callToolResponse = (result: unknown) =>
  jsonResponse({ jsonrpc: '2.0', id: 3, result });

const githubServer: ConnectedServer = {
  id: 'github',
  url: 'https://example.com/github/mcp',
  authType: 'bearer',
  token: 'ghp_xxx',
};

const linearServer: ConnectedServer = {
  id: 'linear',
  url: 'https://example.com/linear/mcp',
  authType: 'api_key',
  headerName: 'x-api-key',
  key: 'lin_xxx',
};

const noneServer: ConnectedServer = {
  id: 'public',
  url: 'https://example.com/public/mcp',
  authType: 'none',
};

const emptyCtx: ToolContext = { sessionId: 'upstream-sess' };

// ─────────────────────────────────────────────────────────────────────────────

describe('proxy-tools/factory/buildProxyTools', () => {
  it('returns one ToolDefinition per configured server, named by id', () => {
    const rec = recordingFetch([]);
    const client = new OutboundMcpClient(
      { clientInfo: { name: 'gw', version: '1' } },
      { fetch: rec.fetch },
    );
    const tools = buildProxyTools({
      servers: [githubServer, linearServer, noneServer],
      resolver: new EnvCredentialResolver([githubServer, linearServer, noneServer]),
      client,
    });

    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name).sort()).toEqual(['github', 'linear', 'public']);
  });

  it('each ToolDefinition has an inputSchema of { action: string, args: object }', () => {
    const rec = recordingFetch([]);
    const client = new OutboundMcpClient(
      { clientInfo: { name: 'gw', version: '1' } },
      { fetch: rec.fetch },
    );
    const [tool] = buildProxyTools({
      servers: [githubServer],
      resolver: new EnvCredentialResolver([githubServer]),
      client,
    });

    const ok = tool.inputSchema.safeParse({
      action: 'create_pr',
      args: { title: 'x' },
    });
    expect(ok.success).toBe(true);

    const okNoArgs = tool.inputSchema.safeParse({ action: 'list_repos' });
    expect(okNoArgs.success).toBe(true);

    const err = tool.inputSchema.safeParse({ action: '' });
    expect(err.success).toBe(false);
  });
});

describe('proxy-tools/factory/handler hot path', () => {
  it('first call: initializes, fetches tools/list, then forwards the action — three outbound HTTP calls', async () => {
    const rec = recordingFetch([
      ...initResponses(),
      listToolsResponse([{ name: 'create_pr' }, { name: 'list_issues' }]),
      callToolResponse({ content: [{ type: 'text', text: 'opened #42' }] }),
    ]);
    const client = new OutboundMcpClient(
      { clientInfo: { name: 'gw', version: '1' } },
      { fetch: rec.fetch },
    );
    const [tool] = buildProxyTools({
      servers: [githubServer],
      resolver: new EnvCredentialResolver([githubServer]),
      client,
    });

    const result = await tool.handler(
      { action: 'create_pr', args: { title: 'x' } },
      emptyCtx,
    );

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toBe('opened #42');
    expect(rec.calls.length).toBe(4); // init + notifications/initialized + listTools + callTool

    // Bearer auth was applied to every outbound call.
    for (const call of rec.calls) {
      expect(call.headers.get('Authorization')).toBe('Bearer ghp_xxx');
    }
  });

  it('second call within TTL reuses cached session and tools list — only callTool is sent', async () => {
    const rec = recordingFetch([
      ...initResponses(),
      listToolsResponse([{ name: 'list_repos' }]),
      callToolResponse({ content: [{ type: 'text', text: 'first' }] }),
      callToolResponse({ content: [{ type: 'text', text: 'second' }] }),
    ]);
    const client = new OutboundMcpClient(
      { clientInfo: { name: 'gw', version: '1' } },
      { fetch: rec.fetch },
    );
    const [tool] = buildProxyTools({
      servers: [githubServer],
      resolver: new EnvCredentialResolver([githubServer]),
      client,
    });

    await tool.handler({ action: 'list_repos', args: {} }, emptyCtx);
    const second = await tool.handler({ action: 'list_repos', args: {} }, emptyCtx);

    expect((second.content[0] as { text: string }).text).toBe('second');
    expect(rec.calls.length).toBe(5); // init+notify + listTools + callTool + callTool
  });

  it('unknown action returns an MCP isError listing the known actions', async () => {
    const rec = recordingFetch([
      ...initResponses(),
      listToolsResponse([{ name: 'create_pr' }, { name: 'list_issues' }]),
    ]);
    const client = new OutboundMcpClient(
      { clientInfo: { name: 'gw', version: '1' } },
      { fetch: rec.fetch },
    );
    const [tool] = buildProxyTools({
      servers: [githubServer],
      resolver: new EnvCredentialResolver([githubServer]),
      client,
    });

    const result: ToolResult = await tool.handler(
      { action: 'delete_universe', args: {} },
      emptyCtx,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('delete_universe');
    expect(text).toContain('create_pr');
    expect(text).toContain('list_issues');
  });

  it('returns an MCP isError when no credential is resolvable for the server', async () => {
    const rec = recordingFetch([]);
    const client = new OutboundMcpClient(
      { clientInfo: { name: 'gw', version: '1' } },
      { fetch: rec.fetch },
    );
    // Resolver has no entries — simulates a config drift where the tool
    // was built but the cred lookup fails.
    const tools = buildProxyTools({
      servers: [githubServer],
      resolver: new EnvCredentialResolver([]),
      client,
    });

    const result = await tools[0].handler({ action: 'create_pr', args: {} }, emptyCtx);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('github');
    expect((result.content[0] as { text: string }).text).toContain('credential');
  });

  it('maps DownstreamAuthError to an MCP isError mentioning rejected credential', async () => {
    const rec = recordingFetch([
      ...initResponses(),
      listToolsResponse([{ name: 'create_pr' }]),
      new Response('expired', { status: 401 }),
    ]);
    const client = new OutboundMcpClient(
      { clientInfo: { name: 'gw', version: '1' } },
      { fetch: rec.fetch },
    );
    const [tool] = buildProxyTools({
      servers: [githubServer],
      resolver: new EnvCredentialResolver([githubServer]),
      client,
    });

    const result = await tool.handler({ action: 'create_pr', args: {} }, emptyCtx);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text.toLowerCase();
    expect(text).toContain('reject');
    expect(text).toContain('github');
  });

  it('evicts the cached session on transport error so the next call re-initializes', async () => {
    const rec = recordingFetch([
      ...initResponses('sess-a'),
      listToolsResponse([{ name: 'create_pr' }]),
      new Response('boom', { status: 500 }), // transport error on callTool
      // Recovery path: re-initialize + re-listTools + retry callTool succeeds.
      ...initResponses('sess-b'),
      listToolsResponse([{ name: 'create_pr' }]),
      callToolResponse({ content: [{ type: 'text', text: 'recovered' }] }),
    ]);
    const client = new OutboundMcpClient(
      { clientInfo: { name: 'gw', version: '1' } },
      { fetch: rec.fetch },
    );
    const [tool] = buildProxyTools({
      servers: [githubServer],
      resolver: new EnvCredentialResolver([githubServer]),
      client,
    });

    const first = await tool.handler({ action: 'create_pr', args: {} }, emptyCtx);
    expect(first.isError).toBe(true);

    const second = await tool.handler({ action: 'create_pr', args: {} }, emptyCtx);
    expect(second.isError).toBeUndefined();
    expect((second.content[0] as { text: string }).text).toBe('recovered');
  });

  it('passes downstream isError: true results through to the upstream', async () => {
    const rec = recordingFetch([
      ...initResponses(),
      listToolsResponse([{ name: 'create_pr' }]),
      callToolResponse({
        content: [{ type: 'text', text: 'invalid title' }],
        isError: true,
      }),
    ]);
    const client = new OutboundMcpClient(
      { clientInfo: { name: 'gw', version: '1' } },
      { fetch: rec.fetch },
    );
    const [tool] = buildProxyTools({
      servers: [githubServer],
      resolver: new EnvCredentialResolver([githubServer]),
      client,
    });

    const result = await tool.handler({ action: 'create_pr', args: {} }, emptyCtx);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe('invalid title');
  });

  it('injects api_key auth headers on outbound requests for api_key servers', async () => {
    const rec = recordingFetch([
      ...initResponses(),
      listToolsResponse([{ name: 'list_teams' }]),
      callToolResponse({ content: [{ type: 'text', text: 'ok' }] }),
    ]);
    const client = new OutboundMcpClient(
      { clientInfo: { name: 'gw', version: '1' } },
      { fetch: rec.fetch },
    );
    const [tool] = buildProxyTools({
      servers: [linearServer],
      resolver: new EnvCredentialResolver([linearServer]),
      client,
    });

    await tool.handler({ action: 'list_teams', args: {} }, emptyCtx);
    for (const call of rec.calls) {
      expect(call.headers.get('x-api-key')).toBe('lin_xxx');
      expect(call.headers.get('Authorization')).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// __list_actions__ meta-action
// ─────────────────────────────────────────────────────────────────────────────

describe('proxy-tools/factory/list_actions meta-action', () => {
  it('exports a stable constant for the reserved meta-action name', () => {
    // Pinning the value so collisions stay impossible across upgrades.
    expect(LIST_ACTIONS).toBe('__list_actions__');
  });

  it('returns the downstream action catalog (not isError) when called with the meta-action', async () => {
    const rec = recordingFetch([
      ...initResponses(),
      listToolsResponse([
        {
          name: 'create_pr',
          description: 'Open a PR',
        },
        { name: 'list_issues', description: 'List issues' },
      ]),
    ]);
    const client = new OutboundMcpClient(
      { clientInfo: { name: 'gw', version: '1' } },
      { fetch: rec.fetch },
    );
    const [tool] = buildProxyTools({
      servers: [githubServer],
      resolver: new EnvCredentialResolver([githubServer]),
      client,
    });

    const result = await tool.handler({ action: LIST_ACTIONS, args: {} }, emptyCtx);

    expect(result.isError).toBeUndefined();
    // The structured payload is preferred but the text mirror must also
    // mention each action by name so non-structured clients still get value.
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('create_pr');
    expect(text).toContain('list_issues');
  });

  it('exposes the downstream catalog as structuredContent with name + description + inputSchema', async () => {
    const rec = recordingFetch([
      ...initResponses(),
      listToolsResponse([
        {
          name: 'create_pr',
          description: 'Open a PR',
        },
      ]),
    ]);
    const client = new OutboundMcpClient(
      { clientInfo: { name: 'gw', version: '1' } },
      { fetch: rec.fetch },
    );
    const [tool] = buildProxyTools({
      servers: [githubServer],
      resolver: new EnvCredentialResolver([githubServer]),
      client,
    });

    const result = await tool.handler({ action: LIST_ACTIONS, args: {} }, emptyCtx);

    const structured = result.structuredContent as {
      serverId: string;
      actions: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    };
    expect(structured.serverId).toBe('github');
    expect(structured.actions).toHaveLength(1);
    expect(structured.actions[0].name).toBe('create_pr');
    expect(structured.actions[0].description).toBe('Open a PR');
  });

  it('does NOT forward to the downstream `tools/call` — only initialize + tools/list are issued', async () => {
    const rec = recordingFetch([
      ...initResponses(),
      listToolsResponse([{ name: 'create_pr' }]),
    ]);
    const client = new OutboundMcpClient(
      { clientInfo: { name: 'gw', version: '1' } },
      { fetch: rec.fetch },
    );
    const [tool] = buildProxyTools({
      servers: [githubServer],
      resolver: new EnvCredentialResolver([githubServer]),
      client,
    });

    await tool.handler({ action: LIST_ACTIONS, args: {} }, emptyCtx);

    // Three outbound calls expected: initialize + notifications/initialized + tools/list.
    // Any `tools/call` here would mean we leaked the meta-action to the downstream.
    expect(rec.calls.length).toBe(3);
  });

  it('serves the catalog from cache on subsequent meta-action calls (no extra tools/list)', async () => {
    const rec = recordingFetch([
      ...initResponses(),
      listToolsResponse([{ name: 'create_pr' }]),
    ]);
    const client = new OutboundMcpClient(
      { clientInfo: { name: 'gw', version: '1' } },
      { fetch: rec.fetch },
    );
    const [tool] = buildProxyTools({
      servers: [githubServer],
      resolver: new EnvCredentialResolver([githubServer]),
      client,
    });

    await tool.handler({ action: LIST_ACTIONS, args: {} }, emptyCtx);
    const second = await tool.handler({ action: LIST_ACTIONS, args: {} }, emptyCtx);

    expect(second.isError).toBeUndefined();
    // Still just the original three calls — cache hit on second invocation.
    expect(rec.calls.length).toBe(3);
  });

  it('advertises the meta-action in the tool description so the LLM discovers it', () => {
    const rec = recordingFetch([]);
    const client = new OutboundMcpClient(
      { clientInfo: { name: 'gw', version: '1' } },
      { fetch: rec.fetch },
    );
    const [tool] = buildProxyTools({
      servers: [githubServer],
      resolver: new EnvCredentialResolver([githubServer]),
      client,
    });
    expect(tool.description).toContain(LIST_ACTIONS);
  });
});
