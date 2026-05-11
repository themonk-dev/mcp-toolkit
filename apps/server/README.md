# @mcp-toolkit/server

The runnable app. Composes auth + policy + tools + prompts + resources +
storage + transport into a Node server and a Cloudflare Workers handler.

## Quickstart

```bash
bun install
cp apps/server/.env.example apps/server/.env
bun run dev                       # http://127.0.0.1:3000
curl -s http://127.0.0.1:3000/health
```

Defaults: `AUTH.strategy="none"`, no policy, file-backed token storage at
`.data/tokens.json`. Dev-only — tighten before shipping.

## Configuration

Operators set 9 grouped JSON env vars (`SERVER`, `RUNTIME`, `AUTH`,
`AUTH_KEYS`, `AUTH_OAUTH`, `MCP`, `MCP_ICON`, `STORAGE`, `POLICY`). See
`.env.example` for the full layout with worked examples per strategy.

```bash
# Example: apikey strategy
AUTH='{"strategy":"apikey"}'
AUTH_KEYS='{"apikey":{"key":"replace-me","headerName":"x-api-key"}}'

# Example: enforce policy from a file (Node)
POLICY='{"path":"./policy/mcp-access.example.yaml"}'
```

## Auth strategies

| `AUTH.strategy` | Use when… | Required fields |
|---|---|---|
| `none` | local dev, anonymous tools | — |
| `apikey` | trusted clients, static creds | `AUTH_KEYS.apikey.key` |
| `bearer` | static Bearer token | `AUTH_KEYS.bearer.token` |
| `custom` | trusted-network header injection | `AUTH_KEYS.custom.headers` |
| `jwt` | pre-issued JWTs against a JWKS | `AUTH_KEYS.jwt.jwksUrl` |
| `oidc` | full OAuth 2.1 + OIDC, you own the AS | `AUTH_OAUTH.oidc.issuer` + `AUTH_OAUTH.provider.{clientId,clientSecret}` |

The strategy switch lives in `selectAuthStrategy()` (`src/compose.ts`). One
import + one branch to add a new strategy.

## Custom registries

Override the bundled examples with your own definitions:

```ts
import { compose } from './compose.ts';
import { myTool } from '@my-org/my-tools';

const runtime = await compose({
  config,
  tools: [myTool],   // replaces exampleTools
  // prompts / resources fall back to bundled examples when omitted
});
```

Contracts live in the per-domain package READMEs:
- `packages/tools/README.md` — `defineTool({ name, inputSchema, handler })`
- `packages/prompts/README.md` — `definePrompt({ name, handler })`
- `packages/resources/README.md` — `defineResource({ uri, handler })`

## Policy

Off by default. Enable via `POLICY.path` (Node only — reads YAML file) or
`POLICY.content` (any runtime — inline string).

```bash
POLICY='{"path":"./policy/mcp-access.example.yaml"}'
```

With `mode: enforce`, items without a matching allow rule are hidden
(default-deny). Schema lives in `packages/policy/src/schema.ts`; example
documents in `policy/`.

## Workers

```bash
bun run dev:worker        # wrangler dev
bun run deploy            # wrangler deploy
```

`wrangler.toml` should set:

- `main = "apps/server/src/worker.ts"`
- a `KVNamespace` binding named `TOKENS` (required for `oidc`; optional
  otherwise)
- optionally a `KVNamespace` binding named `SESSIONS` (falls back to
  in-memory)

`POLICY.path` is **not** supported on Workers — use `POLICY.content` inline.

## Testing

```bash
bun test apps/server/test/
```

Smoke tests (`test/smoke.test.ts`):

1. **apikey** — `tools/list` is gated by `x-api-key`; missing → 401, valid → 200.
2. **policy** — `mode: enforce` with an `echo` deny rule: `tools/list` hides
   `echo`; `tools/call name=echo` returns JSON-RPC `-32009`.
3. **OAuth-AS discovery** — `/.well-known/oauth-authorization-server` returns
   metadata pointing at the local proxy, even when `AUTH.strategy="none"`.

## Layout

```
apps/server/
├── src/
│   ├── config.ts         # appConfigSchema composition (no node:*)
│   ├── env-loader.ts     # JSON env vars → AppConfig (no node:*)
│   ├── env-node.ts       # Node entry: resolves POLICY.path via node:fs
│   ├── env-workers.ts    # Workers entry: rejects POLICY.path
│   ├── compose.ts        # the lego board (no node:*)
│   ├── main.ts           # Node bootstrap — @hono/node-server
│   └── worker.ts         # Workers bootstrap — default { fetch }
├── test/
└── .env.example
```

## Rules

- **No `node:*`** in `compose.ts`, `worker.ts`, `env-workers.ts`,
  `env-loader.ts`, `config.ts`. CI gate enforces it.
- **No `process.env`** in any package — everything flows through the
  zod-validated `AppConfig`.
