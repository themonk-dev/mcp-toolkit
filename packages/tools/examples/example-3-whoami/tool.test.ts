import { describe, expect, it } from 'bun:test';
import type { ToolContext } from '@mcp-toolkit/mcp';
import { whoamiTool } from './tool.ts';

describe('tools/examples/whoami', () => {
  it('returns authenticated=true with sub/email/groups when identity is present', async () => {
    const ctx: ToolContext = {
      sessionId: 'sid-1',
      identity: {
        sub: 'user-42',
        email: 'a@b.test',
        groups: ['eng'],
        memberOf: ['team-mcp'],
      },
    };
    const result = await whoamiTool.handler({}, ctx);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.authenticated).toBe(true);
    expect(sc.sub).toBe('user-42');
    expect(sc.email).toBe('a@b.test');
    expect(sc.groups).toEqual(['eng']);
    expect(sc.memberOf).toEqual(['team-mcp']);
  });

  it('returns authenticated=false when identity is missing', async () => {
    const ctx: ToolContext = { sessionId: 'sid-1' };
    const result = await whoamiTool.handler({}, ctx);
    expect(result.structuredContent).toEqual({ authenticated: false });
  });
});
