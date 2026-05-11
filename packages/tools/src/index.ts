/**
 * `@mcp-toolkit/tools` — public surface.
 *
 * The contract types live in `@mcp-toolkit/mcp`; this package re-exports them so
 * tool authors only need a single import. Bundled examples are exposed via
 * the `./examples` subpath (see `packages/tools/examples/index.ts`).
 */

export {
  defineTool,
  type ToolAnnotations,
  type ToolContentBlock,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from '@mcp-toolkit/mcp';
