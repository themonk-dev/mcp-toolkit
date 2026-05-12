# mcp-toolkit

Modular, plug-and-play [Model Context Protocol](https://modelcontextprotocol.io) server. OIDC + JWT + API-key + no-auth strategies, optional policy filtering, structured audit for compliance, dual-runtime (Node + Cloudflare Workers).

```bash
git clone … && cd mcp-toolkit
bun install
cp apps/server/.env.example apps/server/.env
bun run dev
curl http://127.0.0.1:3000/health
```

That's it — a working MCP server with 3 example tools, 3 prompts, 5 resources, NDJSON audit on stdout. No auth, no policy. Edit `apps/server/.env` to add either.

## Layout

```
mcp-toolkit/
├── apps/server/                   # runnable app — composes everything
└── packages/
    ├── core/                      # types, logger, utils, http helpers
    ├── mcp/                       # server builder, dispatcher, audit sink
    ├── auth/                      # 7 strategies (none/apikey/bearer/custom/jwt/oidc/oauth)
    ├── policy/                    # YAML group-based catalog filter
    ├── storage/                   # token + session stores; AES-GCM
    ├── transport-http/            # Hono on Node, native fetch on Workers
    ├── tools/ prompts/ resources/ # contracts + 3+3+5 examples
    ├── proxy-tools/               # expose downstream MCP servers as tools
    └── mcp-client/                # outbound JSON-RPC client (used by proxy-tools)
```

## Configuration

Operators set 9 grouped JSON env vars. The full layout, worked examples per strategy, and runtime quirks live in [`apps/server/README.md`](apps/server/README.md). The minimum:

```bash
AUTH='{"strategy":"apikey"}'
AUTH_KEYS='{"apikey":{"key":"replace-me","headerName":"x-api-key"}}'
```

## Where to go next

| You want to…                                  | Read                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Run / deploy the server, see all env vars     | [`apps/server/README.md`](apps/server/README.md)                                                                                        |
| Pick an auth strategy, OAuth 2.1 / OIDC setup | [`packages/auth/README.md`](packages/auth/README.md)                                                                                    |
| Author tools / prompts / resources            | [`packages/tools/`](packages/tools/README.md) · [`prompts/`](packages/prompts/README.md) · [`resources/`](packages/resources/README.md) |
| Use the audit sink, build a custom sink       | [`packages/mcp/README.md`](packages/mcp/README.md)                                                                                      |
| Configure token / session storage, encryption | [`packages/storage/README.md`](packages/storage/README.md)                                                                              |
| Customize the HTTP transport, middleware      | [`packages/transport-http/README.md`](packages/transport-http/README.md)                                                                |
| Federate downstream MCP servers               | [`packages/proxy-tools/README.md`](packages/proxy-tools/README.md)                                                                      |

## Audit & compliance

Zero-config: `ConsoleAuditSink` emits one NDJSON event per `tools/call` (`outcome: ok|error|denied|cancelled`) and per `tools/list` / `prompts/list` / `resources/list`. Captures subject (`sub`/`email`/`groups`), policy decision, auth strategy, redacted credential prefix, duration. Pipe stdout to your retention collector for EU AI Act Art. 12 record-keeping and GDPR DSR. Opt out with `AUDIT='{"enabled":false}'`. Plug in a custom sink (D1 / KV / SIEM) by implementing the [`AuditSink`](packages/mcp/README.md#audit-sink) interface.

## Agent skills

Seven [agent skills](https://skills.sh) ship under [`.agents/skills/`](.agents/skills/), symlinked into [`.claude/skills/`](.claude/skills/) so Claude Code, Cursor, Gemini CLI, Amp, Cline, etc. auto-discover them. Restore on a fresh clone:

```bash
npx skills experimental_install
```

| Skill                                                               | When it loads                                        |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| `hono` · `workers-best-practices`                                   | Editing transport / `wrangler.toml`                  |
| `oauth-oidc-misconfiguration`                                       | Auditing redirect URI, PKCE, state, SSRF             |
| `d1-drizzle-schema`                                                 | Schema work in `packages/storage/src/node/sqlite.ts` |
| `requesting-` / `receiving-code-review` · `test-driven-development` | Day-to-day workflow                                  |

## Testing

```bash
bun test          # 333 tests across all packages + apps/server
bun run typecheck # strict TS check across all 11 packages
```

## Architecture decisions

- **No build step.** Bun + wrangler consume `.ts` directly. No tsup, no Turborepo.
- **Grouped JSON env vars** instead of flat keys. Validated by `appConfigSchema`.
- **Policy and audit are injected, never imported.** Registries depend on `@mcp-toolkit/mcp` only; the dispatcher receives `PolicyEnforcer` / `AuditSink` and threads them through.
- **AsyncLocalStorage isolated to one file** (`@mcp-toolkit/mcp/runtime/als-node`) — the only Workers-incompatible module. Workers entry imports a no-op stub.
- **AES-GCM via Web Crypto.** Same crypto runs in Node, Bun, and Workers.

## License

MIT.
