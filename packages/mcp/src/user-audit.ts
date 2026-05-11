/**
 * Optional audit logging for MCP "catalog" JSON-RPC methods (tools/resources/prompts list).
 * Does not log raw access tokens, refresh tokens, or full id_token — only allowlisted JWT claims.
 *
 * The dispatcher passes in the live tool / prompt / resource catalogs and the
 * (optional) policy enforcer. This module never imports a registry package or
 * `getPolicyEngine` directly — those are dependency-injected.
 */

import { resolveIdentityForMcp } from '@mcp-toolkit/auth';
import {
  type AuthStrategy as AuthStrategyKind,
  base64UrlDecode,
  type ProviderInfo,
  type ProviderTokens,
  type SessionIdentity,
} from '@mcp-toolkit/core';
import { buildPolicySubject, type PolicyEnforcer } from '@mcp-toolkit/policy';
import type { SessionRecord } from '@mcp-toolkit/storage';
import type { AuditCatalogListEvent } from './audit-event.ts';
import type { PromptDefinition, ResourceDefinition, ToolDefinition } from './types.ts';

export const MCP_CATALOG_LIST_METHODS = new Set([
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
]);

export function isMcpCatalogListMethod(method: string | undefined): boolean {
  return typeof method === 'string' && MCP_CATALOG_LIST_METHODS.has(method);
}

/** JWT payload claims safe to log (no PII beyond what IdPs already put in id_token). */
const ALLOWED_ID_TOKEN_CLAIMS = new Set([
  'sub',
  'email',
  'email_verified',
  'name',
  'given_name',
  'family_name',
  'preferred_username',
  'iss',
  'aud',
  'exp',
  'iat',
  'nonce',
  'org_id',
  'organization',
  'groups',
  'memberOf',
  'member_of',
]);

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

