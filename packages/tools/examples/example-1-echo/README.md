# `echo`

Echoes a message back to the caller, optionally upper-cased. The smallest
possible tool — useful as a smoke test for transport, registration, and
input validation.

## Schema

**Input**

| field       | type      | required | description                       |
| ----------- | --------- | -------- | --------------------------------- |
| `message`   | `string`  | yes      | Message to echo back (min len 1). |
| `uppercase` | `boolean` | no       | Convert to upper case.            |

**Output (`structuredContent`)**

| field    | type     | description                |
| -------- | -------- | -------------------------- |
| `echoed` | `string` | The (possibly upper-cased) message. |
| `length` | `number` | Length of `echoed`.        |

## Example call

```bash
curl -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": { "name": "echo", "arguments": { "message": "hi", "uppercase": true } }
  }'
```

## Policy

Read-only and side-effect-free; safe to expose to all groups. A minimal
allow rule (e.g. `tools.echo: allow`) is sufficient. Deny only if you want
to gate the smoke-test surface from anonymous callers.
