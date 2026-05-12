# `@mcp-toolkit/auth`

The pluggable auth surface: an `AuthStrategy` contract, seven shipped strategies (`none`, `apikey`, `bearer`, `custom`, `jwt`, `oidc`, `oauth`), and the OAuth 2.1 / OIDC Authorization Server flow code (discovery, authorize, callback, token, refresh, CIMD) that the `oidc` and `oauth` strategies mount. An `AuthStrategy` is an object with a `kind`, a `verify(request)` method, and optional `init()` / `mountAuthorizationServer(app)` hooks — operators pick one strategy per server and only that subpath's code ships in the bundle.

## `AuthStrategy` contract

```ts
interface AuthStrategy {
  readonly kind: AuthStrategyKind; // 'none' | 'apikey' | 'bearer' | 'custom' | 'jwt' | 'oidc' | 'oauth'
  init?(): Promise<void>;
  verify(
    req: Request,
    deps: { tokenStore?: TokenStore },
  ): Promise<AuthVerifyResult>;
  mountAuthorizationServer?(app: Hono): void;
  protectedResourceMetadata?(): {
    authorization_servers: string[];
    resource: string;
  } | null;
}

interface AuthVerifyResult {
  ok: boolean;
  identity?: SessionIdentity;
  provider?: ProviderTokens;
  resolvedHeaders: Record<string, string>;
  challenge?: {
    status: number;
    headers: Record<string, string>;
    body?: string;
  };
}
```

`ok: true` authorizes the request; `resolvedHeaders` is the set the dispatcher attaches to upstream API calls. `ok: false` returns a `challenge` (typically `401 WWW-Authenticate: Bearer …` with a JSON-RPC error body so MCP clients can still parse the response). `identity` and `provider` are populated by strategies that produce them.

## The 7 strategies

### `none`

No check — every request passes. Local dev, anonymous tools, or anything behind an IAP/reverse proxy that already authenticated.

Stateless. No AS endpoints. No token store.

```bash
AUTH='{"strategy":"none"}'
```

### `apikey`

Constant-time compare of a configured header against a shared secret. Quickest way to lock the server down for trusted clients with static credentials.

Stateless. No AS endpoints. No token store.

```bash
AUTH='{"strategy":"apikey"}'
AUTH_KEYS='{"apikey":{"key":"<long-random>","headerName":"x-api-key"}}'
```

`headerName` defaults to `x-api-key`. Constant-time compare is done with `TextEncoder` + bitwise XOR so the same code runs in Workers (`node:crypto.timingSafeEqual` is intentionally not used).

### `bearer`

Static `Authorization: Bearer …` token, constant-time compared. Same shape as `apikey` but pinned to the standard auth header.

Stateless. No AS endpoints. No token store.

```bash
AUTH='{"strategy":"bearer"}'
AUTH_KEYS='{"bearer":{"token":"<long-random>"}}'
```

### `custom`

Injects a fixed set of headers on every authorized request without any per-request check. For deployments behind a reverse proxy (Cloudflare Access, IAP, Tailscale serve) that already authenticated the caller.

Stateless. No AS endpoints. No token store. **Trusts the network** — boot-time warning fires outside `NODE_ENV=development`.

```bash
AUTH='{"strategy":"custom"}'
AUTH_KEYS='{"custom":{"headers":"x-cf-access-jwt-assertion:passthrough,x-tailscale-user:passthrough"}}'
```

Format: `name1:value1,name2:value2`. Use `value=passthrough` to forward the client-supplied header; use a literal to inject a fixed value. Only deploy behind a proxy that strips spoofed copies from external traffic.

### `jwt`

Verifies a Bearer JWT against a JWKS URL via `jose.jwtVerify`. The presented JWT IS the access token — no callback flow, no token-store mapping. Good fit for service-to-service callers (Auth0 M2M, GCP service-account ID tokens, CI-issued OIDC tokens).

Stateless on the request path. **Caches the JWKS in-memory** after the first fetch. No AS endpoints. No token store.

```bash
AUTH='{"strategy":"jwt"}'
AUTH_KEYS='{"jwt":{"jwksUrl":"https://your-idp.example/.well-known/jwks.json","issuer":"https://your-idp.example/","audience":"mcp-toolkit"}}'
```

`jwksUrl` is required; `issuer` and `audience` are optional but recommended. Identity is populated from the verified payload via `identityFromClaims`. Default clock tolerance: 60s.

### `oidc`

Full OAuth 2.1 + OIDC Authorization Server proxy in front of an upstream IdP. MCP clients discover the server via `/.well-known/oauth-protected-resource`, dynamically register, redirect through the IdP, and end up with an RS-issued Bearer that this strategy resolves back to provider tokens at call time.

**Stateful** (sessions + RS↔provider mappings). **Mounts AS endpoints.**
**Requires a token store.**

```bash
AUTH='{"strategy":"oidc","requireRs":true}'
AUTH_OAUTH='{
  "oauth":    { "clientAuth": "post", "scopes": "openid profile email", "redirectUri": "https://your-mcp.example/callback" },
  "oidc":     { "issuer": "https://oauth.id.jumpcloud.com/" },
  "provider": { "clientId": "<IdP client_id>", "clientSecret": "<IdP client_secret>" }
}'
STORAGE='{"tokensFile":".data/tokens.json","tokensEncKey":"<base64url 32-byte key>"}'
```

