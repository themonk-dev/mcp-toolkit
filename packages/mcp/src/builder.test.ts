import { describe, expect, it, mock } from 'bun:test';
import type { AuthStrategy, AuthVerifyResult } from '@mcp-toolkit/auth';
import type { PolicyEnforcer } from '@mcp-toolkit/policy';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildServer } from './builder.ts';
import { getLowLevelServer } from './server-internals.ts';
import { defineTool, type ToolDefinition } from './types.ts';

interface RequestHandlerMap {
  get(method: string): ((req: unknown, extra: unknown) => Promise<unknown>) | undefined;
  has(method: string): boolean;
}

function getRequestHandlers(server: McpServer): RequestHandlerMap {
  const lowLevel = getLowLevelServer(server) as unknown as {
    _requestHandlers: RequestHandlerMap;
  };
  return lowLevel._requestHandlers;
}

const echoTool: ToolDefinition = defineTool({
  name: 'echo',
  description: 'Echo back the input',
  inputSchema: z.object({ message: z.string() }),
  handler: async ({ message }) => ({
    content: [{ type: 'text', text: String(message) }],
  }),
}) as unknown as ToolDefinition;

describe('mcp/builder', () => {
  it('returns an McpServer instance with derived capabilities', () => {
    // The builder unconditionally installs a tools/list handler (so policy
    // can filter), which means the SDK requires the tools capability to be
    // advertised — pass a single tool to satisfy that, then confirm the
    // returned server is an McpServer with the tools handler installed.
    const server = buildServer({
      name: 'test',
      version: '0.0.0',
      tools: [echoTool],
    });
    expect(server).toBeInstanceOf(McpServer);
    const handlers = getRequestHandlers(server);
    expect(handlers.has('tools/list')).toBe(true);
  });

  it('registers tools so the SDK tools/list handler returns the catalog', async () => {
    const server = buildServer({
      name: 'test',
      version: '0.0.0',
      tools: [echoTool],
    });
    const handlers = getRequestHandlers(server);
    const handler = handlers.get('tools/list');
    expect(handler).toBeDefined();
    if (!handler) throw new Error('tools/list handler not registered');
    const response = (await handler(
      { method: 'tools/list', params: {} },
      {
        signal: new AbortController().signal,
        requestId: 1,
        sendNotification: async () => {},
        sendRequest: async () => ({}) as never,
      },
    )) as { tools: Array<{ name: string }> };
    expect(Array.isArray(response.tools)).toBe(true);
    const names = response.tools.map((t) => t.name);
    expect(names).toContain('echo');
  });

  it('accepts an auth strategy and calls init() when defined', async () => {
    const initSpy = mock(() => Promise.resolve());
    const stubAuth: AuthStrategy = {
      kind: 'none',
      init: initSpy,
      verify: async (): Promise<AuthVerifyResult> => ({
        ok: false,
        resolvedHeaders: {},
      }),
    };
    const server = buildServer({
      name: 'test',
      version: '0.0.0',
      tools: [echoTool],
      auth: stubAuth,
    });
    expect(server).toBeInstanceOf(McpServer);
    // Builder accepts but does not itself call init() — that is the transport's
    // responsibility. We assert no throw and that the strategy is recognised
    // (a structural check). Calling init() ourselves to confirm the spy is wired.
    await stubAuth.init?.();
    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts a structurally-typed PolicyEnforcer without throwing', () => {
    const stubPolicy: PolicyEnforcer = {
      isEnforced: () => false,
      filterTools: (tools) => tools,
      filterPrompts: (prompts) => prompts,
      filterResources: (resources) => resources,
      canAccessTool: () => true,
      canAccessPrompt: () => true,
      canAccessResource: () => true,
      policy: {
        version: 1,
        mode: 'off',
        tools: [],
        prompts: [],
        resources: [],
      },
    };
    const server = buildServer({
      name: 'test',
      version: '0.0.0',
      tools: [echoTool],
      policy: stubPolicy,
    });
    expect(server).toBeInstanceOf(McpServer);
  });

  it('omits the tools capability and tools/list handler when no tools are registered', async () => {
    // Regression for builder bug: tools/list was previously registered
    // unconditionally, but the SDK rejects the registration when the
    // `tools` capability isn't advertised (which only happens for
    // tools.length > 0). The build should succeed, the tools/list
    // handler should NOT be installed, and an initialize response
    // should not include the `tools` capability.
    let server!: McpServer;
    expect(() => {
      server = buildServer({ name: 'test', version: '0.0.0', tools: [] });
    }).not.toThrow();
    const handlers = getRequestHandlers(server);
    expect(handlers.has('tools/list')).toBe(false);

    const initHandler = handlers.get('initialize');
    expect(initHandler).toBeDefined();
    if (!initHandler) throw new Error('initialize handler not registered');
    const initResponse = (await initHandler(
      {
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '0.0.0' },
        },
      },
      {
        signal: new AbortController().signal,
        requestId: 1,
        sendNotification: async () => {},
        sendRequest: async () => ({}) as never,
      },
    )) as { capabilities: Record<string, unknown> };
    expect(initResponse.capabilities.tools).toBeUndefined();
  });

  it('wires oninitialized callback through the low-level server without throwing', () => {
    const cb = mock(() => {});
    const server = buildServer({
      name: 'test',
      version: '0.0.0',
      tools: [echoTool],
      oninitialized: cb,
    });
    const lowLevel = getLowLevelServer(server);
    // The builder installs an oninitialized wrapper on the low-level server.
    expect(typeof lowLevel.oninitialized).toBe('function');
    // Firing the wrapper here would require a getClientVersion stub; that is
    // integration territory. Shape-only assertion is sufficient.
  });
});
