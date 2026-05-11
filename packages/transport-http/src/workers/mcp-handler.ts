/**
 * MCP endpoint handler for the Cloudflare Workers transport.
 *
 * Originally `src/adapters/http-workers/mcp.handler.ts`. The new shape:
 *   - Accepts registries / policy / auth / token+session stores via
 *     `WorkersHandlerDeps` (no global config, no singletons).
 *   - Delegates auth resolution to the injected `AuthStrategy` instead of
 *     the inline parser switch the legacy file carried.
 *   - Threads `registries` and `policy` into `dispatchMcpMethod` via the
 *     `McpDispatchContext`.
 *
 * Strictly no `node:*` imports — Workers safety.
 */

import type { AuthStrategy } from '@mcp-toolkit/auth';
import { extractIdentityFromProvider, identityEquals } from '@mcp-toolkit/auth';
import type { AuthApikeyConfig } from '@mcp-toolkit/auth/config';
import { jsonResponse, sharedLogger as logger, withCors } from '@mcp-toolkit/core';
import type { AuditSink } from '@mcp-toolkit/mcp';
import {
  buildMcpIconsFromConfig,
  type CancellationRegistry,
  dispatchMcpMethod,
  handleMcpNotification,
  type McpDispatchContext,
  type McpSessionState,
  type PromptDefinition,
  providerToToolShape,
  type ResourceDefinition,
  type ToolDefinition,
} from '@mcp-toolkit/mcp';
import type { McpConfig } from '@mcp-toolkit/mcp/config';
import type { PolicyEnforcer } from '@mcp-toolkit/policy';
import type { SessionStore, TokenStore } from '@mcp-toolkit/storage';
import { checkAuthAndChallenge, type WorkersSecurityConfig } from './security.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Per-isolate state
// ─────────────────────────────────────────────────────────────────────────────

const sessionStateMap = new Map<string, McpSessionState>();
const cancellationRegistryMap = new Map<string, CancellationRegistry>();

function getCancellationRegistry(sessionId: string): CancellationRegistry {
  let registry = cancellationRegistryMap.get(sessionId);
  if (!registry) {
    registry = new Map();
    cancellationRegistryMap.set(sessionId, registry);
  }
  return registry;
}

type JsonRpcLike = {
  method?: string;
  params?: Record<string, unknown>;
};

function getJsonRpcMessages(body: unknown): JsonRpcLike[] {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body)) {
    return body.filter((msg) => msg && typeof msg === 'object') as JsonRpcLike[];
  }
  return [body as JsonRpcLike];
}

/**
 * Result of credential resolution. `apiKey` is the value to bind to a session
 * if one was found; `anonymous` indicates no credential is present so the
 * caller must bucket quota by origin/session id instead of the magic
 * `'public'` apiKey (which used to evict every other anon session).
 */
type ResolvedApiKey = { apiKey: string; anonymous: false } | { anonymous: true };

function resolveSessionApiKey(
  headers: Headers,
  apiKeyHeader: string,
  staticApiKey: string | undefined,
): ResolvedApiKey {
  const directApiKey =
    headers.get(apiKeyHeader.toLowerCase()) ||
    headers.get('x-api-key') ||
    headers.get('x-auth-token');
  if (directApiKey) return { apiKey: directApiKey, anonymous: false };

  const authHeader = headers.get('authorization') || headers.get('Authorization');
  if (authHeader) {
    const match = authHeader.match(/^\s*Bearer\s+(.+)$/i);
    return { apiKey: match?.[1] ?? authHeader, anonymous: false };
  }

  if (staticApiKey) return { apiKey: staticApiKey, anonymous: false };

  // No resolvable credential — quota must be bucketed externally (per F-4/F-5,
  // by Origin header) rather than under the literal `'public'` key.
  return { anonymous: true };
}

/**
 * Pick the per-Origin anonymous quota bucket key. Browsers send `Origin`
 * automatically; non-browser anon clients (which generally don't reuse
 * sessions anyway) collapse into a single `anon:unknown` bucket. This
 * caps anonymous DOS exposure: an attacker on one Origin can't evict
 * sessions from another Origin.
 *
 * F-11 trust model: `Origin` is a CLIENT-CONTROLLED header. For browser
 * callers this provides real cross-origin isolation via standard CORS
 * rules (browsers refuse to forge `Origin`). For non-browser callers
 * (curl, server-to-server fetchers, malicious tooling) the value is
 * trivially spoofable — an attacker can set `Origin: https://victim.example`
 * to poison or evict the victim's bucket. Deployments expecting strong
 * isolation against non-browser callers must supplement Origin-based
 * bucketing with a server-side signal: TLS SNI, reverse-proxy-injected
 * client identity, IP-based quota, or upstream auth before this transport
 * sees the request.
 */