`requireRs: true` rejects raw upstream Bearers — clients must come through the AS flow. Identity is extracted from the persisted `id_token` via `extractIdentityFromProvider`.

### `oauth`

Same factory body as `oidc`, emitted with `kind: 'oauth'` so audit logs can distinguish non-OIDC OAuth 2 flows (no `id_token`, no `userinfo`). Usually paired with explicit `AUTH_OAUTH.oauth.authorizationUrl` / `tokenUrl` instead of OIDC discovery.

**Stateful. Mounts AS endpoints. Requires a token store.** Same env shape as `oidc`.

## Identity resolution

`SessionIdentity` (`sub`, `email`, `preferred_username`, `groups`, `memberOf`, `iss`, `aud`) lives in `@mcp-toolkit/core` so any package that touches `RequestContext` can refer to it without a back-edge import. Three helpers in `src/identity.ts` build and reconcile it:

- `identityFromClaims(payload)` — build identity from an already-verified JWT payload (used by `jwtStrategy` after `jwtVerify`). Normalizes `groups` / `memberOf` from arrays, comma-strings, or semicolon-strings.
- `extractIdentityFromProvider(provider)` — unverified decode of the stored `id_token` on a `ProviderTokens` / `ProviderInfo` record.
- `resolveIdentityForMcp(stored, provider)` — prefer the live `id_token` decode (catches rotated groups); fall back to the snapshot persisted on the session record; return `null` if neither yields claims.

Policy reads the resolved identity via `subjectFromContext`; the audit sink records it on every dispatched call.

## OAuth 2.1 / OIDC AS proxy

When `oidc` or `oauth` is selected, `mountAuthorizationServer(app)` mounts the following on a Hono app:

- `GET /authorize` — kicks off the flow, redirects to the IdP.
- `GET /oauth/callback` — IdP callback, exchanges code for tokens.
- `POST /token` — MCP client exchanges authorization code (PKCE) for an RS Bearer.
- `POST /revoke` — opaque-token revocation hook.
- `POST /register` — RFC 7591 dynamic client registration.
- `GET /.well-known/oauth-authorization-server` — AS metadata (mounted by transport-http; this strategy supplies the protected-resource side).

Notable internals (`src/oauth/`):

- **CIMD (SEP-991)** dynamic-client verification (`cimd.ts`) — fetches client metadata from the `client_id` URL, validates against the RFC 7591 schema. On by default; restrict reachable hosts via `AUTH_OAUTH.cimd.allowedDomains`. Disable with `cimd.enabled=false`.
- **SSRF guard** (`ssrf.ts`) — rejects discovery / CIMD URLs that resolve to loopback, link-local, or cloud-metadata addresses before the first `fetch`.
- **Token store mapping** — the RS Bearer is opaque; `getByRsAccess` pulls the matching upstream `ProviderTokens` record at verify time.
- **Encryption at rest** — `STORAGE.tokensEncKey` (base64url 32-byte key) feeds AES-GCM encryption for persisted provider tokens. Without it, refresh tokens land in cleartext and the worker logs a boot warning in production.
- **Refresh** (`refresh.ts`) — opportunistic refresh against the upstream token endpoint when a stored access token is within 60s of expiry.

## Adding a new strategy

1. Add the kind to `AUTH_STRATEGIES` in `src/config.ts` and `AuthStrategyKind` in `src/types.ts`.
2. Drop the factory in `src/strategies/<name>.ts` exporting an `AuthStrategy`.
3. Re-export it via a subpath in `packages/auth/package.json` so consumers tree-shake.
4. Add one case to the switch in `apps/server/src/compose.ts` — the `assertNever` exhaustiveness check fails to compile until you do.

## Subpath exports

```
@mcp-toolkit/auth                       # contract + identity helpers + AUTH_STRATEGIES
@mcp-toolkit/auth/apikey                # apiKeyStrategy, bearerStrategy, customHeadersStrategy
@mcp-toolkit/auth/jwt                   # jwtStrategy
@mcp-toolkit/auth/none                  # noneStrategy
@mcp-toolkit/auth/oidc                  # oidcStrategy (handles both 'oidc' and 'oauth' kinds)
@mcp-toolkit/auth/identity              # identityFromClaims, resolveIdentityForMcp, …
@mcp-toolkit/auth/config                # authConfigSchema, AuthConfig
@mcp-toolkit/auth/oauth/flow            # handleAuthorize, handleProviderCallback, handleToken
@mcp-toolkit/auth/oauth/endpoints       # handleRegister, handleRevoke
@mcp-toolkit/auth/oauth/discovery       # OIDC discovery wrapper
@mcp-toolkit/auth/oauth/discovery-handlers
@mcp-toolkit/auth/oauth/input-parsers
@mcp-toolkit/auth/oauth/refresh         # refreshProviderToken
@mcp-toolkit/auth/oauth/types
```

The root barrel exports only the contract types and identity helpers — strategy factories live behind subpaths so a server that selects `jwt` never pulls in OAuth flow code, and vice versa.

## Testing

```bash
bun test packages/auth
```

CIMD and SSRF have dedicated unit tests (`src/oauth/cimd.test.ts`, `src/oauth/ssrf.test.ts`). The end-to-end OIDC flow (authorize → callback → token → verify) is exercised by `apps/server/test/oidc-e2e.test.ts`; per-strategy verify() smoke tests live in `apps/server/test/strategies- {node,workers}.test.ts`.
