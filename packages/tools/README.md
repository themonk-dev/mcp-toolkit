# `@mcp-toolkit/tools`

A tool registry surface plus three working examples (`echo`, `health`, `whoami`). The contract types live in `@mcp-toolkit/mcp`; this package re-exports them so authoring a tool is a single import.

## Define your own tool

```ts
import { defineTool } from '@mcp-toolkit/tools';
import { z } from 'zod';

export const pingTool = defineTool({
  name: 'ping',
  description: 'Reply with pong',
  inputSchema: z.object({}),
  handler: async (_args, _ctx) => ({
    content: [{ type: 'text', text: 'pong' }],
  }),
});
```

A `ToolDefinition` carries a name, description, Zod input schema, optional output schema, optional annotations, and a handler with signature `(args, ctx: ToolContext) => Promise<ToolResult>`. Tools are policy-agnostic; gating happens in `buildServer` before the handler runs.

## Bundled examples

* [`example-1-echo`](./examples/example-1-echo) — minimal input/output round trip.
* [`example-2-health`](./examples/example-2-health) — runtime-aware status check.
* [`example-3-whoami`](./examples/example-3-whoami) — reads `ctx.identity`.

## How to register

```ts
import { buildServer } from '@mcp-toolkit/mcp';
import { exampleTools } from '@mcp-toolkit/tools/examples';

const server = buildServer({
  name: 'my-server',
  version: '1.0.0',
  tools: exampleTools,
});
```

Mix and match: `tools: [...exampleTools, myTool]` is fine. Replace `exampleTools` entirely once you have your own production set.

## Env keys

The bundled examples consume no environment keys. See [`.env.example`](./.env.example) for the empty fragment to extend when your own tools need configuration; merge those keys into the server app's main `.env.example`.

## Testing your tool

Tools are framework-agnostic — the handler is just an async function. In a unit test you can call `myTool.handler(args, ctxStub)` directly with a hand-rolled `ToolContext` (only `sessionId` is required) and assert on the returned `ToolResult`. No MCP server, transport, or policy plumbing is needed for handler-level tests.
