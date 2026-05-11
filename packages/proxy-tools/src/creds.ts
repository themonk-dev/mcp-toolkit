/**
 * `CredentialResolver` — the contract through which the proxy factory
 * obtains a downstream credential for a given `serverId`.
 *
 * v1 ships exactly one implementation: {@link EnvCredentialResolver},
 * backed by the validated `CONNECTED_SERVERS` env config. Persistent or
 * encrypted stores (e.g. an AES-GCM-sealed file vault) drop in by
 * implementing this interface — no other package needs to change.
 *
 * Sync `resolve()` is deliberate: it matches the v1 `AuthInject` shape
 * (also sync) and keeps the hot path allocation-free for static creds.
 * When OAuth2 lands the resolver will likely flip to async; that change is
 * isolated to this interface and its callers in `factory.ts`.
 */

import type { ConnectedServer } from './config.ts';

/**
 * Discriminated cred union. Mirrors `ConnectedAuthType` but strips
 * non-secret fields (`id`, `url`) — those are the server's identity, not
 * its credential. Future `oauth2` variant will carry access/refresh tokens
 * and an `expiresAt`; the AuthInject builder will handle async refresh.
 */
export type Credential =
  | { authType: 'none' }
  | { authType: 'api_key'; headerName: string; key: string }
  | { authType: 'bearer'; token: string };

export interface CredentialResolver {
  /**
   * Return the credential for the given server id.
   *
   * Throws if `serverId` is not configured — this is meant as a "should
   * never happen at runtime" failsafe; well-behaved callers receive ids
   * derived from the same registry that built the resolver, and the
   * compose-time validation catches missing entries before the first
   * request lands.
   */
  resolve(serverId: string): Credential;
}

export class EnvCredentialResolver implements CredentialResolver {
  private readonly byId: Map<string, Credential>;

  constructor(servers: ConnectedServer[]) {
    this.byId = new Map(servers.map((s) => [s.id, toCredential(s)]));
  }

  resolve(serverId: string): Credential {
    const cred = this.byId.get(serverId);
    if (!cred) {
      throw new Error(`unknown connected server id "${serverId}"`);
    }
    return cred;
  }
}

function toCredential(server: ConnectedServer): Credential {
  switch (server.authType) {
    case 'none':
      return { authType: 'none' };
    case 'api_key':
      return {
        authType: 'api_key',
        headerName: server.headerName,
        key: server.key,
      };
    case 'bearer':
      return { authType: 'bearer', token: server.token };
  }
}
