import type { ProviderInfo, ProviderTokens, SessionIdentity } from '@mcp-toolkit/core';
import { base64UrlDecode } from '@mcp-toolkit/core';

export type { SessionIdentity } from '@mcp-toolkit/core';

function decodeJwtPayloadUnverified(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const json = new TextDecoder().decode(base64UrlDecode(parts[1]));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Build a {@link SessionIdentity} from an already-decoded JWT-like payload.
 *
 * Used by strategies that have a verified payload in hand (e.g. `jwtStrategy`
 * after `jwtVerify`) and don't need to round-trip back through a JWT string.
 */
export function identityFromClaims(
  payload: Record<string, unknown>,
): SessionIdentity | null {
  const groups = toStringArray(payload.groups);
  const memberOf = toStringArray(payload.memberOf ?? payload.member_of);

  const identity: SessionIdentity = {
    sub: typeof payload.sub === 'string' ? payload.sub : undefined,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    preferred_username:
      typeof payload.preferred_username === 'string'
        ? payload.preferred_username
        : undefined,
    groups,
    memberOf,
    iss: typeof payload.iss === 'string' ? payload.iss : undefined,
    aud: Array.isArray(payload.aud)
      ? payload.aud.map(String)
      : typeof payload.aud === 'string'
        ? payload.aud
        : undefined,
  };

  if (identity.groups && identity.groups.length === 0) delete identity.groups;
  if (identity.memberOf && identity.memberOf.length === 0) delete identity.memberOf;

  return Object.values(identity).some((v) => v !== undefined) ? identity : null;
}

function toStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const out = value
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean);
    return out.length ? [...new Set(out)] : undefined;
  }
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return undefined;
    // Some IdPs send a single string; others send "groupA,groupB" or "a;b"
    if (t.includes(',') || t.includes(';')) {
      const parts = t
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
      return parts.length ? [...new Set(parts)] : undefined;
    }
    return [t];
  }
  return undefined;
}

/**
 * Extract a stable, normalized identity snapshot from an OIDC `id_token`.
 * This is an **unverified** decode; verification should happen at the OAuth layer.
 */
export function extractIdentityFromIdToken(idToken: string): SessionIdentity | null {
  const payload = decodeJwtPayloadUnverified(idToken);
  if (!payload) return null;
  return identityFromClaims(payload);
}

export function extractIdentityFromProvider(
  provider?: ProviderTokens | ProviderInfo | null,
): SessionIdentity | null {
  if (!provider) return null;
  const idToken =
    typeof (provider as ProviderTokens).id_token === 'string'
      ? (provider as ProviderTokens).id_token
      : typeof (provider as ProviderInfo).idToken === 'string'
        ? (provider as ProviderInfo).idToken
        : undefined;
  if (!idToken) return null;
  return extractIdentityFromIdToken(idToken);
}

/**
 * Prefer live id_token decode (fresh claims, including rotated groups);
 * fall back to the snapshot persisted on the session record.
 *
 * Returns `null` if neither source yields any identifying claim — callers
 * should treat that as "anonymous principal" for policy decisions.
 */
export function resolveIdentityForMcp(
  stored: SessionIdentity | null | undefined,
  provider: ProviderTokens | ProviderInfo | null | undefined,
): SessionIdentity | null {
  const live = extractIdentityFromProvider(provider ?? null);
  if (live) return live;
  if (stored && Object.values(stored).some((v) => v !== undefined && v !== '')) {
    return stored;
  }
  return null;
}

export function identityEquals(
  a: SessionIdentity | undefined,
  b: SessionIdentity | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const norm = (x?: string[]) => (x ? [...x].sort().join('|') : '');
  return (
    a.sub === b.sub &&
    a.email === b.email &&
    a.preferred_username === b.preferred_username &&
    a.iss === b.iss &&
    JSON.stringify(a.aud ?? null) === JSON.stringify(b.aud ?? null) &&
    norm(a.groups) === norm(b.groups) &&
    norm(a.memberOf) === norm(b.memberOf)
  );
}
