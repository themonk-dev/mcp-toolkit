import { defineTool } from '@mcp-toolkit/mcp';
import { z } from 'zod';

/**
 * `whoami` — returns the authenticated identity snapshot from `ToolContext`.
 * When no identity is attached the tool reports `{ authenticated: false }`.
 */
export const whoamiTool = defineTool({
  name: 'whoami',
  title: 'Who Am I',
  description: 'Return the resolved identity for the current session',
  inputSchema: z.object({}),
  annotations: {
    title: 'Who Am I',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (_args, ctx) => {
    const id = ctx.identity;
    const result: Record<string, unknown> = id
      ? {
          authenticated: true,
          sub: id.sub,
          email: id.email,
          groups: id.groups ?? [],
          memberOf: id.memberOf ?? [],
        }
      : { authenticated: false };

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
});
