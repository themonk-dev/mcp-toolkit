import { globMatches } from './glob.ts';
import type { McpAccessPolicy } from './schema.ts';
import type { PolicySubject } from './subject.ts';

/**
 * Public contract for the policy enforcer.
 *
 * The dispatcher (`@mcp-toolkit/mcp`) and the tools / prompts / resources
 * registries accept a `PolicyEnforcer` by dependency injection — they never
 * import `getPolicyEngine` (or any concrete factory) directly. This is the
 * single coupling fix that makes "drop the policy package" possible: with no
 * enforcer wired in, the registries skip filtering entirely and the rest of
 * the server keeps working.
 *
 * The `PolicyEngine` factory below produces values that structurally satisfy
 * this interface; `compose.ts` (D6) constructs one at boot from a parsed
 * policy document and passes it through.
 */
export interface PolicyEnforcer {
  /** Convenience for callers that want to short-circuit when policy is off. */
  isEnforced(): boolean;
  filterTools<T extends { name: string }>(tools: T[], subject: PolicySubject): T[];
  filterPrompts<T extends { name: string }>(prompts: T[], subject: PolicySubject): T[];
  filterResources<T extends { uri: string }>(
    resources: T[],
    subject: PolicySubject,
  ): T[];
  canAccessTool(name: string, subject: PolicySubject): boolean;
  canAccessPrompt(name: string, subject: PolicySubject): boolean;
  canAccessResource(uri: string, subject: PolicySubject): boolean;
  readonly policy: McpAccessPolicy;
}

/**
 * Concrete shape produced by {@link createPolicyEngine}. Kept as a type
 * (rather than a class) so the factory can return a plain object literal —
 * structural equivalence to `PolicyEnforcer` is checked at the boundary.
 */
export type PolicyEngine = PolicyEnforcer;

function matchingToolRules(policy: McpAccessPolicy, name: string) {
  return policy.tools.filter((r) => globMatches(r.name, name, false));
}

function matchingResourceRules(policy: McpAccessPolicy, uri: string) {
  return policy.resources.filter((r) => globMatches(r.uri, uri, true));
}

function matchingPromptRules(policy: McpAccessPolicy, name: string) {
  return policy.prompts.filter((r) => globMatches(r.name, name, false));
}

function denyApplies(
  rule: { deny_groups?: string[] },
  subject: PolicySubject,
): boolean {
  const deny = rule.deny_groups;
  if (!deny?.length) return false;
  return deny.some((g) => subject.groupSet.has(g));
}

function allowApplies(
  rule: { allow_groups: string[] },
  subject: PolicySubject,
): boolean {
  if (rule.allow_groups.includes('*') && subject.hasSubject) return true;
  return rule.allow_groups.some((g) => g !== '*' && subject.groupSet.has(g));
}

function canAccessWithRules(
  rules: Array<{ allow_groups: string[]; deny_groups?: string[] }>,
  subject: PolicySubject,
): boolean {
  if (rules.length === 0) return false;

  for (const r of rules) {
    if (denyApplies(r, subject)) return false;
  }

  for (const r of rules) {
    if (allowApplies(r, subject)) return true;
  }

  return false;
}

export function createPolicyEngine(policy: McpAccessPolicy): PolicyEngine {
  return {
    policy,

    isEnforced() {
      return policy.mode === 'enforce';
    },

    canAccessTool(name, subject) {
      if (policy.mode !== 'enforce') return true;
      return canAccessWithRules(matchingToolRules(policy, name), subject);
    },

    canAccessResource(uri, subject) {
      if (policy.mode !== 'enforce') return true;
      return canAccessWithRules(matchingResourceRules(policy, uri), subject);
    },

    canAccessPrompt(name, subject) {
      if (policy.mode !== 'enforce') return true;
      return canAccessWithRules(matchingPromptRules(policy, name), subject);
    },

    filterTools(items, subject) {
      if (policy.mode !== 'enforce') return items;
      return items.filter((t) =>
        canAccessWithRules(matchingToolRules(policy, t.name), subject),
      );
    },

    filterResources(items, subject) {
      if (policy.mode !== 'enforce') return items;
      return items.filter((r) =>
        canAccessWithRules(matchingResourceRules(policy, r.uri), subject),
      );
    },

    filterPrompts(items, subject) {
      if (policy.mode !== 'enforce') return items;
      return items.filter((p) =>
        canAccessWithRules(matchingPromptRules(policy, p.name), subject),
      );
    },
  };
}
