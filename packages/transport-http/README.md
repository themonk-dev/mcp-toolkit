# `@mcp-toolkit/transport-http`

Hono-based HTTP transport for MCP — one entry for Node, one for Cloudflare Workers, both routing JSON-RPC through the dispatcher in `@mcp-toolkit/mcp`.

## Node: `buildHttpApp(opts)`

Returns an unwrapped `Hono` app. The caller drops it into `@hono/node-server`'s `serve()` — this package never imports `@hono/node-server` itself, so the source tree stays Workers-safe.

```ts
import { buildHttpApp } from "@mcp-toolkit/transport-http/node";
import { serve } from "@hono/node-server";

const app = buildHttpApp({
  buildServer, // () => McpServer (one per session)
  auth, // AuthStrategy from @mcp-toolkit/auth
  sessionStore, // SessionStore from @mcp-toolkit/storage
  tokenStore, // optional — required for oidc
  audit, // optional AuditSink
  policy, // optional PolicyEnforcer
  registries, // optional — only consumed for audit catalog enumeration
  config, // BuildHttpAppConfig (nested slice of AppConfig)
});

serve({ fetch: app.fetch, port: 3000 });
```

`BuildHttpAppConfig` is a nested slice of the composed `AppConfig`:
`server.{nodeEnv,allowedOrigins,port}`, `mcp`, and the `auth` subset the transport actually reads (`strategy`, `apikey`, `discoveryUrl`, `oauth`, `oidc`, `cimd`, `provider`).

## Workers: `buildWorkersHandler(opts)`

Returns `{ fetch }` ready to be exported as the Worker default export. The Workers handler **bypasses the MCP SDK transport entirely** — it routes JSON-RPC straight through `dispatchMcpMethod`. No `node:*` imports anywhere under `src/workers/`.

```ts
import { buildWorkersHandler } from "@mcp-toolkit/transport-http/workers";

export default buildWorkersHandler({
  auth,
  sessionStore,
  tokenStore, // optional — gates OAuth AS routes
  registries: { tools, prompts, resources },
  policy, // optional
  audit, // optional
  config, // BuildWorkersHandlerConfig
});
```

`BuildWorkersHandlerConfig` mirrors the Node slice but threads the **full** `AuthConfig` (the Workers handler serves the OAuth AS routes from the same fetch handler instead of a separate port).

## Routing layout

| Method   | Path                                      | Notes                                       |
| -------- | ----------------------------------------- | ------------------------------------------- |
| `GET`    | `/health`                                 | unauthenticated                             |
| `GET`    | `/.well-known/oauth-protected-resource`   | also mounted at `/mcp/.well-known/...`      |
| `GET`    | `/.well-known/oauth-authorization-server` | also mounted at `/mcp/.well-known/...`      |
| `POST`   | `/mcp`                                    | JSON-RPC; auth + security middlewares apply |
| `GET`    | `/mcp`                                    | 405                                         |
| `DELETE` | `/mcp`                                    | session termination                         |

When `auth.strategy` is `oidc` or `oauth` (and a `tokenStore` is wired) the AS routes mount too: `/authorize`, `/oauth/callback`, `/token`, `/revoke`, `/register`.

**Node vs Workers placement.** On Node the AS routes mount as a **separate Hono app** (`buildOAuthServerApp`, exposed on `PORT+1` by the operator). On Workers everything is one `itty-router` instance on the same fetch handler.

## Middleware

Wired in this order on `/mcp`:

1. `requestLogger` — logs every inbound request before CORS / auth get a chance to reject it.
2. `corsMiddleware({ allowedOrigins, isDev })` — Origin-allowlist; dev relaxes to loopbacks.
3. `createAuthHeaderMiddleware({ strategy, tokenStore, requireAuth: true })` — invokes `strategy.verify(request)` and short-circuits 401s.
4. `createMcpSecurityMiddleware({ config })` — Origin / protocol-version / `Mcp-Session-Id` preflight (transport-layer hygiene only).

Each factory is exported and reusable; unit tests live in `src/middlewares/*.test.ts` and do not need a running server.

## Session lifecycle

`Mcp-Session-Id` header. A new session is created on `initialize`; it's bound to either the resolving apiKey or — for anonymous traffic — an `anon:<Origin>` bucket at create time. Every subsequent request's apiKey is checked against the original binding; a mismatch returns 401 with `session_credential_mismatch` (closes the session-takeover seam regardless of strategy). `DELETE /mcp` terminates the session.

## Audit hook

`audit?: AuditSink` flows through to the dispatcher. The Node route alsoemits `mcp.catalog.list` events pre-dispatch (the SDK transport doesn't surface the catalog path); Workers emits them from inside the dispatcher. Sink presence is the gate — no separate flag.

See `packages/mcp/README.md` for the `AuditSink` shape and event schema.

## Subpath exports

From `package.json`:

```
.               → src/index.ts            runtime-agnostic primitives only
./node          → src/node/index.ts       Node entry (pulls in Node ALS adapter)
./workers       → src/workers/index.ts    Workers-safe entry (no node:*)
./oauth-server  → src/oauth-server.ts     standalone AS Hono app for Node
```

Consumers building Workers bundles must import only from `@mcp-toolkit/transport-http/workers`. The root barrel is safe in either runtime but the `/node` entry transitively imports `@mcp-toolkit/mcp/runtime/als-node` (which uses `node:async_hooks`).

## Auth strategies

This package routes; it does not implement strategies. The strategy menu (`none` / `apikey` / `bearer` / `custom` / `jwt` / `oidc`) is documented in `packages/auth/README.md`. Operator env config lives in `apps/server/README.md`.

## Testing

```bash
bun test packages/transport-http
```

Middleware tests run the factories in isolation — no live server, no network, no fixtures.
