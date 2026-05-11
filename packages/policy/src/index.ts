/**
 * @mcp-toolkit/policy — pluggable policy engine for mcp-toolkit.
 *
 * Public surface:
 *   - `PolicyEnforcer` — DI contract consumed by the dispatcher (D3) and
 *     the tools / prompts / resources registries (D4*). Keep tool packages
 *     free of policy imports; pass an enforcer in instead.
 *   - `createPolicyEngine` / `getPolicyEngine` — factories that produce a
 *     concrete enforcer. `getPolicyEngine` is stateless and is meant to be
 *     called once from `apps/server/src/compose.ts`.
 *   - `buildPolicySubject` — turn a `SessionIdentity` (from `@mcp-toolkit/core`)
 *     into a normalized `PolicySubject`.
 *   - `parsePolicyDocument` / `loadPolicyFromRaw` — parse + validate inline
 *     YAML / JSON; throws on invalid input.
 */

export {
  createPolicyEngine,
  type PolicyEnforcer,
  type PolicyEngine,
} from './engine.ts';
export { globMatches, globToRegex } from './glob.ts';
export {
  assertPolicyConfigValid,
  getPolicyEngine,
  loadPolicyFromRaw,
  type PolicyConfigSlice,
  parsePolicyDocument,
} from './load.ts';
export { type McpAccessPolicy, mcpAccessPolicySchema } from './schema.ts';
export { buildPolicySubject, type PolicySubject } from './subject.ts';
