/**
 * Group-policy assertions for MCP catalog operations (prompts, resources).
 *
 * The previous implementation reached into module-level singletons
 * (`getPolicyEngine`, `getCurrentAuthContext`). Both are now passed in by the
 * caller — the registry that owns the prompt/resource handler closes over the
 * enforcer and the resolved subject and forwards them here.
 */

import type { PolicyEnforcer, PolicySubject } from '@mcp-toolkit/policy';

export function assertPromptAllowed(
  name: string,
  policy?: PolicyEnforcer,
  subject?: PolicySubject,
): void {
  if (!policy?.isEnforced()) return;
  if (!subject) return;
  if (!policy.canAccessPrompt(name, subject)) {
    throw new Error(`Forbidden: insufficient group membership for prompt "${name}"`);
  }
}

export function assertResourceAllowed(
  uri: string,
  policy?: PolicyEnforcer,
  subject?: PolicySubject,
): void {
  if (!policy?.isEnforced()) return;
  if (!subject) return;
  if (!policy.canAccessResource(uri, subject)) {
    throw new Error(`Forbidden: insufficient group membership for resource "${uri}"`);
  }
}
