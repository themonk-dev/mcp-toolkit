# `@mcp-toolkit/mcp`

The central package: server composer, runtime-agnostic JSON-RPC dispatcher, audit sink, and the contract types (`ToolDefinition`, `PromptDefinition`, `ResourceDefinition`, `ToolContext`, `AuditEvent`, `AuditSink`) every other package in the toolkit depends on.

## `buildServer({...})`

Composes the SDK's `McpServer` from registry arrays plus optional `auth` and `policy`. Capabilities are auto-derived from which registries are non-empty — pass empty `prompts`/`resources` and they are not advertised.

```ts
import { buildServer } from "@mcp-toolkit/mcp";
import { exampleTools } from "@mcp-toolkit/tools/examples";

const server = buildServer({
  name: "my-server",
  version: "1.0.0",
  tools: exampleTools,
  // prompts, resources, policy, auth, icons, getContext all optional
});
```

The builder owns every `server.registerTool/Prompt/Resource` call and installs policy-aware `*/list` handlers. Use it for the Node path where you hand the `McpServer` to the SDK's `StreamableHTTPServerTransport`.

## The dispatcher

```ts
import { dispatchMcpMethod, type McpDispatchContext } from "@mcp-toolkit/mcp";

const result = await dispatchMcpMethod(method, params, ctx, requestId);
```

Same JSON-RPC semantics as `buildServer`, but driven directly — no SDK transport, no per-session `McpServer`. The Workers transport uses this because Workers can't keep long-lived SDK objects across requests. Reach for `buildServer` when you have the SDK; reach for the dispatcher when you own the wire format yourself.

## Contract types

Re-exported from `./src/types.ts`:

- `ToolDefinition`, `ToolContext`, `ToolResult` — handler is `(args, ctx) => Promise<ToolResult>`. `ctx.identity` and `ctx.provider` are already resolved by auth.
- `PromptDefinition` — `argsSchema` (Zod) or `arguments` (advertise-only).
- `ResourceDefinition` — `uri`, `mimeType`, `handler(): { contents }`.
- `McpServerConfig` — `{ title, version, instructions?, icons? }` for the dispatcher's `initialize` response.
- `McpDispatchContext` — what you pass to `dispatchMcpMethod`: session, resolved auth, registries, optional `policy`, optional `audit`.

Authoring guides live in
[`packages/tools/README.md`](../tools/README.md),
[`packages/prompts/README.md`](../prompts/README.md), and
[`packages/resources/README.md`](../resources/README.md).

## Audit sink

Why it exists: EU AI Act Art. 12 record-keeping and GDPR data-subject requests want a tamper-evident, queryable record of every tool call and every catalog enumeration. The sink is the one seam where that record leaves the request path.

```ts
export interface AuditSink {
  emit(event: AuditEvent): void | Promise<void>;
  flush?(): Promise<void>;
}
```

`emit` is fire-and-forget — sinks must swallow their own errors so a broken log destination never takes down a tool call. `flush` is for buffered sinks at shutdown.

`AuditEvent` is a discriminated union on `kind`:

- `mcp.tool.call` — per-call record, `outcome: 'ok' | 'error' | 'denied' | 'cancelled'`, duration, redacted credential prefix, resolved subject (`sub` / `email` / sorted `groups`), policy-enforcement flag.
- `mcp.catalog.list` — snapshot for `tools/list`, `prompts/list`, `resources/list`: which methods were called, what was visible, policy state, ID-token claim presence (without leaking the claims themselves).

The default sink is `ConsoleAuditSink` — one NDJSON line per event via `console.log`. Workers-safe, no buffering, no flush:

```json
{
  "kind": "mcp.tool.call",
  "timestamp": "2026-05-11T12:00:00.000Z",
  "sessionId": "s_abc",
  "tool": "echo",
  "outcome": "ok",
  "durationMs": 3,
  "authStrategy": "apikey",
  "credentialPrefix": "rk_live_a1b2",
  "policyEnforced": false
}
```

Zero-config: `apps/server` builds a `ConsoleAuditSink` automatically unless the operator sets `AUDIT='{"enabled":false}'`. See [`apps/server/README.md`](../../apps/server/README.md) for env wiring.

Pluggable: ship to D1, KV, or an external HTTP endpoint by implementing the interface. Inject via `compose({ audit })` or directly on a hand-built `McpDispatchContext.audit`:

```ts
const ctx: McpDispatchContext = {
  sessionId,
  auth,
  config,
  registries,
  audit: new MyD1AuditSink(env.DB),
};
```

## Subpath exports

The root barrel re-exports the entire runtime-agnostic surface. Subpath entries in `package.json#exports` are reserved for modules consumers MUST import by path — currently the runtime-pinned ALS shims and the config module:

- `@mcp-toolkit/mcp/runtime/als-node` — Node only, pulls in `node:async_hooks`.
- `@mcp-toolkit/mcp/runtime/als-workers` — Workers stub.
- `@mcp-toolkit/mcp/config` — schema module for env validation.

Do not add new subpath exports unless the module is runtime-pinned or otherwise hostile to bundle-time tree-shaking from the root barrel.

## Testing

```bash
bun test packages/mcp
```

`audit-sink-console.test.ts` is the reference for testing structured events: it spies on `console.log`, emits an `AuditEvent`, parses the NDJSON line, and asserts on the discriminator + payload. Mirror it when you write a sink of your own.
