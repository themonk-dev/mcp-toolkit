# Example 3 — `logoResource` + `logoSvgResource`

Demonstrates both content modalities a `ResourceContent` block supports:
**binary** via the `blob` field (base64-encoded) and **text** via the
`text` field. Two resources, one folder, one source file — clients pick the
URI that matches their rendering pipeline.

## URIs and MIME types

| Export            | URI                  | MIME type       | Body field |
| ----------------- | -------------------- | --------------- | ---------- |
| `logoResource`    | `logo://server`      | `image/png`     | `blob`     |
| `logoSvgResource` | `logo://server/svg`  | `image/svg+xml` | `text`     |

## Env coupling

None. Both resources embed their bytes inline as module-level constants
(a 1x1 transparent PNG, a 100x100 SVG). For real assets, swap the constants
for a fetch from KV / R2 / a CDN — keep the handler shape the same.

## Example fetch

```json
{ "method": "resources/read", "params": { "uri": "logo://server" } }
```

```bash
curl -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"logo://server/svg"}}'
```

## Policy note

Pure-static branding assets; default-allow is reasonable. If you ship
multiple logo variants (light/dark, customer-specific) and want to gate
which a session sees, prefer one resource per variant under distinct URIs
and policy keys (`resources.logo://server/dark` etc.) over branching inside
the handler.
