/**
 * `@mcp-toolkit/auth` — pluggable auth contract + identity helpers.
 *
 * Strategies are exported through subpaths (kept off the package root so
 * they tree-shake cleanly):
 *
 *   import { oidcStrategy }    from '@mcp-toolkit/auth/oidc';
 *   import { jwtStrategy }     from '@mcp-toolkit/auth/jwt';
 *   import { apiKeyStrategy,
 *            bearerStrategy,
 *            customHeadersStrategy } from '@mcp-toolkit/auth/apikey';
 *   import { noneStrategy }    from '@mcp-toolkit/auth/none';
 *
 * The package root re-exports only the contract and identity helpers — the
 * pieces every consumer needs regardless of which strategy is active.
 */

export type { AuthStrategyName } from './config.ts';
export { AUTH_STRATEGIES } from './config.ts';
export {
  extractIdentityFromIdToken,
  extractIdentityFromProvider,
  identityEquals,
  identityFromClaims,
  resolveIdentityForMcp,
  type SessionIdentity,
} from './identity.ts';
export type {
  AuthStrategy,
  AuthStrategyKind,
  AuthVerifyResult,
} from './types.ts';
