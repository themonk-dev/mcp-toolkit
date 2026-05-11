# Example 2 — `docsResource`

Returns a static markdown overview of the server. The simplest possible
resource — no env, no I/O, no runtime branching. Useful as a template when
your own resource is just "ship a known string at a stable URI".

## URI

`docs://overview`

## MIME type

`text/markdown`

## Env coupling

None. The body is a module-level template literal; the handler is a no-arg
async returning a single text content block. Swap the constant in
`resource.ts` for your own copy.

## Example fetch

```json
{ "method": "resources/read", "params": { "uri": "docs://overview" } }
```

```bash
curl -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"docs://overview"}}'
```

## Policy note

Pure-static documentation; safe to expose by default. Gate it under
`resources.docs://overview` if you need group-scoped help text variants —
but typically this is the resource you advertise to anonymous callers as a
discovery hint.
