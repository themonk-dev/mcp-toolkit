import { describe, expect, it } from 'bun:test';
import type { PolicyEnforcer } from '@mcp-toolkit/policy';
import { z } from 'zod';
import type { AuditEvent } from './audit-event.ts';
import {
  type CancellationRegistry,
  dispatchMcpMethod,
  type McpDispatchContext,
  type McpSessionState,
} from './dispatcher.ts';
import { defineTool, type ToolDefinition } from './types.ts';

const echoTool: ToolDefinition = defineTool({
  name: 'echo',
  description: 'Echo input',
  inputSchema: z.object({ message: z.string() }),
  handler: async ({ message }) => ({
    content: [{ type: 'text', text: String(message) }],
  }),
}) as unknown as ToolDefinition;

const healthTool: ToolDefinition = defineTool({
  name: 'health',
  description: 'Health check',
  inputSchema: z.object({}),
  handler: async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }),
}) as unknown as ToolDefinition;

function makeContext(overrides: Partial<McpDispatchContext> = {}): McpDispatchContext {
  let session: McpSessionState | undefined;
  return {
    sessionId: 'sess-1',
    auth: { sessionId: 'sess-1' },
    config: { title: 'test-server', version: '0.0.0' },
    registries: {
      tools: [echoTool, healthTool],
      prompts: [],
      resources: [],
    },
    getSessionState: () => session,
    setSessionState: (s) => {
      session = s;
    },
    ...overrides,
  };
}

function denyEchoPolicy(): PolicyEnforcer {
  return {
    isEnforced: () => true,
    filterTools: <T extends { name: string }>(tools: T[]) =>
      tools.filter((t) => t.name !== 'echo'),
    filterPrompts: <T extends { name: string }>(prompts: T[]) => prompts,
    filterResources: <T extends { uri: string }>(resources: T[]) => resources,
    canAccessTool: (name) => name !== 'echo',
    canAccessPrompt: () => true,
    canAccessResource: () => true,
    policy: {
      version: 1,
      mode: 'enforce',
      tools: [],
      prompts: [],
      resources: [],
    },
  };
}

describe('mcp/dispatcher', () => {
  it('handles initialize and returns protocolVersion + serverInfo + capabilities', async () => {
    const ctx = makeContext();
    const res = await dispatchMcpMethod(
      'initialize',
      { protocolVersion: '2025-06-18', clientInfo: { name: 'c', version: '1' } },
      ctx,
    );
    expect(res.error).toBeUndefined();
    const result = res.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: Record<string, unknown>;
    };
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.serverInfo.name).toBe('test-server');
    expect(result.serverInfo.version).toBe('0.0.0');
    expect(result.capabilities.logging).toEqual({});
    expect(result.capabilities.tools).toEqual({ listChanged: true });
  });

  it('returns the full tool catalog on tools/list when policy is unset', async () => {
    const ctx = makeContext();
    const res = await dispatchMcpMethod('tools/list', undefined, ctx);
    expect(res.error).toBeUndefined();
    const result = res.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['echo', 'health']);
  });

  it('filters denied tool out of tools/list when policy enforces', async () => {
    const ctx = makeContext({ policy: denyEchoPolicy() });
    const res = await dispatchMcpMethod('tools/list', undefined, ctx);
    expect(res.error).toBeUndefined();
    const result = res.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain('echo');
    expect(names).toContain('health');
  });

  it('returns -32009 PermissionDenied on tools/call denied by policy', async () => {
    const ctx = makeContext({ policy: denyEchoPolicy() });
    const res = await dispatchMcpMethod(
      'tools/call',
      { name: 'echo', arguments: { message: 'hi' } },
      ctx,
    );
    expect(res.result).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32009);
  });

  it('handles ping and returns an empty result', async () => {
    const ctx = makeContext();
    const res = await dispatchMcpMethod('ping', undefined, ctx);
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({});
  });
});

