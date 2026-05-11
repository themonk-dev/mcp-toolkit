import { describe, expect, it } from 'bun:test';
import type { ToolContext } from '@mcp-toolkit/mcp';
import { healthTool } from './tool.ts';

const ctx: ToolContext = { sessionId: 'sid-1' };

describe('tools/examples/health', () => {
  it('returns ok status and a JSON text content block', async () => {
    const result = await healthTool.handler({}, ctx);

    expect(result.content[0]?.type).toBe('text');
    const sc = result.structuredContent as Record<string, unknown> | undefined;
    expect(sc?.status).toBe('ok');
    expect(typeof sc?.timestamp).toBe('number');
    expect(typeof sc?.runtime).toBe('string');

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('"status": "ok"');
  });
});
