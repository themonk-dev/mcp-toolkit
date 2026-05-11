/**
 * Audit event shapes emitted by the MCP dispatcher into an `AuditSink`.
 *
 * Two variants:
 *   - `mcp.tool.call`     — terminal record for a single `tools/call`
 *   - `mcp.catalog.list`  — list-method snapshot (tools/prompts/resources)
 *
 * Discriminated by `kind`. All fields beyond the discriminator are
 * intentionally optional so callers can emit progressively-enriched
 * events without coupling to the dispatcher's internal state machine.
 */

import type { AuthStrategy } from '@mcp-toolkit/core';

export interface AuditSubject {
  sub?: string;
  email?: string;
  groups?: string[];
}

export interface AuditToolCallEvent {
  kind: 'mcp.tool.call';
  timestamp: string;
  sessionId: string;
  requestId?: string | number;
  tool: string;
  outcome: 'ok' | 'error' | 'denied' | 'cancelled';
  durationMs?: number;
  authStrategy?: AuthStrategy;
  credentialPrefix?: string;
  subject?: AuditSubject;
  policyEnforced?: boolean;
  principalGroups?: string[];
  errorMessage?: string;
}

export interface AuditCatalogListEvent {
  kind: 'mcp.catalog.list';
  timestamp: string;
  sessionId: string;
  requestId?: string | number;
  methods: string[];
  authStrategy?: AuthStrategy;
  credentialPrefix?: string;
  subject?: AuditSubject;
  provider?: {
    scopes?: string[];
    expiresAt?: number;
    idTokenSub?: string;
    idTokenClaims?: Record<string, unknown>;
    idTokenMembershipClaimPresence?: {
      groupsKeyPresent: boolean;
      memberOfKeyPresent: boolean;
      member_ofKeyPresent: boolean;
    };
  };
  session?: {
    initialized?: boolean;
    protocolVersion?: string;
    sessionApiKeyPrefix?: string;
    hasStoredProvider: boolean;
  };
  policy?: {
    documentConfigured: boolean;
    enforced: boolean;
    hasSubject: boolean;
    principalGroupCount: number;
    principalGroups?: string[];
    identityGroups?: string[];
    identityMemberOf?: string[];
    catalogVisibility?: Record<string, unknown>;
  };
}

export type AuditEvent = AuditToolCallEvent | AuditCatalogListEvent;
