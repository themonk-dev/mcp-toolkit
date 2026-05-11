/**
 * Nested zod config schema for `@mcp-toolkit/auth`.
 *
 * The app-level loader (`apps/server/src/env-loader.ts`) reads the
 * grouped `AUTH` / `AUTH_KEYS` / `AUTH_OAUTH` JSON env vars and shallow-
 * merges them into the `auth` slot of `AppConfig`, which this schema
 * validates. Consumers read `config.auth.apikey.key` directly.
 *
 * Runtime-agnostic — no `node:*` imports. Coercion helpers are the shared
 * `@mcp-toolkit/core/zod-helpers` set so every package agrees on what counts as
 * "true" / "an empty list" / "no value".
 */

import {
  boolFromString,
  optionalString,
  stringList,
} from '@mcp-toolkit/core/zod-helpers';
import { z } from 'zod';

/**
 * Canonical strategy names accepted by `auth.strategy`. Mirrors
 * `AuthStrategyKind` in `./types.ts` exactly — no aliasing. The legacy
 * `api_key` snake_case alias was removed; users must spell it `apikey`.
 */
export const AUTH_STRATEGIES = [
  'oidc',
  'oauth',
  'jwt',
  'apikey',
  'bearer',
  'custom',
  'none',
] as const;

export type AuthStrategyName = (typeof AUTH_STRATEGIES)[number];

/** API key strategy inputs. ← `API_KEY` / `API_KEY_HEADER`. */
const apikeySchema = z.object({
  key: optionalString,
  headerName: z.string().default('x-api-key'),
});

/** Bearer token strategy inputs. ← `BEARER_TOKEN`. */
const bearerSchema = z.object({
  token: optionalString,
});

/**
 * Custom-headers strategy inputs. The raw `"X:y,Z:w"` string is preserved as
 * a single field; `compose.ts` parses it via `parseCustomHeaders`.
 * ← `CUSTOM_HEADERS`.
 */
const customSchema = z.object({
  headers: optionalString,
});

/** OAuth / OIDC client + endpoint inputs. ← `OAUTH_*`. */
const oauthSchema = z.object({
  clientId: optionalString,
  clientSecret: optionalString,
  scopes: z.string().default(''),
  authorizationUrl: optionalString,
  tokenUrl: optionalString,
  revocationUrl: optionalString,
  redirectUri: z.string().default('http://localhost:3000/callback'),
  redirectAllowlist: stringList,
  redirectAllowAll: boolFromString,
  clientAuth: optionalString,
  extraAuthParams: optionalString,
});

/** OIDC discovery inputs. ← `OIDC_ISSUER`. */
const oidcSchema = z.object({
  issuer: optionalString,
});

/**
 * CIMD (SEP-991) inputs. `enabled` has a non-default default: when the env
 * is unset, CIMD is on. Set `CIMD_ENABLED=false` to disable.
 * ← `CIMD_*`.
 */
const cimdSchema = z.object({
  enabled: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => {
      if (typeof v === 'boolean') return v;
      if (v === undefined) return true;
      return String(v).trim().toLowerCase() === 'true';
    }),
  fetchTimeoutMs: z.coerce.number().int().positive().default(5000),
  maxResponseBytes: z.coerce.number().int().positive().default(65536),
  allowedDomains: stringList,
});

/** Upstream provider mapping inputs. ← `PROVIDER_*`. */
const providerSchema = z.object({
  clientId: optionalString,
  clientSecret: optionalString,
  accountsUrl: optionalString,
});

/** JWT strategy inputs — verify a Bearer JWT against a JWKS URL. ← `JWT_*`. */
const jwtSchema = z.object({
  jwksUrl: optionalString,
  issuer: optionalString,
  audience: optionalString,
});

/**
 * Nested auth config — `config.auth.*` in the composed `AppConfig`. Each
 * strategy gets its own sub-object so unused strategies don't bleed fields
 * into the type, and so the three operator env vars (`AUTH`, `AUTH_KEYS`,
 * `AUTH_OAUTH`) map cleanly via shallow-merge in the loader.
 */
export const authConfigSchema = z.object({
  strategy: z.enum(AUTH_STRATEGIES).optional().default('none'),
  requireRs: boolFromString,
  resourceUri: optionalString,
  discoveryUrl: optionalString,
  // Sub-objects default to `{}` so a bare `authConfigSchema.parse({})` (or
  // an env with only `auth.strategy` set) still produces a fully-populated
  // shape. Each sub-schema's own fields supply their own defaults.
  apikey: apikeySchema.default({}),
  bearer: bearerSchema.default({}),
  custom: customSchema.default({}),
  oauth: oauthSchema.default({}),
  oidc: oidcSchema.default({}),
  cimd: cimdSchema.default({}),
  provider: providerSchema.default({}),
  jwt: jwtSchema.default({}),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;
export type AuthApikeyConfig = z.infer<typeof apikeySchema>;
export type AuthBearerConfig = z.infer<typeof bearerSchema>;
export type AuthCustomConfig = z.infer<typeof customSchema>;
export type AuthOauthConfig = z.infer<typeof oauthSchema>;
export type AuthOidcConfig = z.infer<typeof oidcSchema>;
export type AuthCimdConfig = z.infer<typeof cimdSchema>;
export type AuthProviderConfig = z.infer<typeof providerSchema>;
export type AuthJwtConfig = z.infer<typeof jwtSchema>;
