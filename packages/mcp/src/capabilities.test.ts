import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { buildCapabilities } from './capabilities.ts';
import {
  definePrompt,
  defineResource,
  defineTool,
  type PromptDefinition,
  type ResourceDefinition,
  type ToolDefinition,
} from './types.ts';

const aTool: ToolDefinition = defineTool({
  name: 'echo',
  description: 'Echoes input back',
  inputSchema: z.object({ message: z.string() }),
  handler: async ({ message }) => ({
    content: [{ type: 'text', text: String(message) }],
  }),
}) as unknown as ToolDefinition;

const aPrompt: PromptDefinition = definePrompt({
  name: 'greet',
  description: 'Greeting prompt',
  handler: () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
  }),
});

const aResource: ResourceDefinition = defineResource({
  name: 'overview',
  uri: 'docs://overview',
  description: 'overview doc',
  handler: () => ({
    contents: [{ uri: 'docs://overview', text: 'hello' }],
  }),
});

describe('mcp/capabilities', () => {
  it('advertises only logging+experimental when registries are empty', () => {
    const caps = buildCapabilities({});
    expect(caps.logging).toEqual({});
    expect(caps.experimental).toEqual({});
    expect(caps.tools).toBeUndefined();
    expect(caps.prompts).toBeUndefined();
    expect(caps.resources).toBeUndefined();
  });

  it('advertises tools slot only when at least one tool registered', () => {
    const caps = buildCapabilities({ tools: [aTool] });
    expect(caps.tools).toEqual({ listChanged: true });
    expect(caps.prompts).toBeUndefined();
    expect(caps.resources).toBeUndefined();
  });

  it('advertises prompts slot only when prompts non-empty (empty tools array does not advertise)', () => {
    const caps = buildCapabilities({ tools: [], prompts: [aPrompt] });
    expect(caps.prompts).toEqual({ listChanged: true });
    expect(caps.tools).toBeUndefined();
    expect(caps.resources).toBeUndefined();
  });

  it('advertises all three slots when all registries are populated', () => {
    const caps = buildCapabilities({
      tools: [aTool],
      prompts: [aPrompt],
      resources: [aResource],
    });
    expect(caps.tools).toEqual({ listChanged: true });
    expect(caps.prompts).toEqual({ listChanged: true });
    expect(caps.resources).toEqual({ listChanged: true, subscribe: true });
    expect(caps.logging).toEqual({});
    expect(caps.experimental).toEqual({});
  });
});
