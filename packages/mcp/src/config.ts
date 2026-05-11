/**
 * Nested config schema for `@mcp-toolkit/mcp`.
 *
 * The app-level loader (`apps/server/src/env-loader.ts`) parses the
 * grouped `MCP` and `MCP_ICON` JSON env vars and composes them as
 * `{ ...MCP, icon: MCP_ICON }` for this schema to validate.
 *
 * Operator-facing layout:
 *   MCP        → { title, version, instructions, protocolVersion }
 *   MCP_ICON   → { url, mime, sizes }
 *
 * Runtime-agnostic — no `node:*` imports.
 */

import { optionalString, stringList } from '@mcp-toolkit/core/zod-helpers';
import { z } from 'zod';

/** SEP-973 icon descriptor returned in `initialize` serverInfo.icons. */
const iconSchema = z
  .object({
    /** Optional PNG/SVG/WebP URL or data URI. */
    url: optionalString,
    /** Optional MIME override; otherwise inferred from URL. */
    mime: optionalString,
    /** Optional icon sizes, e.g. `["512x512"]`. */
    sizes: stringList,
  })
  .default({});

export const mcpConfigSchema = z
  .object({
    /** Display name for the server (`Implementation.title`). */
    title: z.string().default('MCP Server'),
    /** Server version (`Implementation.version`). */
    version: z.string().default('0.1.0'),
    /** Optional `instructions` field returned to clients on `initialize`. */
    instructions: optionalString,
    /** Negotiated MCP protocol version (default: latest stable). */
    protocolVersion: z.string().default('2025-06-18'),
    /** SEP-973 icons (initialize handshake). */
    icon: iconSchema,
  })
  .default({});

export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type McpIconConfig = z.infer<typeof iconSchema>;
