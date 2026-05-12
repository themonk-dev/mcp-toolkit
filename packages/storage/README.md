# `@mcp-toolkit/storage`

Two independent stores — **TokenStore** (RS Bearer ↔ upstream provider tokens, used only by `oidc`/`oauth` strategies) and **SessionStore** (MCP session state, used by every strategy) — plus an AES-GCM encryptor and runtime-pinned backends for Node, Workers, and SQLite.

## `TokenStore` contract

Maps the RS-issued Bearer that MCP clients carry back to the upstream provider tokens minted during the OAuth callback. Also holds short-lived PKCE transactions and authorization codes for the AS proxy.

```ts
interface TokenStore {
  storeRsMapping(rsAccess, provider, rsRefresh?): Promise<RsRecord>;
  getByRsAccess(rsAccess): Promise<RsRecord | null>;
  getByRsRefresh(rsRefresh): Promise<RsRecord | null>;
  updateByRsRefresh(
    rsRefresh,
    provider,
    maybeNewRsAccess?,
  ): Promise<RsRecord | null>;
  saveTransaction(txnId, txn, ttlSeconds?): Promise<void>;
  getTransaction(txnId): Promise<Transaction | null>;
  deleteTransaction(txnId): Promise<void>;
  saveCode(code, txnId, ttlSeconds?): Promise<void>;
  getTxnIdByCode(code): Promise<string | null>;
  deleteCode(code): Promise<void>;
}
```

`oidc` / `oauth` are the only strategies that write to this store. With
`apikey` / `bearer` / `jwt` / `custom` / `none` it stays idle, so you can skip
`STORAGE.tokensFile` and `STORAGE.tokensEncKey` entirely.

**Encryption split.** When `STORAGE.tokensEncKey` is set, persistent backends (`FileTokenStore`, `KvTokenStore`) round-trip every record through AES-GCM at rest — access tokens, refresh tokens, and id_tokens never touch disk or KV in cleartext. Without the key, records are written in plaintext and a boot warning is emitted in production (it does not block startup).

## `SessionStore` contract

Holds per-session MCP state, keyed by the `Mcp-Session-Id` header. Multi-tenant aware: each `SessionRecord` is bound to an `apiKey`, with a `MAX_SESSIONS_PER_API_KEY` limit (5) enforced via LRU eviction.

```ts
interface SessionStore {
  create(sessionId, apiKey): Promise<SessionRecord>;
  get(sessionId): Promise<SessionRecord | null>;
  update(sessionId, data: Partial<SessionRecord>): Promise<void>;
  delete(sessionId): Promise<void>;
  getByApiKey(apiKey): Promise<SessionRecord[]>;
  countByApiKey(apiKey): Promise<number>;
  deleteOldestByApiKey(apiKey): Promise<void>;
}
```

A `SessionRecord` carries the `apiKey` binding, optional `identity` snapshot (`sub`, `email`, `groups`, `memberOf`, `iss`, `aud` — derived from validated id_token claims), `protocolVersion`, `initialized` flag, and a provider-token snapshot for OIDC flows.

## Default stores per runtime

| Runtime       | Tokens                                                                 | Sessions                                                                       |
| ------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Node          | `MemoryTokenStore` (swap to `FileTokenStore` via `STORAGE.tokensFile`) | `MemorySessionStore`                                                           |
| Node + SQLite | as above                                                               | `SqliteSessionStore` (opt-in)                                                  |
| Workers       | `KvTokenStore` (requires `TOKENS` KV binding)                          | `MemorySessionStore` in-isolate, or `KvSessionStore` if you bind `SESSIONS` KV |

Swap the session store at compose time:

```ts
import { SqliteSessionStore } from "@mcp-toolkit/storage/node/sqlite";

const runtime = await compose({
  config,
  sessionStore: new SqliteSessionStore("./.data/sessions.db"),
});
```

`SqliteSessionStore` uses `better-sqlite3` (an `optionalDependency`) and Drizzle ORM. WAL mode is on by default; sessions table self-migrates on first run.

## AES-GCM crypto

```ts
import { createEncryptor, generateKey } from "@mcp-toolkit/storage/crypto";

const enc = createEncryptor(process.env.STORAGE_TOKENS_ENC_KEY!);
const ciphertext = await enc.encrypt("hello");
const plaintext = await enc.decrypt(ciphertext);
```

Uses `crypto.subtle` (Web Crypto), so the same code runs in Node, Bun, and Workers — no `node:crypto`. Key format is **base64url-encoded 32 bytes** (256 bits); anything else throws at construction. Generate one:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Forgetting `tokensEncKey` in production logs a boot warning but does not block startup. The format is `base64url(iv || ciphertext)` with a 96-bit IV and 128-bit auth tag.

## Subpath exports

From `package.json#exports`:

| Subpath                            | Contents                                               | Runtime                            |
| ---------------------------------- | ------------------------------------------------------ | ---------------------------------- |
| `@mcp-toolkit/storage`             | contracts + `MemoryTokenStore` + `MemorySessionStore`  | any                                |
| `@mcp-toolkit/storage/node/file`   | `FileTokenStore`                                       | Node only (`node:fs`, `node:path`) |
| `@mcp-toolkit/storage/node/sqlite` | `SqliteSessionStore`, Drizzle schema                   | Node only (`better-sqlite3`)       |
| `@mcp-toolkit/storage/workers/kv`  | `KvTokenStore`, `KvSessionStore`                       | any (KV namespace duck-typed)      |
| `@mcp-toolkit/storage/crypto`      | `createEncryptor`, `encrypt`, `decrypt`, `generateKey` | any                                |
| `@mcp-toolkit/storage/config`      | `storageConfigSchema` (Zod)                            | any                                |

**Workers safety.** The Workers entry imports only the root barrel plus `/workers/kv`, `/crypto`, and `/config`. No `node:`\* ever reaches the bundle.

## Operator config

`STORAGE` is a grouped JSON env var validated by `storageConfigSchema`:

```bash
STORAGE='{"tokensFile":".data/tokens.json","tokensEncKey":"<base64url 32-byte key>"}'
```

The full layout with per-strategy examples lives in `[apps/server/.env.example](../../apps/server/.env.example)` — see also `[apps/server/README.md](../../apps/server/README.md)` for the configuration walkthrough.
