import { describe, expect, it } from 'bun:test';
import type { ToolContext } from '@mcp-toolkit/mcp';
import { echoTool } from './tool.ts';

const ctx: ToolContext = { sessionId: 'sid-1' };

describe('tools/examples/echo', () => {
  it('echoes the message and uppercases when uppercase=true', async () => {
    const plain = await echoTool.handler({ message: 'hi' }, ctx);
    expect(plain.content[0]).toEqual({ type: 'text', text: 'hi' });
    expect(plain.structuredContent).toEqual({ echoed: 'hi', length: 2 });

    const upper = await echoTool.handler({ message: 'hi', uppercase: true }, ctx);
    expect(upper.content[0]).toEqual({ type: 'text', text: 'HI' });
    expect(upper.structuredContent).toEqual({ echoed: 'HI', length: 2 });
  });
});
