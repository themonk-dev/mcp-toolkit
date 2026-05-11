/**
 * Shared zod coercion helpers for parsing flat env-shaped inputs into typed
 * config objects. Every package's config schema reuses these.
 *
 * The config loader (`apps/server/src/env-loader.ts`) parses grouped JSON
 * env vars; the per-package schemas then coerce individual string fields
 * via these helpers (trim, default-to-undefined, parse comma-lists).
 *
 * Runtime-agnostic — no `node:*` imports.
 */

import { z } from 'zod';

/**
 * Optional trimmed string. Empty strings collapse to `undefined` so callers
 * can use simple truthy checks (`if (config.auth.bearer.token)`) without
 * worrying about whitespace-only values.
 */
export const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined));

/**
 * List of strings. Accepts either an array (the natural shape from JSON env
 * vars) or a comma-separated string (the legacy / test-helper shorthand).
 * Trims whitespace, drops empties. Always returns a `string[]` (never
 * `undefined`) so consumers can use array methods directly.
 *
 *   `["a", "b", "c"]` → `["a", "b", "c"]`   (preferred — JSON-native)
 *   `"a, b ,  ,c"`    → `["a", "b", "c"]`   (legacy CSV shorthand)
 *   `undefined`       → `[]`
 *   `""` or `[]`      → `[]`
 */
export const stringList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (Array.isArray(v)) {
      return v.map((s) => s.trim()).filter(Boolean);
    }
    return String(v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  });

/**
 * Truthy parser tolerant of env-style inputs. Treats only the literal
 * (case-insensitive, trimmed) string `"true"` and the JS boolean `true`
 * as truthy. Everything else — including `"1"`, `"yes"`, `"on"`, `0`,
 * `null`, `undefined`, or whitespace — is `false`.
 *
 * Strict-truthy chosen over permissive-truthy to surface operator typos
 * in `.env` files (e.g. `AUTH_REQUIRE_RS=yes` will not silently enable
 * the flag).
 */
export const boolFromString = z
  .union([z.string(), z.boolean()])
  .optional()
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    if (v === undefined) return false;
    return String(v).trim().toLowerCase() === 'true';
  });
