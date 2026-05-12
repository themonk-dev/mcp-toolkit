# `@mcp-toolkit/resources`

## What this is

A thin package that re-exports the resource contract types from `@mcp-toolkit/mcp` (`ResourceDefinition`, `ResourceContent`, `defineResource`) and ships four runtime-agnostic example resources. SDK registration, policy gating, and subscription wiring live in `@mcp-toolkit/mcp`'s `buildServer` — this package only produces `ResourceDefinition` instances. No `node:*` imports, so the examples run unchanged in Cloudflare Workers as well as Node.

## Define your own resource

```ts
import { defineResource } from "@mcp-toolkit/resources";

export const myResource = defineResource({
  uri: "my://thing",
  name: "My Thing",
  description: "A short description shown in resource catalogs",
  mimeType: "application/json",
  handler: async () => ({
    contents: [
      { uri: "my://thing", mimeType: "application/json", text: '{"ok":true}' },
    ],
  }),
});
```

## Bundled examples

- **`configResource`** (`examples/example-1-config/`) — redacted env snapshot at `config://server`.
- **`docsResource`** (`examples/example-2-docs/`) — static markdown overview at `docs://overview`.
- **`logoResource` + `logoSvgResource`** (`examples/example-3-logo/`) — both PNG (`blob`) and SVG (`text`) variants in one folder.
- **`statusResource`** (`examples/example-4-status/`) — subscribable status at `status://server`; opt-in `startStatusUpdates(server)` lifecycle helper fires update notifications.

Each folder has its own README with URI, MIME type, an example fetch, and a one-paragraph policy note.

## How to register

```ts
import { buildServer } from "@mcp-toolkit/mcp";
import {
  exampleResources,
  startStatusUpdates,
} from "@mcp-toolkit/resources/examples";

const server = buildServer({
  // ...tools, prompts, auth, env...
  resources: exampleResources,
});

// Optional: enable the status background updater. The returned cleanup
// must be called on shutdown so the interval doesn't dangle.
const stopStatus = startStatusUpdates(server);
```

Mix and match: `resources: [...exampleResources, myResource]` is fine.

## Env keys

The bundled `configResource` reads whatever `process.env` / `globalThis.env` exposes at handler-call time — typically `MCP_TITLE` / `MCP_VERSION` (defined in `@mcp-toolkit/mcp/env`) plus any keys your host attaches. The other three examples read no env. See [`.env.example`](./.env.example) for the empty fragment to extend when your own resources need configuration.

## Testing your resource

A `ResourceDefinition`'s handler is a plain async function — call it directly:

```ts
import { docsResource } from "@mcp-toolkit/resources/examples";

const result = await docsResource.handler();
console.log(result.contents[0].text);
```

No SDK, no transport, no server required. Policy gating is applied by `buildServer` before the handler runs, so handler-level tests need not stub policy.
