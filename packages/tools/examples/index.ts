import type { ToolDefinition } from '@mcp-toolkit/mcp';
import { echoTool } from './example-1-echo/tool.ts';
import { healthTool } from './example-2-health/tool.ts';
import { whoamiTool } from './example-3-whoami/tool.ts';

export { echoTool, healthTool, whoamiTool };

/**
 * The bundled example tools, ready to drop into `buildServer({ tools: exampleTools })`.
 * Replace or supplement with your own definitions for production.
 *
 * The cast is local to this file because `ToolDefinition<TShape>`'s handler
 * is contravariant in `TShape` — a `ToolDefinition<{message: ZodString}>` is
 * structurally narrower than `ToolDefinition<ZodRawShape>` even though it
 * satisfies the wider contract at runtime. Casting here keeps consumers
 * (compose.ts, tests) free of variance-bridging boilerplate.
 */
export const exampleTools = [
  echoTool,
  healthTool,
  whoamiTool,
] as unknown as ToolDefinition[];
