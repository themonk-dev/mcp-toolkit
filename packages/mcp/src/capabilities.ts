import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { PromptDefinition, ResourceDefinition, ToolDefinition } from './types.ts';

/**
 * Build the `serverCapabilities` advertised on `initialize` from the actual
 * registries the server was constructed with. Only advertise `tools` /
 * `prompts` / `resources` if at least one is registered — the SDK refuses to
 * service requests for capabilities that weren't advertised, so this keeps
 * "no prompts package installed" working without manual capability tweaking.
 *
 * `logging` and `experimental` are always advertised (they don't depend on a
 * registry and are no-cost to the client).
 */
export function buildCapabilities(opts: {
  tools?: ToolDefinition[];
  prompts?: PromptDefinition[];
  resources?: ResourceDefinition[];
}): ServerCapabilities {
  const caps: ServerCapabilities = {
    logging: {},
    experimental: {},
  };
  if (opts.tools && opts.tools.length > 0) {
    caps.tools = { listChanged: true };
  }
  if (opts.prompts && opts.prompts.length > 0) {
    caps.prompts = { listChanged: true };
  }
  if (opts.resources && opts.resources.length > 0) {
    caps.resources = { listChanged: true, subscribe: true };
  }
  return caps;
}
