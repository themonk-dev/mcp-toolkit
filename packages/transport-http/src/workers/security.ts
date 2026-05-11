/**
 * MCP security pre-flight for the Workers transport.
 *
 * Originally `src/adapters/http-workers/security.ts`. The new shape drops
 * the implicit token-store import; with the auth strategy now responsible
 * for RS-token resolution, this preflight only handles the runtime checks
 * that don't depend on token state (origin, protocol version).
 *
 * G1 hardening (F-2): the redundant "no Authorization header → 401 challenge"
 * pre-strategy probe has been removed. The wired strategy's `verify()` is the
 * authoritative gate — `apikey` / `bearer` / `jwt` / `oidc` all return their
 * own 401 challenge when no credential is presented, and the header probe
 * here previously hardcoded `x-api-key` / `x-auth-token` (ignoring
 * `API_KEY_HEADER`), so deployments using a custom header name were 401'd
 * by this preflight before the strategy ever ran.
 *
 * Strictly no `node:*` imports — Workers safety.
 */

import { withCors } from '@mcp-toolkit/core';
import {
  buildUnauthorizedChallenge,
  validateOrigin,
  validateProtocolVersion,
} from '@mcp-toolkit/mcp';

/**
 * Slice of unified config consumed by this preflight. Mirrors the Node
 * `SecurityMiddlewareConfig` shape (by design) so the same projection from
 * `AppConfig` works for both runtimes: `config.server.{nodeEnv,allowedOrigins}` +
 * `config.mcp.protocolVersion`.
 */
export interface WorkersSecurityConfig {
  /** Runtime environment (development relaxes the origin check to allow loopbacks). */
  nodeEnv: string;
  /** MCP protocol version validated against the `MCP-Protocol-Version` header. */
  protocolVersion: string;
  /**
   * Browser-Origin allowlist. In dev, loopback origins are auto-allowed in
   * addition to this list.
   */
  allowedOrigins?: readonly string[];
}

/**
 * Returns `null` when the request passes the preflight, or a 401 challenge
 * response otherwise. Callers must propagate the response unchanged.
 *
 * The preflight only validates origin and protocol version; the wired
 * strategy's `verify()` is the gate for credential presence and validity.
 */
export async function checkAuthAndChallenge(
  request: Request,
  config: WorkersSecurityConfig,
  sid: string,
): Promise<Response | null> {
  try {
    validateOrigin(
      request.headers,
      config.nodeEnv === 'development',
      config.allowedOrigins ?? [],
    );
    validateProtocolVersion(request.headers, config.protocolVersion);
  } catch (error) {
    const challenge = buildUnauthorizedChallenge({
      origin: new URL(request.url).origin,
      sid,
      message: (error as Error).message,
    });

    const resp = new Response(JSON.stringify(challenge.body), {
      status: challenge.status,
      headers: {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': sid,
        // Emit lowercase to match the strategies (apikey/jwt/oidc all emit
        // `'www-authenticate'`). HTTP normalises header names so on-wire is
        // unchanged, but tests that read `headers['www-authenticate']` from a
        // `Record<string, string>` couple to one casing — keep it consistent.
        'www-authenticate': challenge.headers['www-authenticate'],
      },
    });
    return withCors(resp);
  }

  return null;
}
