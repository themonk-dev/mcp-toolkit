/**
 * `@mcp-toolkit/prompts` — public surface.
 *
 * The contract types live in `@mcp-toolkit/mcp`; this package re-exports them so
 * prompt authors only need a single import. Bundled examples are exposed via
 * the `./examples` subpath (see `packages/prompts/examples/index.ts`).
 */

export {
  definePrompt,
  type PromptArgument,
  type PromptDefinition,
  type PromptMessage,
  type PromptResult,
} from '@mcp-toolkit/mcp';