function pickAllowlistedClaims(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED_ID_TOKEN_CLAIMS) {
    if (key in payload) {
      const v = payload[key];
      if (key === 'aud' && Array.isArray(v)) {
        out[key] = v.map(String);
      } else if (
        (key === 'groups' || key === 'memberOf' || key === 'member_of') &&
        Array.isArray(v)
      ) {
        out[key] = v.map(String);
      } else {
        out[key] = v;
      }
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function membershipClaimPresence(idToken: string | undefined): {
  groupsKeyPresent: boolean;
  memberOfKeyPresent: boolean;
  member_ofKeyPresent: boolean;
} {
  const payload = idToken ? decodeJwtPayloadUnverified(idToken) : null;
  if (!payload) {
    return {
      groupsKeyPresent: false,
      memberOfKeyPresent: false,
      member_ofKeyPresent: false,
    };
  }
  return {
    groupsKeyPresent: Object.hasOwn(payload, 'groups'),
    memberOfKeyPresent: Object.hasOwn(payload, 'memberOf'),
    member_ofKeyPresent: Object.hasOwn(payload, 'member_of'),
  };
}

function providerAuditFields(provider?: ProviderTokens | ProviderInfo | null):
  | {
      scopes?: string[];
      expiresAt?: number;
      idTokenSub?: string;
      idTokenClaims?: Record<string, unknown>;
      idTokenMembershipClaimPresence?: {
        groupsKeyPresent: boolean;
        memberOfKeyPresent: boolean;
        member_ofKeyPresent: boolean;
      };
    }
  | undefined {
  if (!provider) return undefined;
  let idToken: string | undefined;
  let idTokenSub: string | undefined;
  let scopes: string[] | undefined;
  let expiresAt: number | undefined;
  if ('access_token' in provider) {
    idToken = provider.id_token;
    idTokenSub = provider.id_token_sub;
    scopes = provider.scopes;
    expiresAt = provider.expires_at;
  } else {
    idToken = provider.idToken;
    idTokenSub = provider.idTokenSub;
    scopes = provider.scopes;
    expiresAt = provider.expiresAt;
  }
  const idTokenClaims = idToken
    ? pickAllowlistedClaims(decodeJwtPayloadUnverified(idToken))
    : undefined;
  const idTokenMembershipClaimPresence = idToken
    ? membershipClaimPresence(idToken)
    : undefined;
  if (
    !scopes &&
    !expiresAt &&
    !idTokenSub &&
    !idTokenClaims &&
    !idTokenMembershipClaimPresence
  ) {
    return undefined;
  }
  return {
    scopes,
    expiresAt,
    idTokenSub,
    idTokenClaims,
    ...(idTokenMembershipClaimPresence ? { idTokenMembershipClaimPresence } : {}),
  };
}

function sessionAuditFields(session: SessionRecord | null | undefined):
  | {
      initialized?: boolean;
      protocolVersion?: string;
      sessionApiKeyPrefix?: string;
      hasStoredProvider: boolean;
    }
  | undefined {
  if (!session) return undefined;
  const apiKey = session.apiKey;
  // NOTE (F-10): `sessionApiKeyPrefix` is a redacted prefix of the value the
  // session was bound to at create-time. After F-5 anonymous sessions are
  // bound to a per-Origin bucket key of the form `anon:<Origin>` (e.g.
  // `anon:https://app.example`) rather than a real credential, so the prefix
  // string for anon traffic will start with `anon:` and leak the Origin
  // scheme into logs. This is intentional — operators correlating sessions
  // to credentials should filter on the `anon:` prefix to separate real-
  // credential sessions from the per-Origin anonymous bucket. The field name
  // is preserved (renaming would break log consumers); the prefix shape is
  // the discriminator.
  return {
    initialized: session.initialized,
    protocolVersion: session.protocolVersion,
    ...(apiKey
      ? {
          sessionApiKeyPrefix: apiKey.length <= 8 ? '***' : `${apiKey.slice(0, 8)}...`,
        }
      : {}),
    hasStoredProvider: Boolean(session.provider),
  };
}

function buildPolicyAuditBlock(params: {
  methods: string[];
  policy?: PolicyEnforcer;
  tools: ToolDefinition[];
  prompts: PromptDefinition[];
  resources: ResourceDefinition[];
  /**
   * Pre-resolved identity from {@link resolveIdentityForMcp}. The caller
   * resolves once and passes it in so the same identity feeds both the
   * top-level `subject` field and the policy block (and `buildPolicySubject`
   * is invoked once).
   */
  resolvedIdentity: SessionIdentity | null;
}): Record<string, unknown> | undefined {
  const { methods, policy, tools, prompts, resources, resolvedIdentity } = params;
  const enforced = Boolean(policy?.isEnforced());

  const subject = buildPolicySubject(
    resolvedIdentity,
    policy?.policy.principal_aliases,
  );
  const principalGroups = [...subject.groupSet].sort();

  const catalogVisibility: Record<string, unknown> = {};

  if (methods.includes('tools/list')) {
    const catalog = tools.map((t) => ({ name: t.name }));
    const visibleList =
      enforced && policy ? policy.filterTools(catalog, subject) : catalog;
    const visibleNames = visibleList.map((t) => t.name).sort();
    const allNames = catalog.map((t) => t.name).sort();
    catalogVisibility.toolsList = {
      visibleCount: visibleNames.length,
      totalCount: catalog.length,
      visibleNames,
      deniedNames: allNames.filter((n) => !visibleNames.includes(n)),
    };
  }

  if (methods.includes('prompts/list')) {
    const catalog = prompts.map((p) => ({ name: p.name }));
    const visibleList =
      enforced && policy ? policy.filterPrompts(catalog, subject) : catalog;
    const visibleNames = visibleList.map((p) => p.name).sort();
    const allNames = catalog.map((p) => p.name).sort();
    catalogVisibility.promptsList = {
      visibleCount: visibleNames.length,
      totalCount: catalog.length,
      visibleNames,
      deniedNames: allNames.filter((n) => !visibleNames.includes(n)),
    };
  }

  if (methods.includes('resources/list')) {
    const catalog = resources.map((r) => ({ uri: r.uri }));
    const visibleList =
      enforced && policy ? policy.filterResources(catalog, subject) : catalog;
    const visibleUris = visibleList.map((r) => r.uri).sort();
    const allUris = catalog.map((r) => r.uri).sort();
    catalogVisibility.resourcesList = {
      visibleCount: visibleUris.length,
      totalCount: catalog.length,
      visibleUris,
      deniedUris: allUris.filter((u) => !visibleUris.includes(u)),
    };
  }

  return {
    documentConfigured: Boolean(policy),
    enforced,
    hasSubject: subject.hasSubject,
    principalGroupCount: principalGroups.length,
    ...(principalGroups.length ? { principalGroups } : {}),
    ...(resolvedIdentity?.groups?.length
      ? { identityGroups: [...resolvedIdentity.groups].sort() }
      : {}),
    ...(resolvedIdentity?.memberOf?.length
      ? { identityMemberOf: [...resolvedIdentity.memberOf].sort() }
      : {}),
    ...(Object.keys(catalogVisibility).length ? { catalogVisibility } : {}),
  };
}

/** Truncate a credential to a short prefix for log correlation only. */
export function redactSecretPrefix(
  secret: string | undefined,
  visibleChars = 8,
): string | undefined {
  if (!secret) return undefined;
  const t = secret.trim();
  if (!t) return undefined;
  if (t.length <= visibleChars) return '***';
  return `${t.slice(0, visibleChars)}...`;
}

/**
 * Prefix for the credential the client sent (RS token, API key, or bearer), for correlation only.
 */
export function credentialPrefixFromHeaders(
  authHeaders: Record<string, string> | undefined,
  apiKeyHeader: string,
  rsToken?: string,
): string | undefined {
  if (rsToken) return redactSecretPrefix(rsToken);
  if (!authHeaders) return undefined;
  const lowerHeader = apiKeyHeader.toLowerCase();
  const key =
    authHeaders[lowerHeader] ?? authHeaders['x-api-key'] ?? authHeaders['x-auth-token'];
  if (key) return redactSecretPrefix(key);
  const authz = authHeaders.authorization;
  if (authz) {
    const m = authz.match(/^\s*Bearer\s+(.+)$/i);
    if (m?.[1]) return redactSecretPrefix(m[1].trim());
  }
  return undefined;
}

/**
 * Pure builder: assemble the structured audit event for an MCP catalog-list
 * call. Emission is the {@link AuditSink}'s responsibility — this function
 * has no I/O and no side effects.
 *
 * Mirrors the same data the legacy `logger.info('mcp_user_audit', ...)` call
 * produced, restructured as an {@link AuditCatalogListEvent}.
 */
export function buildCatalogListEvent(params: {
  methods: string[];
  sessionId: string;
  requestId?: string | number;
  // Mirrors the `AuthStrategyKind` literal union from `@mcp-toolkit/auth` via the
  // duplicated copy in `@mcp-toolkit/core` (see `packages/core/src/types/auth.ts`).
  // `@mcp-toolkit/mcp` cannot depend on `@mcp-toolkit/auth` because the dependency
  // direction is auth → mcp, so we narrow against the core mirror instead of
  // the original.
  authStrategy?: AuthStrategyKind;
  credentialPrefix?: string;
  provider?: ProviderTokens | ProviderInfo | null;
  sessionRecord?: SessionRecord | null;
  policy?: PolicyEnforcer;
  tools: ToolDefinition[];
  prompts: PromptDefinition[];
  resources: ResourceDefinition[];
}): AuditCatalogListEvent {
  const {
    methods,
    sessionId,
    requestId,
    authStrategy,
    credentialPrefix,
    provider,
    sessionRecord,
    policy,
    tools,
    prompts,
    resources,
  } = params;

  // Resolve identity once and feed both the top-level `subject` field and the
  // policy block (which would otherwise call `resolveIdentityForMcp` again).
  const resolvedIdentity = resolveIdentityForMcp(
    sessionRecord?.identity,
    provider ?? null,
  );

  const subject =
    resolvedIdentity &&
    (resolvedIdentity.sub !== undefined ||
      resolvedIdentity.email !== undefined ||
      (resolvedIdentity.groups && resolvedIdentity.groups.length > 0))
      ? {
          ...(resolvedIdentity.sub !== undefined ? { sub: resolvedIdentity.sub } : {}),
          ...(resolvedIdentity.email !== undefined
            ? { email: resolvedIdentity.email }
            : {}),
          ...(resolvedIdentity.groups && resolvedIdentity.groups.length > 0
            ? { groups: resolvedIdentity.groups }
            : {}),
        }
      : undefined;

  const policyBlock = buildPolicyAuditBlock({
    methods,
    policy,
    tools,
    prompts,
    resources,
    resolvedIdentity,
  }) as AuditCatalogListEvent['policy'];

  return {
    kind: 'mcp.catalog.list',
    timestamp: new Date().toISOString(),
    sessionId,
    requestId,
    methods,
    authStrategy,
    credentialPrefix,
    subject,
    provider: providerAuditFields(provider),
    session: sessionAuditFields(sessionRecord),
    policy: policyBlock,
  };
}
