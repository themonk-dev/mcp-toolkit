# `health`

Returns server status, current timestamp, and detected runtime
(`node` or `cloudflare-workers`). When `verbose` is set the Node-only
process info (uptime, version, heap usage) is added if available.
Demonstrates runtime detection without `node:*` imports.

## Schema

**Input**

| field     | type      | required | description                          |
| --------- | --------- | -------- | ------------------------------------ |
| `verbose` | `boolean` | no       | Include extra runtime details.       |

**Output (`structuredContent`)**

| field         | type     | description                          |
| ------------- | -------- | ------------------------------------ |
| `status`      | `string` | `"ok"` while the server is healthy.  |
| `timestamp`   | `number` | `Date.now()` at the time of the call. |
| `runtime`     | `string` | `"node"` or `"cloudflare-workers"`.  |
| `uptime`      | `number` | Process uptime, Node + verbose only. |

## Example call

```bash
curl -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": { "name": "health", "arguments": { "verbose": true } }
  }'
```

## Policy

Read-only and discloses no user data. Typically allowed for any
authenticated caller (`tools.health: allow`). Deny in deployments where
you want to keep runtime fingerprinting off the public surface.
