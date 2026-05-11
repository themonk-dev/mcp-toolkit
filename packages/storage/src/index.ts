/**
 * @mcp-toolkit/storage — runtime-agnostic storage surface.
 *
 * Re-exports the public types and the in-memory store implementations. The
 * AES-GCM crypto helper is consumed only internally by the file / KV backends
 * and is intentionally NOT part of the public surface.
 *
 * Subpath-exports policy: the package root re-exports the runtime-agnostic
 * public surface. Subpath entries in `package.json#exports` are reserved
 * exclusively for modules that consumers MUST import by path because they
 * pin a specific runtime:
 *
 *   import { FileTokenStore }    from '@mcp-toolkit/storage/node/file';   // Node
 *   import { KvTokenStore, KvSessionStore }
 *                                from '@mcp-toolkit/storage/workers/kv';  // Workers
 *   import { storageConfigSchema } from '@mcp-toolkit/storage/config';     // nested config
 *
 * Do not add new subpath exports unless the module is runtime-pinned or
 * otherwise hostile to bundle-time tree-shaking from the root barrel.
 */

export * from './interface.ts';
export * from './memory.ts';
