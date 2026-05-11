/**
 * `@mcp-toolkit/resources` — public surface.
 *
 * The contract types live in `@mcp-toolkit/mcp`; this package re-exports them so
 * resource authors only need a single import. Bundled examples are exposed via
 * the `./examples` subpath (see `packages/resources/examples/index.ts`).
 */

export {
  defineResource,
  type ResourceContent,
  type ResourceDefinition,
} from '@mcp-toolkit/mcp';
