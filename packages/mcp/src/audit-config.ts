import { boolFromString } from '@mcp-toolkit/core/zod-helpers';
import { z } from 'zod';

/**
 * Audit sink config. Zero-config: defaults to enabled.
 * Opt out with `AUDIT='{"enabled":false}'`.
 */
export const auditConfigSchema = z
  .object({
    enabled: boolFromString.default(true),
  })
  .default({});

export type AuditConfig = z.infer<typeof auditConfigSchema>;
