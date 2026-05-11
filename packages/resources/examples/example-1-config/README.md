# Example 1 — `configResource`

Exposes a JSON snapshot of the running server's environment, with sensitive
keys redacted. Useful as a smoke test for resource registration and as a way
to confirm a deployment picked up the right env without leaking secrets.

## URI

`config://server`

## MIME type

`application/json`

## Env coupling

This example uses the **thunk** approach: env is read at handler-call time
from `globalThis.process?.env` (Node / Bun) with a `globalThis.env` fallback
(Workers binding pattern). No factory injection, no compile-time config dep.
The host can swap env without re-registering the resource. Redaction is done
by `redactSensitiveData` from `@mcp-toolkit/core` (matches `*token*`, `*secret*`,
`*key*`, `*password*`, `*authorization*`, `*apikey*`, `*access_token*`,
`*refresh_token*` case-insensitively, recursively).

## Example fetch

```json
{ "method": "resources/read", "params": { "uri": "config://server" } }
```

```bash
curl -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"config://server"}}'
```

## Policy note

Even with redaction, this resource leaks the *shape* of your config (which
keys exist, which booleans are on). Gate it behind `resources.config://server`
in your policy for any deployment that isn't fully trusted. The resource is
read-only and side-effect free, so a default-allow rule is fine for internal
or development environments.
