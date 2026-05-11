# mcp-toolkit

Modular, plug-and-play [Model Context Protocol](https://modelcontextprotocol.io) server.
OIDC + JWT + API-key + no-auth strategies, optional policy filtering, dual-runtime (Node + Cloudflare Workers).

```bash
git clone … && cd mcp-toolkit
bun install
cp apps/server/.env.example apps/server/.env
bun run dev
curl http://127.0.0.1:3000/health
```

That's it — a working MCP server with 3 example tools, 3 prompts, 5 resources.
No auth, no policy. Edit `apps/server/.env` to add either.

## Layout

```
mcp-toolkit/
├── apps/
│   └── server/                  # @mcp-toolkit/server — runnable app (composes everything)
└── packages/
    ├── core/                    # types, logger, utils, http helpers, zod helpers
    ├── mcp/                     # server builder, dispatcher, ALS subpaths
    ├── auth/                    # AuthStrategy contract + OIDC/JWT/APIKey/None
    ├── policy/                  # engine, schema, glob, subject builder
    ├── storage/                 # file/memory/kv + AES-GCM
    ├── transport-http/          # Hono + Workers adapters
    ├── tools/                   # ToolDefinition + 3 examples
    ├── prompts/                 # PromptDefinition + 3 examples
    └── resources/               # ResourceDefinition + 4 examples
```

Each package has its own README. Operator config lives in `apps/server/.env.example`.

## Configuration

Operators set 9 grouped JSON env vars. See `apps/server/.env.example` for the full layout + worked examples per strategy.

```bash
SERVER='{"host":"127.0.0.1","port":3000,"allowedOrigins":[]}'
RUNTIME='{"nodeEnv":"production","logLevel":"info"}'
AUTH='{"strategy":"apikey"}'
AUTH_KEYS='{"apikey":{"key":"replace-me","headerName":"x-api-key"}}'
MCP='{"title":"My Server","version":"1.0.0","protocolVersion":"2025-06-18"}'
STORAGE='{"tokensFile":".data/tokens.json"}'
POLICY='{"path":"./policy/mcp-access.example.yaml"}'
```

The loader parses each var, validates via `appConfigSchema`, and yields a typed `AppConfig`. No flat env keys are read.

## The lego board

`apps/server/src/compose.ts` wires everything. Swap any piece in one line:

```ts
const auth = selectAuthStrategy(config, tokenStore); // 1 of 6 strategies
const policy = getPolicyEngine({ content: config.policy.content }); // null = off
const server = buildServer({
  name: config.mcp.title,
  version: config.mcp.version,
  auth,
  policy: policy ?? undefined,
  tools: exampleTools, // or [...your own]
  prompts: examplePrompts, // optional
  resources: exampleResources, // optional
});
```

`buildServer` only advertises capabilities for slots you populate.

## Auth strategies — plug and play

Every strategy reduces to "set `AUTH.strategy=<name>` and fill the matching block". Strategy ships as a tree-shaken subpath of `@mcp-toolkit/auth`; the [`compose.ts`](apps/server/src/compose.ts) selector is a single switch. Picking one strategy never reads the other strategies' fields, so unused blocks can stay empty.

| Strategy | What it does                                                                                 | Stateful?                  | Mounts AS endpoints? | Token-store needed? |
| -------- | -------------------------------------------------------------------------------------------- | -------------------------- | -------------------- | ------------------- |
| `none`   | No check — anyone in                                                                         | no                         | no                   | no                  |
| `apikey` | Compares a header against a shared secret                                                    | no                         | no                   | no                  |
| `bearer` | Compares `Authorization: Bearer …` to a token                                                | no                         | no                   | no                  |
| `custom` | Trusts arbitrary upstream-injected headers                                                   | no                         | no                   | no                  |
| `jwt`    | Verifies a signed JWT against a JWKS URL                                                     | no\*                       | no                   | no                  |
| `oidc`   | Full OAuth 2.1 + PKCE AS proxy in front of an IdP                                            | yes (sessions + RS tokens) | yes                  | **yes**             |
| `oauth`  | Same wiring as `oidc` but emits `kind: 'oauth'` in audit (use for non-OIDC OAuth2 providers) | yes                        | yes                  | **yes**             |

\* JWT caches the JWKS in-memory after first fetch.

All the strategies below assume the default `apps/server/.env` layout. The full env shape lives in [`apps/server/.env.example`](apps/server/.env.example) — the snippets here are only the lines that differ per strategy.

### `none` — anonymous (default)

Local dev, public read-only servers, anything behind an IAP that already authenticates.

```bash
AUTH='{"strategy":"none"}'
```

No other vars are read. Identity surfaces as `anonymous`; rate limits apply per `Origin` header (so non-browser callers like `curl` share one bucket — put a real auth in front for prod).

### `apikey` — single shared secret

The quickest way to lock the server down. One header, one value, constant-time compare.

```bash
AUTH='{"strategy":"apikey"}'
AUTH_KEYS='{"apikey":{"key":"<long-random>","headerName":"x-api-key"}}'
```

Clients send `x-api-key: <long-random>`. Change `headerName` to match an existing header convention (e.g. `authorization`) if you need to.

### `bearer` — static Bearer token

Same idea as `apikey`, but specifically `Authorization: Bearer …`.

```bash
AUTH='{"strategy":"bearer"}'
AUTH_KEYS='{"bearer":{"token":"<long-random>"}}'
```

### `custom` — trust upstream-injected headers

For setups where a reverse proxy (Cloudflare Access, IAP, Tailscale serve, an internal sidecar) has already authenticated the caller and injects identity headers. The server just forwards them to downstream tools.

```bash
AUTH='{"strategy":"custom"}'
AUTH_KEYS='{"custom":{"headers":"x-cf-access-jwt-assertion:passthrough,x-tailscale-user:passthrough"}}'
```

Format is `name1:value1,name2:value2`. Use `value=passthrough` to forward whatever the client sent (typical reverse-proxy case); use a literal value to inject a fixed header. **This strategy explicitly trusts the network** — only use it behind a proxy that strips spoofed copies of those headers from external traffic. The server logs a boot warning in non-dev environments to remind you.

### `jwt` — verify a third-party JWT against a JWKS

Stateless, no callback flow. Good fit for service-to-service when the caller can already mint a JWT (Auth0 M2M, GCP service-account ID tokens, a CI-issued OIDC token, Cognito client credentials, etc.).

```bash
AUTH='{"strategy":"jwt"}'
AUTH_KEYS='{"jwt":{"jwksUrl":"https://your-idp.example/.well-known/jwks.json","issuer":"https://your-idp.example/","audience":"mcp-toolkit"}}'
```

`jwksUrl` is required. `issuer` and `audience` are optional but recommended — if you set them the strategy enforces `iss` / `aud` match. Identity is populated from standard claims (`sub`, `email`, `groups`, etc.) via `identityFromClaims`, so policy can match groups out of the box.

### `oidc` — full OAuth 2.1 + PKCE Authorization Server proxy

The big one. The server itself becomes an OAuth 2.1 Authorization Server in front of an upstream OIDC provider. MCP clients that speak OAuth (Claude Desktop, Cursor, mcp-inspector with auth, etc.) discover it via `/.well-known/oauth-protected-resource`, dynamically register, redirect through your IdP, and end up with an RS-issued Bearer that the server resolves back to provider tokens at call time.

```bash
AUTH='{"strategy":"oidc","requireRs":true}'
AUTH_OAUTH='{
  "oauth":    { "clientAuth": "post", "scopes": "openid profile email", "redirectUri": "https://your-mcp.example/callback" },
  "oidc":     { "issuer": "https://oauth.id.jumpcloud.com/" },
  "provider": { "clientId": "<IdP client_id>", "clientSecret": "<IdP client_secret>" }
}'
STORAGE='{"tokensFile":".data/tokens.json","tokensEncKey":"<base64url 32-byte key>"}'
```

What gets enabled when you pick this strategy:

- **Mounted endpoints**: `/authorize`, `/oauth/callback`, `/token`, `/revoke`, `/register`, plus `/.well-known/oauth-authorization-server`. On **Node** these run on `PORT+1` as a separate Hono app (so e.g. MCP on `:3000`, AS on `:3001`). On **Workers** they mount on the same router as MCP — workers can't bind multiple ports.
- **Discovery shim** at `/.well-known/oauth-protected-resource` so MCP clients find the AS. Override the advertised resource URI via `AUTH.resourceUri`; override the AS URL via `AUTH.discoveryUrl`.
- **Token store** (`STORAGE.tokensFile` on Node, `TOKENS` KV binding on Workers) holds the mapping from the RS-issued Bearer back to the upstream provider tokens. **Set `STORAGE.tokensEncKey`** — without it the store writes provider refresh tokens in cleartext, and the worker logs a boot warning in production.
- **CIMD (SEP-991)** dynamic-client verification is on by default. Configure `AUTH_OAUTH.cimd.allowedDomains` to restrict which discovery URLs are reachable. Set `AUTH_OAUTH.cimd.enabled=false` to disable.
- **Issuer SSRF guard** rejects discovery URLs that resolve to loopback, link-local, or cloud-metadata addresses before the first `fetch`.

`requireRs: true` rejects raw upstream Bearers — clients must come through the AS flow. Set it to `false` if you also want to accept pre-issued upstream tokens directly.

### `oauth` — non-OIDC OAuth2 provider

Same wiring as `oidc` but the strategy reports `kind: 'oauth'` so audit logs can distinguish flows that didn't traverse OpenID. Use it when your IdP only speaks OAuth2 (no `id_token`, no `userinfo`). Same env shape; usually you'll set `AUTH_OAUTH.oauth.authorizationUrl` and `tokenUrl` directly instead of relying on OIDC discovery.

---

### Storage implications

There are two independent stores: **token store** (RS Bearer → upstream provider tokens, only used by `oidc` / `oauth`) and **session store** (MCP session state).

| Runtime            | Default                                   | How to switch                                                                                                                                         |
| ------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node               | `MemoryTokenStore` + `MemorySessionStore` | Set `STORAGE.tokensFile` to persist tokens; `tokensEncKey` to encrypt them at rest.                                                                   |
| Node (SQLite)      | opt-in for sessions                       | `import { SqliteSessionStore } from '@mcp-toolkit/storage/node/sqlite'` and pass via `compose({ sessionStore })`.                                         |
| Cloudflare Workers | `KvTokenStore` + in-isolate sessions      | Bind `TOKENS` KV in `wrangler.toml`; encryption keyed by `STORAGE.tokensEncKey`. Optionally bind `SESSIONS` KV for cross-isolate session consistency. |

Only `oidc` / `oauth` actually write to the token store — the other strategies leave it idle. So if you're on `jwt` / `apikey` / `bearer` / `custom` / `none`, you can skip `tokensFile` and `tokensEncKey` entirely.

### Where to wire a brand-new strategy

1. Add the kind to `AUTH_STRATEGIES` in [`packages/auth/src/config.ts`](packages/auth/src/config.ts) and `AuthStrategyKind` in `types.ts`.
2. Drop the factory in `packages/auth/src/strategies/<name>.ts` exporting an `AuthStrategy`.
3. Re-export it via a subpath in `packages/auth/package.json` so consumers tree-shake.
4. Add one case to the switch in [`apps/server/src/compose.ts`](apps/server/src/compose.ts) — the exhaustiveness check (`assertNever`) will fail to compile until you do.

## Policy

Optional. Filter the catalog and gate `tools/call` by group membership.

```yaml
# policy/example.yaml
version: 1
mode: enforce
tools:
  - name: echo
    allow_groups: ["developers"]
    deny_groups: ["interns"]
```

Enable with `POLICY='{"path":"./policy/example.yaml"}'` (Node) or `POLICY='{"content":"<inline YAML>"}'` (any runtime). With `mode: enforce`, items without a matching allow rule are denied (default-deny). Tool calls that fail policy return JSON-RPC `-32009`.

## Add a tool / prompt / resource

```ts
import { defineTool } from "@mcp-toolkit/mcp";
import { z } from "zod";

export const myTool = defineTool({
  name: "my_tool",
  description: "Does the thing",
  inputSchema: z.object({ input: z.string() }),
  handler: async ({ input }, ctx) => ({
    content: [{ type: "text", text: `got: ${input}` }],
  }),
});
```

Pass `[myTool]` into `compose({ config, tools: [myTool] })`. Same pattern for `definePrompt` / `defineResource`. See `packages/{tools,prompts,resources}/README.md` for the contracts.

## Cloudflare Workers

```bash
cp wrangler.example.toml wrangler.toml      # set KV namespace IDs + secrets
wrangler kv:namespace create TOKENS
bun run dev:worker
bun run deploy
```

The Workers bundle pulls in **zero `node:*` imports**. Node-only pieces live behind subpath exports (`@gov mcp/storage/node/file`, `@mcp-toolkit/mcp/runtime/als-node`) that the Workers entry never imports.

## Agent skills

This repo ships seven [agent skills](https://skills.sh) scoped to the technologies it uses. They live in [`.agents/skills/`](.agents/skills/) and are symlinked into [`.claude/skills/`](.claude/skills/) so Claude Code (and other compatible CLIs — Cursor, Gemini CLI, Amp, Cline, etc.) auto-discover them.

| Skill                         | Source                              | When it loads                                                                                                                                                                            |
| ----------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hono`                        | yusukebe/hono-skill (Hono's author) | Touching `@mcp-toolkit/transport-http` or any Hono app/middleware.                                                                                                                           |
| `workers-best-practices`      | cloudflare/skills (official)        | Editing `apps/server/src/worker.ts`, `wrangler.toml`, KV usage.                                                                                                                          |
| `oauth-oidc-misconfiguration` | yaklang/hack-skills                 | Auditing redirect URI, PKCE, state/nonce, SSRF, token binding.                                                                                                                           |
| `d1-drizzle-schema`           | jezweb/claude-skills                | Schema work in `packages/storage/src/node/sqlite.ts`. Mostly D1-flavoured — 60% transfers to better-sqlite3, treat D1-specific advice (100-param limit, single-writer) as informational. |
| `requesting-code-review`      | obra/superpowers                    | Asking another agent / reviewer to look at your branch.                                                                                                                                  |
| `receiving-code-review`       | obra/superpowers                    | Acting on review feedback.                                                                                                                                                               |
| `test-driven-development`     | obra/superpowers                    | Writing new features test-first — fits this repo's coverage target.                                                                                                                      |

Skills install on `bun install` is not automatic — they're tracked in [`skills-lock.json`](skills-lock.json). To restore them on a fresh clone:

```bash
npx skills experimental_install
```

Add or remove a skill:

```bash
npx skills add <owner/repo@skill>   # project-scoped by default
npx skills remove <skill>
```

`.claude/settings.local.json`, runtime caches, and `projects/` stay gitignored — only shared workflow context is committed.

## Testing

```bash
bun test                    # 235 tests across all packages + apps/server
bun run typecheck           # strict TS check across all 10 packages
```

## Architecture decisions

- **No build step.** Bun + wrangler consume `.ts` directly. No `tsup`, no Turborepo, no emitted `.d.ts`.
- **Grouped JSON env vars** instead of flat keys. Per-domain JSON blobs parsed by `apps/server/src/env-loader.ts`, validated by `appConfigSchema`.
- **Policy is injected, never imported.** Tools / prompts / resources packages don't depend on `@mcp-toolkit/policy`. The dispatcher receives a `PolicyEnforcer` and threads it through.
- **AsyncLocalStorage isolated to one file.** `@mcp-toolkit/mcp/runtime/als-node` is the only Workers-incompatible module; the Workers entry imports its no-op stub instead.
- **AES-GCM with Web Crypto.** Token storage encryption uses `crypto.subtle`, not `node:crypto` — same code runs in Node, Bun, and Workers.

## License

MIT.