function anonOriginBucket(headers: Headers): string {
  const origin = headers.get('Origin') ?? headers.get('origin');
  return `anon:${origin ?? 'unknown'}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nested config slice consumed by the Workers MCP handler. Mirrors the
 * `AppConfig` shape composed in `apps/server/src/config.ts` so the caller
 * can thread already-parsed slices in directly.
 *
 * Note `WorkersSecurityConfig` covers `server.{nodeEnv,allowedOrigins}` +
 * `mcp.protocolVersion`; we inline those into `server`/`mcp` here and project
 * back at the call site.
 */
export interface WorkersHandlerConfig {
  server: {
    /** Runtime environment (`development` / `production` / `test`). */
    nodeEnv: string;
    /** Browser-Origin allowlist (CORS / origin preflight). */
    allowedOrigins: readonly string[];
  };
  /** MCP server metadata + icon descriptor. */
  mcp: McpConfig;
  /** Only the apikey sub-slice is read here (header name + static fallback). */
  auth: {
    apikey: Pick<AuthApikeyConfig, 'key' | 'headerName'>;
  };
}

export interface WorkersHandlerDeps {
  auth: AuthStrategy;
  tokenStore?: TokenStore;
  sessionStore: SessionStore;
  registries: {
    tools: ToolDefinition[];
    prompts: PromptDefinition[];
    resources: ResourceDefinition[];
  };
  policy?: PolicyEnforcer;
  audit?: AuditSink;
  config: WorkersHandlerConfig;
}

/**
 * Project the nested mcp icon slice onto the flat shape `buildMcpIconsFromConfig`
 * still expects. Pure data-shape — keeps this module free of any new auth/mcp
 * surface coupling.
 */
function iconEnvFromConfig(mcp: McpConfig) {
  return {
    MCP_ICON_URL: mcp.icon.url,
    MCP_ICON_MIME: mcp.icon.mime,
    MCP_ICON_SIZES: mcp.icon.sizes,
  };
}

/**
 * Project the WorkersHandlerConfig onto the slice the security preflight
 * needs. The preflight is shared with the Node middleware via the
 * symmetric `SecurityMiddlewareConfig` shape (`server.{nodeEnv,allowedOrigins}`
 * + `mcp.protocolVersion`).
 */
function securityConfigFromHandlerConfig(
  config: WorkersHandlerConfig,
): WorkersSecurityConfig {
  return {
    nodeEnv: config.server.nodeEnv,
    protocolVersion: config.mcp.protocolVersion,
    allowedOrigins: config.server.allowedOrigins,
  };
}

/**
 * Handle MCP POST request.
 */
export async function handleMcpRequest(
  request: Request,
  deps: WorkersHandlerDeps,
): Promise<Response> {
  const { auth, tokenStore, sessionStore, registries, policy, audit, config } = deps;
  const apiKeyHeader = config.auth.apikey.headerName ?? 'x-api-key';

  // Parse JSON-RPC body. A malformed / non-JSON body used to silently become
  // `{}`, then surface as `-32600 Missing method` from the dispatcher (N5).
  // Return a clean JSON-RPC parse error instead.
  let body: {
    jsonrpc?: string;
    method?: string;
    params?: Record<string, unknown>;
    id?: string | number | null;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch (error) {
    logger.warning('mcp_request', {
      message: 'Malformed JSON body',
      error: (error as Error).message,
    });
    return withCors(
      jsonResponse(
        {
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id: null,
        },
        { status: 400 },
      ),
    );
  }

  const { method, params, id } = body;
  const messages = getJsonRpcMessages(body);
  const isInitialize = messages.some((msg) => msg.method === 'initialize');
  const isInitialized = messages.some((msg) => msg.method === 'initialized');
  const initMessage = messages.find((msg) => msg.method === 'initialize');
  const protocolVersion =
    typeof (initMessage?.params as { protocolVersion?: string } | undefined)
      ?.protocolVersion === 'string'
      ? (initMessage?.params as { protocolVersion?: string }).protocolVersion
      : undefined;

  const incomingSessionId = request.headers.get('Mcp-Session-Id')?.trim();
  const sessionId = isInitialize
    ? crypto.randomUUID()
    : incomingSessionId || crypto.randomUUID();
  const resolved = resolveSessionApiKey(
    request.headers,
    apiKeyHeader,
    config.auth.apikey.key,
  );
  // For session-binding comparisons we still need a single string; for
  // anonymous traffic that's the per-Origin bucket. This keeps the
  // takeover-check coherent across requests on the same anon session.
  const apiKey = resolved.anonymous
    ? anonOriginBucket(request.headers)
    : resolved.apiKey;

  if (!isInitialize && !incomingSessionId) {
    return jsonResponse(
      {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: Mcp-Session-Id required' },
        id: null,
      },
      { status: 400 },
    );
  }

  let sessionRecord: Awaited<ReturnType<typeof sessionStore.get>> | null = null;
  if (!isInitialize && incomingSessionId) {
    try {
      sessionRecord = await sessionStore.get(incomingSessionId);
    } catch (error) {
      logger.warning('mcp_session', {
        message: 'Session lookup failed',
        error: (error as Error).message,
      });
    }
    if (!sessionRecord) {
      return withCors(new Response('Invalid session', { status: 404 }));
    }
    if (sessionRecord.apiKey && sessionRecord.apiKey !== apiKey) {
      logger.warning('mcp_session', {
        message: 'Request API key differs from session binding',
        sessionId: incomingSessionId,
        originalApiKey: `${sessionRecord.apiKey.slice(0, 8)}...`,
        requestApiKey: `${apiKey.slice(0, 8)}...`,
      });
      // Hard reject — F3 closes the session-takeover seam. The binding
      // comparison runs UNCONDITIONALLY (F-8): an anonymous request
      // (`apiKey === 'anon:<Origin>'`) can no longer ride a session that
      // was bound to a real credential. The principal binding is whatever
      // it was at create-time — real secret, or per-Origin anon bucket —
      // and cannot be replaced by a different principal (anon or otherwise).
      return withCors(
        new Response(JSON.stringify({ error: 'session_credential_mismatch' }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': incomingSessionId,
            'www-authenticate': `Bearer realm="MCP"`,
          },
        }),
      );
    }
  }

  // Origin / protocol-version preflight. The "no auth header" challenge is
  // produced by the wired strategy's `verify()` below; this preflight is
  // strictly transport-layer hygiene.
  const challengeResponse = await checkAuthAndChallenge(
    request,
    securityConfigFromHandlerConfig(config),
    sessionId,
  );
  if (challengeResponse) {
    return challengeResponse;
  }

  // The strategy's verdict is authoritative. If `verify()` returns `ok: false`,
  // the request is rejected — regardless of `auth.kind`. A third-party adapter
  // that declared `kind: 'none'` but failed `verify()` would previously have
  // had its failure silently swallowed (F-3).
  const verifyResult = await auth.verify(request, { tokenStore });
  if (!verifyResult.ok) {
    const status = verifyResult.challenge?.status ?? 401;
    const headers: Record<string, string> = {
      'Mcp-Session-Id': sessionId,
      ...(verifyResult.challenge?.headers ?? {}),
    };
    const challengeBody = verifyResult.challenge?.body;
    return withCors(
      new Response(
        typeof challengeBody === 'string' ? challengeBody : (challengeBody ?? ''),
        {
          status,
          headers,
        },
      ),
    );
  }

  // Create session record AFTER auth passes (prevents orphans). For
  // anonymous traffic (no resolvable credential — covers `none`, `custom`,
  // and any other strategy that fails to bind a per-request identity) we
  // bucket quota by `anon:<Origin>` instead of the literal `'public'`
  // apiKey. This (F-4 / F-5) caps anonymous DOS at a per-Origin slice:
  // an attacker on one Origin cannot evict sessions from another.
  if (isInitialize) {
    try {
      const quotaKey = resolved.anonymous ? anonOriginBucket(request.headers) : apiKey;
      await sessionStore.create(sessionId, quotaKey);
      if (protocolVersion) {
        await sessionStore.update(sessionId, { protocolVersion });
      }
    } catch (error) {
      logger.warning('mcp_session', {
        message: 'Failed to create session record',
        error: (error as Error).message,
      });
    }
  }

  if (isInitialized) {
    try {
      await sessionStore.update(sessionId, { initialized: true });
    } catch (error) {
      logger.warning('mcp_session', {
        message: 'Failed to update session initialized flag',
        error: (error as Error).message,
      });
    }
  }

  // Persist identity snapshot on the session when available.
  if (incomingSessionId && sessionRecord && verifyResult.identity) {
    if (!identityEquals(sessionRecord.identity, verifyResult.identity)) {
      void sessionStore
        .update(sessionId, { identity: verifyResult.identity })
        .catch((error) =>
          logger.warning('mcp_session', {
            message: 'Failed to persist identity from verifyResult',
            error: (error as Error).message,
          }),
        );
    }
  } else if (incomingSessionId && sessionRecord && verifyResult.provider?.id_token) {
    const identity = extractIdentityFromProvider(verifyResult.provider);
    if (identity && !identityEquals(sessionRecord.identity, identity)) {
      void sessionStore.update(sessionId, { identity }).catch((error) =>
        logger.warning('mcp_session', {
          message: 'Failed to persist identity from provider id_token',
          error: (error as Error).message,
        }),
      );
    }
  }

  const cancellationRegistry = getCancellationRegistry(sessionId);
  const mcpIcons = buildMcpIconsFromConfig(iconEnvFromConfig(config.mcp));

  // Build dispatch context — `registries` and `policy` are passed straight
  // through so the dispatcher does not need a back-edge import.
  const dispatchContext: McpDispatchContext = {
    sessionId,
    auth: {
      sessionId,
      authStrategy: auth.kind,
      providerToken: verifyResult.provider?.access_token,
      provider: providerToToolShape(verifyResult.provider),
      resolvedHeaders: verifyResult.resolvedHeaders,
      identity: verifyResult.identity ?? sessionRecord?.identity,
    },
    config: {
      title: config.mcp.title,
      version: config.mcp.version,
      instructions: config.mcp.instructions,
      ...(mcpIcons ? { icons: mcpIcons } : {}),
    },
    registries,
    policy,
    getSessionState: () => sessionStateMap.get(sessionId),
    setSessionState: (state) => sessionStateMap.set(sessionId, state),
    cancellationRegistry,
    audit,
    sessionRecord,
    apiKeyHeader,
  };

  // Notifications (no id) → 202 Accepted
  if (!('id' in body) || id === null || id === undefined) {
    if (method) {
      handleMcpNotification(method, params, dispatchContext);
    }
    return withCors(new Response(null, { status: 202 }));
  }

  // Dispatch JSON-RPC request
  const result = await dispatchMcpMethod(method, params, dispatchContext, id);

  const response = jsonResponse({
    jsonrpc: '2.0',
    ...(result.error ? { error: result.error } : { result: result.result }),
    id,
  });

  response.headers.set('Mcp-Session-Id', sessionId);
  return withCors(response);
}

/**
 * Handle MCP GET request (returns 405 per spec).
 */
export function handleMcpGet(): Response {
  return withCors(new Response('Method Not Allowed', { status: 405 }));
}

/**
 * Handle MCP DELETE request (session termination).
 */
export async function handleMcpDelete(
  request: Request,
  deps: Pick<WorkersHandlerDeps, 'sessionStore'>,
): Promise<Response> {
  const { sessionStore } = deps;
  const sessionId = request.headers.get('Mcp-Session-Id')?.trim();

  if (!sessionId) {
    return withCors(
      jsonResponse(
        {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: Mcp-Session-Id required' },
          id: null,
        },
        { status: 400 },
      ),
    );
  }

  let existingSession: Awaited<ReturnType<typeof sessionStore.get>> | null = null;
  try {
    existingSession = await sessionStore.get(sessionId);
  } catch (error) {
    logger.warning('mcp_session', {
      message: 'Session lookup failed on DELETE',
      error: (error as Error).message,
    });
  }

  if (!existingSession) {
    return withCors(new Response('Invalid session', { status: 404 }));
  }

  sessionStateMap.delete(sessionId);
  cancellationRegistryMap.delete(sessionId);

  try {
    await sessionStore.delete(sessionId);
    logger.info('mcp_session', {
      message: 'Session terminated via DELETE',
      sessionId,
    });
  } catch (error) {
    logger.warning('mcp_session', {
      message: 'Failed to delete session record',
      error: (error as Error).message,
    });
  }

  return withCors(new Response(null, { status: 202 }));
}
