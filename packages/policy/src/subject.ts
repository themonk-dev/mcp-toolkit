import type { SessionIdentity } from '@mcp-toolkit/core';

export type PolicySubject = {
  groupSet: Set<string>;
  /**
   * True when the IdP identity has a stable principal (sub/email/username) or any resolved group.
   * Used for `allow_groups: ["*"]` (authenticated-only rules).
   */
  hasSubject: boolean;
};

/**
 * Build a normalized policy subject from a session identity snapshot.
 *
 * Note: resolving the live identity (preferring an `id_token` decode over a
 * stored snapshot) is a composition concern owned by `@mcp-toolkit/auth` /
 * `apps/server`, not this package — policy operates on whichever
 * `SessionIdentity` it is handed.
 */
export function buildPolicySubject(
  identity: SessionIdentity | null | undefined,
  aliases?: Record<string, string>,
): PolicySubject {
  const raw: string[] = [];
  if (identity?.groups?.length) raw.push(...identity.groups);
  if (identity?.memberOf?.length) raw.push(...identity.memberOf);

  const groupSet = new Set<string>();
  for (const g of raw) {
    const t = g.trim();
    if (!t) continue;
    const mapped = aliases?.[t] ?? aliases?.[g] ?? t;
    groupSet.add(mapped.trim());
  }

  const hasSubject = Boolean(
    identity?.sub?.trim() ||
      identity?.email?.trim() ||
      identity?.preferred_username?.trim() ||
      groupSet.size > 0,
  );

  return { groupSet, hasSubject };
}
