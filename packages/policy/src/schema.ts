import { z } from 'zod';

const accessRuleFields = {
  allow_groups: z.array(z.string()).min(1),
  deny_groups: z.array(z.string()).optional(),
};

export const mcpAccessPolicySchema = z.object({
  version: z.number().int().positive(),
  mode: z.enum(['off', 'enforce']),
  tools: z
    .array(
      z.object({
        name: z.string().min(1),
        ...accessRuleFields,
      }),
    )
    .default([]),
  resources: z
    .array(
      z.object({
        uri: z.string().min(1),
        ...accessRuleFields,
      }),
    )
    .default([]),
  prompts: z
    .array(
      z.object({
        name: z.string().min(1),
        ...accessRuleFields,
      }),
    )
    .default([]),
  principal_aliases: z.record(z.string(), z.string()).optional(),
});

export type McpAccessPolicy = z.infer<typeof mcpAccessPolicySchema>;
