# Example 4 — `statusResource` + `startStatusUpdates`

A subscribable resource demonstrating MCP's `notifications/resources/updated`
flow. The handler returns a snapshot of a mutable `serverStatus` record;
the optional `startStatusUpdates` lifecycle helper mutates that record on
an interval and fires a per-tick update notification.

## URI

`status://server`

## MIME type

`application/json`

## Env coupling

None at the resource level. The lifecycle helper takes the `McpServer`
instance as a parameter (no global, no `@mcp-toolkit/mcp` registry lookup).

## Two-file layout

- `resource.ts` — the `ResourceDefinition`, plus the shared mutable
  `serverStatus` record and an `incrementRequestCount()` helper for
  dispatcher-side instrumentation.
- `lifecycle.ts` — `startStatusUpdates(server)`, opt-in background updater
  that ticks every 10s. Returns a `() => void` cleanup; `compose.ts` calls
  it on shutdown so the interval doesn't dangle.

## Example fetch

```json
{ "method": "resources/read", "params": { "uri": "status://server" } }
```

```ts
import { buildServer } from '@mcp-toolkit/mcp';
import { exampleResources, startStatusUpdates } from '@mcp-toolkit/resources/examples';

const server = buildServer({ resources: exampleResources, /* ... */ });
const stopStatus = startStatusUpdates(server);
// on shutdown:
stopStatus();
```

## Policy note

Status leaks coarse health and request-rate signals. For internal use this
is benign; for an externally-exposed server, gate it under
`resources.status://server` and only allow operator groups. The simulated
random status in `lifecycle.ts` is for demos — replace with real metrics
from your dispatcher / middleware before relying on the values.
