/**
 * End-to-end test for downstream-MCP proxying.
 *
 * Spans the full stack: a real `compose()` run with `connectedServers`
 * configured, the Workers HTTP handler, the dispatcher, the proxy-tool
 * factory, the outbound MCP client, and a stub `fetch` standing in for the
 * downstream MCP server. Asserts that an upstream `tools/call` lands at the
 * downstream with the configured credential injected, that the cache is hot
 * on the second call, and that downstream auth failures surface as MCP
 * `isError` results (not HTTP 401s) on the upstream channel.
 */

import { describe, expect, it } from 'bun:test';
import { buildWorkersHandler } from '@mcp-toolkit/transport-http/workers';
import { compose } from '../src/compose.ts';
import { appConfigSchema } from '../src/config.ts';
import { configFromEnv } from './__helpers__/harness.ts';
import { callMcp, initializeSession } from './__helpers__/mcp.ts';

interface OutboundCall {
  bodyMethod: string;
  authorization: string | null;
  customApiKey: string | null;
}

/**
 * Build a stub `outboundFetch` that pretends to be a downstream MCP server.
 * Responds to `initialize`, `tools/list`, and `tools/call` deterministically;
 * supports configurable responses for `tools/call` so each test can shape
 * its scenario. Returns 202 for any notification.
 */
function downstreamStub(opts: {
  sessionId?: string;
  tools: Array<{ name: string; description?: string }>;
  callToolResponses: Array<Response>;
  customApiKeyHeader?: string;
}): { fetch: typeof fetch; calls: OutboundCall[] } {
  const sessionId = opts.sessionId ?? 'downstream-sess';
  const callToolQueue = [...opts.callToolResponses];
  const calls: OutboundCall[] = [];

  const fn = (async (input: Request) => {
    const cloned = input.clone() as unknown as Request;
    const authorization = cloned.headers.get('Authorization');
    const customApiKey = opts.customApiKeyHeader
      ? cloned.headers.get(opts.customApiKeyHeader)
      : null;
    const body = (await cloned.json()) as { method: string };
    calls.push({ bodyMethod: body.method, authorization, customApiKey });

    if (body.method === 'initialize') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2025-06-18',
            serverInfo: { name: 'downstream', version: '1.0.0' },
            capabilities: {},
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId },
        },
      );
    }
    if (body.method === 'tools/list') {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: opts.tools } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (body.method === 'tools/call') {
      const next = callToolQueue.shift();
      if (!next) {
        throw new Error('downstreamStub: tools/call queue exhausted');
      }
      return next;
    }
    // Notifications, etc.
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;

  return { fetch: fn, calls };
}

/**
 * Compose a Workers app with the provided `connectedServers` config and a
 * stub `outboundFetch`. Auth strategy is `none` so the upstream channel is
 * the focus of the test, not the auth flow.
 */
async function bootWithDownstream(opts: {
  servers: unknown[];
  outboundFetch: typeof fetch;
}): Promise<{ app: { fetch: (req: Request) => Promise<Response> } }> {
  const config = appConfigSchema.parse({
    connectedServers: opts.servers,
    auth: { strategy: 'none' },
  });
  const runtime = await compose({ config, outboundFetch: opts.outboundFetch });
  const handler = buildWorkersHandler({
    auth: runtime.auth,
    tokenStore: runtime.tokenStore,
    sessionStore: runtime.sessionStore,
    registries: runtime.registries,
    policy: runtime.policy ?? undefined,
    config: configFromEnv(config),
  });
  return { app: handler };
}

