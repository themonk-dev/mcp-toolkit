/**
 * Canonical types index.
 * Import types from here for consistency across the codebase.
 */

// Auth types
export type { AuthHeaders, AuthStrategy, ResolvedAuth } from './auth.ts';
// Context types (RequestContext for Node.js middleware)
export type { RequestContext, SessionIdentity } from './context.ts';
// Provider types
export type { ProviderInfo, ProviderTokens } from './provider.ts';
export { toProviderInfo, toProviderTokens } from './provider.ts';
