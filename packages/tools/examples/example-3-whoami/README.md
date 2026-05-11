# `whoami`

Returns the resolved identity attached to the current `ToolContext`.
Demonstrates identity-aware behaviour — handlers can branch on
`ctx.identity` to personalize output or short-circuit unauthenticated
calls.

## Schema

**Input**

(no arguments)

**Output (`structuredContent`)**

When unauthenticated:

| field           | type      | description |
| --------------- | --------- | ----------- |
| `authenticated` | `boolean` | `false`     |

When authenticated:

| field           | type       | description                              |
| --------------- | ---------- | ---------------------------------------- |
| `authenticated` | `boolean`  | `true`                                   |
| `sub`           | `string?`  | OIDC `sub` claim (subject identifier).   |
| `email`         | `string?`  | OIDC `email` claim, if present.          |
| `groups`        | `string[]` | Group claim from the id token.           |
| `memberOf`      | `string[]` | Alternate group claim (`memberOf`).      |

## Example call

```bash
curl -X POST http://localhost:8787/mcp \
  -H 'authorization: Bearer <id-token>' \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": { "name": "whoami", "arguments": {} }
  }'
```

## Policy

Reads identity but emits no external side effects. Common pattern is to
require authentication (`tools.whoami: require_auth`) so anonymous callers
see a denial rather than `{ authenticated: false }`. Adjust per group if
you want to hide membership data from low-trust callers.
