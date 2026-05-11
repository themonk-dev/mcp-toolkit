import { optionalString } from '@mcp-toolkit/core/zod-helpers';
import { z } from 'zod';

/**
 * Policy config consumed by the engine. `content` is the inline YAML/JSON
 * source (already-resolved bytes — Node reads `POLICY.path` from disk in
 * `apps/server/src/env-node.ts` and folds the bytes into `POLICY.content`
 * before the loader passes it here; Workers requires inline content).
 * There is no `path` field on this schema on purpose: file-system access
 * is a host concern.
 *
 * Runtime-agnostic — no `node:*` imports.
 */
export const policyConfigSchema = z.object({
  /** Inline YAML or JSON policy document (already-resolved bytes). */
  content: optionalString,
});

export type PolicyConfig = z.infer<typeof policyConfigSchema>;