describe('audit sink', () => {
  class RecordingSink {
    events: AuditEvent[] = [];
    emit(e: AuditEvent): void {
      this.events.push(e);
    }
  }

  const isErrorTool: ToolDefinition = defineTool({
    name: 'broken',
    description: 'Returns isError',
    inputSchema: z.object({}),
    handler: async () => ({
      content: [{ type: 'text', text: 'oops' }],
      isError: true,
    }),
  }) as unknown as ToolDefinition;

  const slowTool: ToolDefinition = defineTool({
    name: 'slow',
    description: 'Waits on the abort signal',
    inputSchema: z.object({}),
    handler: async (_args, toolCtx) => {
      await new Promise<void>((resolve) => {
        if (toolCtx.signal?.aborted) {
          resolve();
          return;
        }
        toolCtx.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        content: [{ type: 'text', text: 'Operation was cancelled' }],
        isError: true,
      };
    },
  }) as unknown as ToolDefinition;

  it('emits mcp.tool.call with outcome=ok on success', async () => {
    const sink = new RecordingSink();
    const ctx = makeContext({ audit: sink });
    const res = await dispatchMcpMethod(
      'tools/call',
      { name: 'echo', arguments: { message: 'hi' } },
      ctx,
    );
    expect(res.error).toBeUndefined();
    expect(sink.events).toHaveLength(1);
    const ev = sink.events[0];
    expect(ev.kind).toBe('mcp.tool.call');
    if (ev.kind !== 'mcp.tool.call') throw new Error('unexpected event kind');
    expect(ev.outcome).toBe('ok');
    expect(ev.tool).toBe('echo');
    expect(ev.sessionId).toBe('sess-1');
    expect(typeof ev.durationMs).toBe('number');
  });

  it('emits mcp.tool.call with outcome=denied when policy denies the call', async () => {
    const sink = new RecordingSink();
    const ctx = makeContext({ audit: sink, policy: denyEchoPolicy() });
    const res = await dispatchMcpMethod(
      'tools/call',
      { name: 'echo', arguments: { message: 'hi' } },
      ctx,
    );
    expect(res.error?.code).toBe(-32009);
    expect(sink.events).toHaveLength(1);
    const ev = sink.events[0];
    if (ev.kind !== 'mcp.tool.call') throw new Error('unexpected event kind');
    expect(ev.outcome).toBe('denied');
    expect(ev.tool).toBe('echo');
    expect(ev.policyEnforced).toBe(true);
    expect(ev.principalGroups).toEqual([]);
  });

  it('emits mcp.tool.call with outcome=error when tool returns isError', async () => {
    const sink = new RecordingSink();
    const ctx = makeContext({
      audit: sink,
      registries: { tools: [isErrorTool], prompts: [], resources: [] },
    });
    const res = await dispatchMcpMethod(
      'tools/call',
      { name: 'broken', arguments: {} },
      ctx,
    );
    expect(res.error).toBeUndefined();
    expect((res.result as { isError?: boolean })?.isError).toBe(true);
    expect(sink.events).toHaveLength(1);
    const ev = sink.events[0];
    if (ev.kind !== 'mcp.tool.call') throw new Error('unexpected event kind');
    expect(ev.outcome).toBe('error');
    expect(ev.tool).toBe('broken');
    expect(ev.errorMessage).toBe('oops');
  });

  it('emits mcp.tool.call with outcome=cancelled when AbortController fires mid-call', async () => {
    const sink = new RecordingSink();
    const cancellationRegistry: CancellationRegistry = new Map();
    const ctx = makeContext({
      audit: sink,
      cancellationRegistry,
      registries: { tools: [slowTool], prompts: [], resources: [] },
    });

    const requestId = 'req-1';
    const callPromise = dispatchMcpMethod(
      'tools/call',
      { name: 'slow', arguments: {} },
      ctx,
      requestId,
    );

    // Wait a microtask cycle for the controller to be registered.
    await new Promise((r) => setTimeout(r, 0));
    const controller = cancellationRegistry.get(requestId);
    expect(controller).toBeDefined();
    controller?.abort('test-cancel');

    await callPromise;

    expect(sink.events).toHaveLength(1);
    const ev = sink.events[0];
    if (ev.kind !== 'mcp.tool.call') throw new Error('unexpected event kind');
    expect(ev.outcome).toBe('cancelled');
    expect(ev.tool).toBe('slow');
  });

  it('emits mcp.catalog.list when ctx.audit set on tools/list', async () => {
    const sink = new RecordingSink();
    const ctx = makeContext({ audit: sink });
    const res = await dispatchMcpMethod('tools/list', undefined, ctx);
    expect(res.error).toBeUndefined();
    expect(sink.events).toHaveLength(1);
    const ev = sink.events[0];
    expect(ev.kind).toBe('mcp.catalog.list');
    if (ev.kind !== 'mcp.catalog.list') throw new Error('unexpected event kind');
    expect(ev.methods).toEqual(['tools/list']);
    expect(ev.sessionId).toBe('sess-1');
  });

  it('does not emit when ctx.audit is undefined', async () => {
    const sink = new RecordingSink();
    const ctx = makeContext();
    // sanity: no audit on ctx
    expect(ctx.audit).toBeUndefined();
    await dispatchMcpMethod('tools/list', undefined, ctx);
    await dispatchMcpMethod(
      'tools/call',
      { name: 'echo', arguments: { message: 'hi' } },
      ctx,
    );
    expect(sink.events).toHaveLength(0);
  });
});
