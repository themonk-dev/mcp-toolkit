import YAML from 'yaml';
import { createPolicyEngine, type PolicyEngine } from './engine.ts';
import { type McpAccessPolicy, mcpAccessPolicySchema } from './schema.ts';

/**
 * Slice of config consumed by the policy package. Only inline policy bytes —
 * file-path resolution (Node-only `POLICY.path`) is done in
 * `apps/server/src/env-node.ts` and folded into `content` before this
 * package ever sees it. Keeps the package node-free for Workers.
 *
 * Mirrors the nested `PolicyConfig` shape from `@mcp-toolkit/policy/config`.
 */
export type PolicyConfigSlice = {
  /** Inline YAML or JSON document. */
  content?: string;
};

function policyRawFromConfig(config: PolicyConfigSlice): string | null {
  const inline = config.content?.trim();
  if (inline) return inline;
  return null;
}

/** Parse + validate a YAML/JSON policy document. Throws on invalid input. */
export function parsePolicyDocument(raw: string): McpAccessPolicy {
  const data = YAML.parse(raw) as unknown;
  return mcpAccessPolicySchema.parse(data);
}

/** Alias for {@link parsePolicyDocument}; kept for ergonomic call sites. */
export function loadPolicyFromRaw(raw: string): McpAccessPolicy {
  return parsePolicyDocument(raw);
}

/**
 * Validate the slice without constructing an engine — used at boot to fail
 * fast on a malformed policy document.
 */
export function assertPolicyConfigValid(config: PolicyConfigSlice): void {
  const raw = policyRawFromConfig(config);
  if (!raw) return;
  parsePolicyDocument(raw);
}

/**
 * Construct a fresh {@link PolicyEngine} from the given config slice, or
 * return `null` when no policy is configured.
 *
 * Stateless: there is no module-level cache. `compose.ts` (D6) calls this
 * exactly once at boot and threads the resulting enforcer through DI.
 */
export function getPolicyEngine(config: PolicyConfigSlice): PolicyEngine | null {
  const raw = policyRawFromConfig(config);
  if (!raw) return null;
  return createPolicyEngine(parsePolicyDocument(raw));
}
