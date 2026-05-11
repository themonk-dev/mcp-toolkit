/**
 * AuthStrategy contract.
 *
 * Each strategy (oidc, jwt, apikey, none) is a factory that produces an
 * `AuthStrategy` instance. The factory lives at a subpath of `@mcp-toolkit/auth`
 * (`@mcp-toolkit/auth/oidc`, etc.) so consumers can tree-shake unused strategies.
 */

import type { ProviderTokens, SessionIdentity } from '@mcp-toolkit/core';
import type { TokenStore } from '@mcp-toolkit/storage';
import type { Hono } from 'hono';

/**
 * Canonical set of shipped strategy kinds. Every `AuthStrategy.kind` returned
 * by the factories in this package is one of these values, and every consumer
 * (transport-http, mcp dispatcher, audit) narrows against this union rather
 * than `string`.
 *
 * `oauth` and `oidc` share the same factory body and are emitted distinctly
 * only to preserve the configured env value through to logs / audit. New
 * strategy kinds must be added here first; the env schema and compose
 * selector key off the same union (no aliasing — `api_key` was dropped in
 * favour of `apikey`).
 */
export type AuthStrategyKind =
  | 'oidc'
  | 'oauth'
  | 'jwt'
  | 'apikey'
  | 'bearer'
  | 'custom'
  | 'none';

/**
 * Result of an `AuthStrategy.verify` call.
 *
 * `ok=true` means the request is authorized. `resolvedHeaders` is the set
 * of headers tools should use when calling upstream APIs. `identity` and
 * `provider` are optional snapshots populated by strategies that produce
 * them (oidc, jwt).
 *
 * `ok=false` indicates the strategy refused the request. `challenge`
 * carries the appropriate HTTP response (e.g. `401 WWW-Authenticate`).
 */
export interface AuthVerifyResult {
  ok: boolean;
  identity?: SessionIdentity;
  provider?: ProviderTokens;
  resolvedHeaders: Record<string, string>;
  challenge?: { status: number; headers: Record<string, string>; body?: string };
}

/**
 * Pluggable authentication strategy.
 *
 * Lifecycle:
 *  1. `init()` (optional) — called once at boot.
 *  2. `mountAuthorizationServer(app)` (optional) — called once at boot for
 *     strategies that own OAuth Authorization Server endpoints
 *     (`/authorize`, `/token`, `/register`, `/oauth/callback`, `/revoke`).
 *  3. `verify(req, deps)` — called per request to authenticate.
 *
 * `protectedResourceMetadata()` (optional) returns the metadata served at
 * `/.well-known/oauth-protected-resource`.
 */
export interface AuthStrategy {
  readonly kind: AuthStrategyKind;
  init?(): Promise<void>;
  verify(req: Request, deps: { tokenStore?: TokenStore }): Promise<AuthVerifyResult>;
  mountAuthorizationServer?(app: Hono): void;
  protectedResourceMetadata?(): {
    authorization_servers: string[];
    resource: string;
  } | null;
}
