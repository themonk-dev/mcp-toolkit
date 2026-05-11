/**
 * Storage package configuration schema.
 *
 * Nested slice of the app-level `AppConfig`. Operators set the grouped
 * `STORAGE` env var (JSON object); the app-level loader in
 * `apps/server/src/env-loader.ts` parses it and passes the inner shape to
 * this schema:
 *
 *   STORAGE='{"tokensFile":".data/tokens.json","tokensEncKey":"..."}'
 *
 * Runtime-agnostic — no `node:*` imports. The Node-only `FileTokenStore`
 * consumer in `./node/file.ts` reads `tokensFile` separately.
 */

import { optionalString } from '@mcp-toolkit/core/zod-helpers';
import { z } from 'zod';

export const storageConfigSchema = z.object({
  /** Path to the JSON file used by `FileTokenStore` (Node only). */
  tokensFile: z.string().default('.data/tokens.json'),
  /**
   * Base64url-encoded 32-byte key for AES-256-GCM token encryption.
   * Optional — when absent, tokens are stored in plaintext (a warning is
   * emitted in production).
   */
  tokensEncKey: optionalString,
});

export type StorageConfig = z.infer<typeof storageConfigSchema>;
