/**
 * Nested zod config for `@mcp-toolkit/proxy-tools`.
 *
 * Surfaces one operator-facing env var, `CONNECTED_SERVERS` — a JSON array
 * of {@link ConnectedServer} entries. Each entry is a {@link
 * z.discriminatedUnion} on `authType`, so missing per-variant secrets fail
 * at parse-time with a path-prefixed error like
 * `connectedServers.0.token: String must contain at least 1 character(s)`.
 *
 * Adding a future `oauth2` auth type means adding one more variant to the
 * union; the credential resolver, auth-inject builder, and proxy factory
 * each switch on `authType` and need a single new branch.
 *
 * Runtime-agnostic — no `node:*` imports.
 */

import { z } from 'zod';

/**
 * Auth types currently supported by `CONNECTED_SERVERS`. `oauth2` is
 * deliberately omitted until the discovery / DCR / refresh layer lands —
 * adding it here is one new variant + one new branch in `creds.ts` and
 * `auth-inject.ts`.
 */
export const CONNECTED_AUTH_TYPES = ['none', 'api_key', 'bearer'] as const;
export type ConnectedAuthType = (typeof CONNECTED_AUTH_TYPES)[number];

const idSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-z0-9_-]+$/,
    'id must be lowercase alphanumeric with hyphens or underscores only',
  );

const urlSchema = z.string().url();

const noneSchema = z.object({
  id: idSchema,
  url: urlSchema,
  authType: z.literal('none'),
});

const apiKeySchema = z.object({
  id: idSchema,
  url: urlSchema,
  authType: z.literal('api_key'),
  headerName: z.string().min(1),
  key: z.string().min(1),
});

const bearerSchema = z.object({
  id: idSchema,
  url: urlSchema,
  authType: z.literal('bearer'),
  token: z.string().min(1),
});

export const connectedServerSchema = z.discriminatedUnion('authType', [
  noneSchema,
  apiKeySchema,
  bearerSchema,
]);

export type ConnectedServer = z.infer<typeof connectedServerSchema>;

export const connectedServersSchema = z
  .array(connectedServerSchema)
  .default([])
  .superRefine((servers, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < servers.length; i++) {
      const id = servers[i].id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'id'],
          message: `duplicate server id "${id}"`,
        });
      }
      seen.add(id);
    }
  });
