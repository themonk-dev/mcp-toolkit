import { describe, expect, it } from 'bun:test';
import type { PolicyEnforcer } from '@mcp-toolkit/policy';
import { z } from 'zod';
import {
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
