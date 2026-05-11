/**
 * App-level config composition.
 *
 * Each `@mcp-toolkit/*` package owns a nested zod schema for its slice
 * (`authConfigSchema`, `mcpConfigSchema`, …). This file composes them
 * into the single canonical `appConfigSchema` and adds the runtime-only
 * `server` slice (host, port, NODE_ENV, …).
 *
 * The canonical app-level type. Consumers read nested paths
 * (`config.auth.apikey.key`, not `env.API_KEY`).
 *
 * **Strictly no `node:*` imports.** Both Node and Workers entries import
 * this module; runtime-specific concerns live in `env-node.ts` /
 * `env-workers.ts`.
 */

import { authConfigSchema } from '@mcp-toolkit/auth/config';
import { stringList } from '@mcp-toolkit/core/zod-helpers';
import { mcpConfigSchema } from '@mcp-toolkit/mcp/config';
import { policyConfigSchema } from '@mcp-toolkit/policy/config';
import { storageConfigSchema } from '@mcp-toolkit/storage/config';
import { z } from 'zod';

/**
 * Server-level runtime knobs. Private to this file — the operator never
 * sees a top-level `server` namespace in `.env`, and no `@mcp-toolkit/*`
 * package needs `ServerConfig` independently.
 */
const serverConfigSchema = z
  .object({
    host: z.string().default('127.0.0.1'),
    port: z.coerce.number().int().positive().default(3000),
    nodeEnv: z
      .enum(['development', 'production', 'test'])
      .optional()
      .default('development'),
    logLevel: z
      .enum([
        'debug',
        'info',
        'warning',
        'error',
        'notice',
        'critical',
        'alert',
        'emergency',
      ])
      .optional()
      .default('info'),
    rpsLimit: z.coerce.number().int().nonnegative().default(0),
    concurrencyLimit: z.coerce.number().int().nonnegative().default(0),
    /**
     * Comma-separated list of allowed CORS / Origin values. Required in
     * production for browser-initiated requests; in development the
     * literal loopback origins (`localhost`, `127.0.0.1`, `[::1]`) are
     * auto-allowed. Empty by default — strict-deny with no entries.
     */
    allowedOrigins: stringList,
  })
  .default({});

export const appConfigSchema = z
  .object({
    server: serverConfigSchema,
    auth: authConfigSchema.default({}),
    mcp: mcpConfigSchema.default({}),
    storage: storageConfigSchema.default({}),
    policy: policyConfigSchema.default({}),
  })
  .default({});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