describe('proxy: end-to-end through the transport', () => {
  it('exposes each connected server as a tool named by id and forwards tools/call with bearer auth', async () => {
    const stub = downstreamStub({
      tools: [{ name: 'create_pr', description: 'Open a PR' }],
      callToolResponses: [
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            result: { content: [{ type: 'text', text: 'opened #42' }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ],
    });
    const { app } = await bootWithDownstream({
      servers: [
        {
          id: 'github',
          url: 'https://downstream.example.com/mcp',
          authType: 'bearer',
          token: 'ghp_e2e',
        },
      ],
      outboundFetch: stub.fetch,
    });

    const init = await initializeSession(app);
    expect(init.status).toBe(200);

    // `tools/list` advertises a single proxy tool named "github".
    const list = await callMcp(app, init.sessionId, 'tools/list');
    expect(list.status).toBe(200);
    const advertised = (
      (list.body.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []
    ).map((t) => t.name);
    expect(advertised).toContain('github');

    // `tools/call github { action: "create_pr", args: { … } }` should round-trip.
    const call = await callMcp(app, init.sessionId, 'tools/call', {
      name: 'github',
      arguments: { action: 'create_pr', args: { title: 'hello' } },
    });
    expect(call.status).toBe(200);
    const result = call.body.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('opened #42');

    // Auth was injected on every outbound call (initialize, notify, list, call).
    expect(stub.calls.length).toBeGreaterThanOrEqual(4);
    for (const c of stub.calls) {
      expect(c.authorization).toBe('Bearer ghp_e2e');
    }

    // Body methods seen at the downstream, in order.
    const seq = stub.calls.map((c) => c.bodyMethod);
    expect(seq).toContain('initialize');
    expect(seq).toContain('notifications/initialized');
    expect(seq).toContain('tools/list');
    expect(seq).toContain('tools/call');
  });

  it('caches the downstream session and tools/list across consecutive upstream calls', async () => {
    const stub = downstreamStub({
      tools: [{ name: 'list_issues' }],
      callToolResponses: [
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            result: { content: [{ type: 'text', text: 'first' }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 4,
            result: { content: [{ type: 'text', text: 'second' }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ],
    });
    const { app } = await bootWithDownstream({
      servers: [
        {
          id: 'github',
          url: 'https://downstream.example.com/mcp',
          authType: 'bearer',
          token: 'ghp_cache',
        },
      ],
      outboundFetch: stub.fetch,
    });
    const init = await initializeSession(app);

    await callMcp(app, init.sessionId, 'tools/call', {
      name: 'github',
      arguments: { action: 'list_issues', args: {} },
    });
    const second = await callMcp(app, init.sessionId, 'tools/call', {
      name: 'github',
      arguments: { action: 'list_issues', args: {} },
    });

    const text = (
      second.body.result as { content: Array<{ type: string; text: string }> }
    ).content[0].text;
    expect(text).toBe('second');

    // Second call must NOT re-issue initialize / tools/list — only an extra
    // tools/call on the downstream.
    const initializes = stub.calls.filter((c) => c.bodyMethod === 'initialize').length;
    const lists = stub.calls.filter((c) => c.bodyMethod === 'tools/list').length;
    const calls = stub.calls.filter((c) => c.bodyMethod === 'tools/call').length;
    expect(initializes).toBe(1);
    expect(lists).toBe(1);
    expect(calls).toBe(2);
  });

  it('returns an MCP isError (not HTTP 401) when the downstream rejects the credential', async () => {
    const stub = downstreamStub({
      tools: [{ name: 'create_pr' }],
      callToolResponses: [new Response('token expired', { status: 401 })],
    });
    const { app } = await bootWithDownstream({
      servers: [
        {
          id: 'github',
          url: 'https://downstream.example.com/mcp',
          authType: 'bearer',
          token: 'ghp_stale',
        },
      ],
      outboundFetch: stub.fetch,
    });
    const init = await initializeSession(app);

    const call = await callMcp(app, init.sessionId, 'tools/call', {
      name: 'github',
      arguments: { action: 'create_pr', args: {} },
    });

    expect(call.status).toBe(200); // upstream channel stays 200
    const result = call.body.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('reject');
    expect(result.content[0].text).toContain('github');
  });

  it('injects api_key headers (custom header name, NOT Authorization) for api_key servers', async () => {
    const stub = downstreamStub({
      tools: [{ name: 'list_teams' }],
      callToolResponses: [
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            result: { content: [{ type: 'text', text: 'ok' }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ],
      customApiKeyHeader: 'x-api-key',
    });
    const { app } = await bootWithDownstream({
      servers: [
        {
          id: 'linear',
          url: 'https://downstream.example.com/mcp',
          authType: 'api_key',
          headerName: 'x-api-key',
          key: 'lin_e2e',
        },
      ],
      outboundFetch: stub.fetch,
    });
    const init = await initializeSession(app);

    const call = await callMcp(app, init.sessionId, 'tools/call', {
      name: 'linear',
      arguments: { action: 'list_teams', args: {} },
    });
    expect(call.status).toBe(200);
    for (const c of stub.calls) {
      expect(c.customApiKey).toBe('lin_e2e');
      expect(c.authorization).toBeNull();
    }
  });

  it('returns an MCP isError when the requested action is not in the downstream catalog', async () => {
    const stub = downstreamStub({
      tools: [{ name: 'create_pr' }, { name: 'list_issues' }],
      callToolResponses: [],
    });
    const { app } = await bootWithDownstream({
      servers: [
        {
          id: 'github',
          url: 'https://downstream.example.com/mcp',
          authType: 'bearer',
          token: 'ghp_x',
        },
      ],
      outboundFetch: stub.fetch,
    });
    const init = await initializeSession(app);

    const call = await callMcp(app, init.sessionId, 'tools/call', {
      name: 'github',
      arguments: { action: 'delete_universe', args: {} },
    });

    const result = call.body.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('delete_universe');
    expect(result.content[0].text).toContain('create_pr');
  });
});
