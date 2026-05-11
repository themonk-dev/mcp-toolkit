import type { CancellationToken } from '../utils/cancellation.ts';
import type { AuthStrategy } from './auth.ts';
import type { ProviderTokens } from './provider.ts';

export type { AuthStrategy } from './auth.ts';

/**
 * Normalized identity snapshot derived from OIDC id_token claims.
 *
 * Used for gating / customizing tools, resources, and prompts by group
 * membership. Lives in core (not @mcp-toolkit/auth) so that any package that
 * touches `RequestContext` can refer to it without a back-edge import.
 */
export interface SessionIdentity {
  sub?: string;
  email?: string;
  preferred_username?: string;
  groups?: string[];
  memberOf?: string[];
  iss?: string;
  aud?: string | string[];
}

/**
 * Request context passed to tool handlers. Carries the resolved auth +
 * identity snapshot and the per-request cancellation token.
 */
export interface RequestContext {
  /** MCP session id from the streaming-HTTP transport. */
  sessionId?: string;
  /** Per-request cancellation token; tools should check periodically. */
  cancellationToken: CancellationToken;
  /** JSON-RPC request id. */
  requestId?: string | number;
  /** Wall-clock time the request was received. */
  timestamp: number;

  /** Active auth strategy kind (`'oidc' | 'jwt' | 'apikey' | 'bearer' | 'custom' | 'none'`). */
  authStrategy?: AuthStrategy;
  /** Headers ready to attach to upstream API calls (strategy-resolved). */
  resolvedHeaders?: Record<string, string>;
  /** Original RS access token from the request, if any. */
  rsToken?: string;

  /** Provider access token for upstream API calls (OIDC / bearer / apikey). */
  providerToken?: string;
  /** Full provider token bundle (OIDC only). Snake_case to match storage. */
  provider?: ProviderTokens;
  /** Identity snapshot (id_token claims or session-store record). */
  identity?: SessionIdentity;
}
