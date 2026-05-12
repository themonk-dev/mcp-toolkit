# `@mcp-toolkit/proxy-tools`

Exposes each downstream MCP server listed in `CONNECTED_SERVERS` as one upstream `ToolDefinition`, so a single gateway can federate several MCP servers — or wrap one — behind a shared auth / policy / audit layer.

## `CONNECTED_SERVERS`

One operator-facing env var: a JSON array, one entry per downstream server. Each entry is a discriminated union on `authType`:

```bash
CONNECTED_SERVERS='[
  {"id":"linear","url":"https://mcp.linear.app/mcp","authType":"bearer","token":"lin_..."},
  {"id":"weather","url":"https://weather.example.com/mcp","authType":"api_key","headerName":"x-api-key","key":"..."}
]'
```

Supported `authType` values: `none`, `api_key` (`{ headerName, key }`), `bearer` (`{ token }`). `id` must be lowercase `[a-z0-9_-]+` and unique across the array; duplicates and empty secrets fail at boot with a path-prefixed zod error (e.g. `connectedServers.0.token: ...`). OAuth2 is intentionally unsupported until discovery / DCR / refresh lands.

The definitive schema is `connectedServersSchema` in [`src/config.ts`](./src/config.ts).

## `buildProxyTools`

The factory takes the validated servers, a `CredentialResolver`, and an `OutboundMcpClient`, and returns one `ToolDefinition` per server, ready to merge with local tools:

```ts
import {
  buildProxyTools,
  EnvCredentialResolver,
} from "@mcp-toolkit/proxy-tools";
import { OutboundMcpClient } from "@mcp-toolkit/mcp-client";

const proxyTools = buildProxyTools({
  servers: config.connectedServers,
  resolver: new EnvCredentialResolver(config.connectedServers),
  client: new OutboundMcpClient(
    { clientInfo: { name: config.mcp.title, version: config.mcp.version } },
    { fetch: opts.outboundFetch },
  ),
});
const tools = [...localTools, ...proxyTools];
```

This is the exact wiring used in `apps/server/src/compose.ts`. Each proxy tool's `inputSchema` is `{ action, args }`: `action` is the downstream tool name; `args` is forwarded verbatim. Calling with the reserved `action: "__list_actions__"` returns the downstream catalog without forwarding.

## `EnvCredentialResolver`

Default resolver. Builds an in-memory `Map<serverId, Credential>` from the parsed `connectedServers` array — the credential fields come directly from each entry (`token`, `headerName + key`, or nothing for `none`). There is no extra env-var indirection: the env loader parses `CONNECTED_SERVERS` once, zod validates it, and the resolver reads from the resulting objects. Future stores (sealed vault, OAuth2 token cache) implement the `CredentialResolver` interface without touching the factory.

## Outbound transport

`OutboundMcpClient` lives in `@mcp-toolkit/mcp-client` — import it from there. Proxy-tools treats it as stateless: the factory closes over one client and per-server `OutboundSession`s, lazily initializing each session on first use and caching the downstream `tools/list` for 5 minutes (override with `toolsCacheTtlMs`). `fetch` is injectable via the client's second constructor arg, which is what the tests use to stub HTTP without a network.

## Name collisions

The proxy tool's `name` is the server `id`. `compose.ts` fails fast at boot if a server `id` collides with a local tool name — pick non- colliding ids (e.g. don't name a server `echo` if you ship the example echo tool).

## Testing

```bash
bun test packages/proxy-tools
```

`src/factory.test.ts` is the reference for stubbing: build a recording `fetch`, pass it to `new OutboundMcpClient({...}, { fetch })`, and exercise the returned `ToolDefinition`'s `handler` directly.
