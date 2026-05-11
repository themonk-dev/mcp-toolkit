/**
 * MCP routes for the Node.js Hono transport.
 *
 * Originally `src/http/routes/mcp.ts`. Significant rewrites vs the legacy
 * version:
 *   1. Auth is read from `c.get('auth')` (populated by the auth middleware)
 *      — no inline header parsing, no `extractIdentityFromProvider` re-decode.
 *   2. The session/transport map is owned by the caller (passed in via
 *      `params`) rather than constructed here.
 *   3. The `policyConfig` thread is gone — the dispatcher and builder
 *      already have a `PolicyEnforcer` injected.
 *   4. `RequestContext` is run through `runWithContext` from
 *      `@mcp-toolkit/mcp/runtime/als-node` (which uses `node:async_hooks`).
 *
 * This is the ONLY file in `@mcp-toolkit/transport-http` that may pull in
 * `node:*` (transitively through the ALS adapter). The Workers transport
 * imports the sibling `als-workers.ts` instead.
 */

import { extractIdentityFromProvider, identityEquals } from '@mcp-toolkit/auth';
import {
  createCancellationToken,
  sharedLogger as logger,
  type RequestContext,
} from '@mcp-toolkit/core';
import type { AuditSink } from '@mcp-toolkit/mcp';
import {
  buildCatalogListEvent,
  credentialPrefixFromHeaders,
  isMcpCatalogListMethod,
  type PromptDefinition,
  type ResourceDefinition,
  type ToolDefinition,
} from '@mcp-toolkit/mcp';
import { runWithContext } from '@mcp-toolkit/mcp/runtime/als-node';
import type { PolicyEnforcer } from '@mcp-toolkit/policy';
import type { SessionStore } from '@mcp-toolkit/storage';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import type { ResolvedAuthContext } from '../middlewares/auth.ts';

export interface McpNodeRoutesOptions {
  /**
   * Factory producing a fresh `McpServer` per session. The MCP SDK's
   * `Protocol` binds one transport per server lifetime, so sharing a single
   * instance across sessions throws "Already connected to a transport" on
   * the second `connect()`. The route owns the per-session lifecycle:
   * builds on `initialize`, closes on `onsessionclosed` / `DELETE`.
   */
  buildServer: () => McpServer;
  /**
   * Registry of live per-session servers — populated by this route on
   * session create and drained on session close. External lifecycle helpers
   * (e.g., the example-4 status updater) read it to fan notifications to
   * every connected client.
   */
  liveServers: Set<McpServer>;
  /**
   * In-memory map keyed by Mcp-Session-Id. Owned by the caller so it can be
   * shared across the entire transport lifetime; the route handler creates,
   * looks up, and deletes entries.
   */
  transports: Map<string, WebStandardStreamableHTTPServerTransport>;
  sessionStore: SessionStore;
  /** Optional audit sink — emits structured catalog-list events when set. */
  audit?: AuditSink;
  /** API key header name (default 'x-api-key'). Used for audit redaction + session resolution. */
  apiKeyHeader?: string;
  /** Static API key from config — used as a fallback for session bookkeeping when no header / Bearer is present. */
  staticApiKey?: string;
  /**
   * Registries — required for `buildCatalogListEvent` to enumerate the
   * catalog when an `audit` sink is set. Pass empty arrays when audit is off.
   */
  registries?: {
    tools: ToolDefinition[];
    prompts: PromptDefinition[];
    resources: ResourceDefinition[];
  };
  /**
   * Optional policy enforcer — only used to feed the audit log; gating is
   * already enforced by the dispatcher / builder.
   */
  policy?: PolicyEnforcer;
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
 * caller must bucket quota by Origin instead of the magic `'public'` apiKey
 * (which used to evict every other anon session).
 */
type ResolvedApiKey = { apiKey: string; anonymous: false } | { anonymous: true };

/**
 * Resolve the API key the session record should be bound to. Mirrors the
 * legacy `resolveSessionApiKey` semantics: a direct API key header beats
 * an RS bearer token, which beats a fallback static API key.
 */
function resolveSessionApiKey(
  auth: ResolvedAuthContext | undefined,
  apiKeyHeader: string,
  staticApiKey: string | undefined,
  rawHeaders: Headers,
): ResolvedApiKey {
  const apiKey =
    rawHeaders.get(apiKeyHeader.toLowerCase()) ??
    rawHeaders.get('x-api-key') ??
    rawHeaders.get('x-auth-token');
  if (apiKey) return { apiKey, anonymous: false };

  if (auth?.rsToken) return { apiKey: auth.rsToken, anonymous: false };

  const authHeader = rawHeaders.get('authorization');
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
 * automatically; non-browser anon clients collapse into a single
 * `anon:unknown` bucket. This caps anonymous DOS exposure: an attacker on
 * one Origin can't evict sessions from another Origin.
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

export function buildMcpRoutes(opts: McpNodeRoutesOptions) {
  const {
    buildServer,
    liveServers,
    transports,
    sessionStore,
    audit,
    apiKeyHeader = 'x-api-key',
    staticApiKey,
    registries,
    policy,
  } = opts;

  const app = new Hono();

  // Each session owns its own `McpServer` (the SDK's `Protocol.connect` is
  // one-shot per server lifetime — see the buildServer factory docstring).
  // Key by session id so DELETE / `onsessionclosed` can close the matching
  // server alongside its transport.
  const servers = new Map<string, McpServer>();

  const MCP_SESSION_HEADER = 'Mcp-Session-Id';

  function disposeSession(sid: string): void {
    const server = servers.get(sid);
    servers.delete(sid);
    if (server) {
      liveServers.delete(server);
      // `server.close()` is async but we don't need to await it on the hot
      // path. Failures here are best-effort cleanup — log and move on.
      void server.close().catch((error) => {
        void logger.warning('mcp', {
          message: 'Failed to close per-session McpServer',
          sessionId: sid,
          error: (error as Error).message,
        });
      });
    }
  }

  /**
   * Shared handler for all HTTP methods. `WebStandardStreamableHTTPServerTransport`
   * accepts a standard Request and returns a standard Response, so we pass
   * `c.req.raw` directly — no `toReqRes`/`toFetchResponse` shim needed.
   */
  async function handleMcpRequest(c: import('hono').Context) {
    let requestId: string | number | undefined;
    // Tracks a session id we registered in `servers`/`liveServers` BEFORE
    // `onsessioninitialized` had a chance to fire. If the request flow throws
    // after we wired up the per-session server but before the transport's
    // init callback populated `transports`, the session is orphaned (no
    // client ever learned its id) — the finally block below cleans it up.
    let createdSessionId: string | undefined;

    try {
      const sessionIdHeader = c.req.header(MCP_SESSION_HEADER) ?? undefined;
      const method = c.req.method;

      // Per the streamable-HTTP spec, only POST carries a JSON-RPC body. GET
      // opens the server-push SSE stream and DELETE closes a session — both
      // are bodiless. The original implementation called `c.req.json()`
      // unconditionally and surfaced a misleading `-32700 Parse error` for
      // those methods, which broke the client-side SSE channel right after
      // `initialize` ("Failed to open SSE stream: Bad Request").
      let body: unknown;
      if (method === 'POST') {
        try {
          body = await c.req.json();
        } catch (error) {
          // Mirror the Workers handler (post-N5): return a clean JSON-RPC parse
          // error rather than silently swallowing the failure and surfacing as
          // a misleading "Mcp-Session-Id required" 400 downstream.
          void logger.warning('mcp_request', {
            message: 'Malformed JSON body',
            error: (error as Error).message,
          });
          return c.json(
            {
              jsonrpc: '2.0',
              error: { code: -32700, message: 'Parse error' },
              id: null,
            },
            400,
          );
        }
      }

      const messages = method === 'POST' ? getJsonRpcMessages(body) : [];
      const isInitialize = messages.some((msg) => msg.method === 'initialize');
      const isInitialized = messages.some((msg) => msg.method === 'initialized');
      const initMessage = messages.find((msg) => msg.method === 'initialize');
      const protocolVersion =
        typeof (initMessage?.params as { protocolVersion?: string } | undefined)
          ?.protocolVersion === 'string'
          ? (initMessage?.params as { protocolVersion?: string }).protocolVersion
          : undefined;

      if (method === 'POST' && !isInitialize && !sessionIdHeader) {
        return c.json(
          {
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: Mcp-Session-Id required',
            },
            id: null,
          },
          400,
        );
      }

      if ((method === 'GET' || method === 'DELETE') && !sessionIdHeader) {
        return c.json(
          {
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method not allowed - no session' },
            id: null,
          },
          405,
        );
      }

      const plannedSid = isInitialize ? crypto.randomUUID() : undefined;
      const sessionId = plannedSid ?? sessionIdHeader;

      const auth = c.get('auth') as ResolvedAuthContext | undefined;
      const resolved = resolveSessionApiKey(
        auth,
        apiKeyHeader,
        staticApiKey,
        c.req.raw.headers,
      );
      // For session-binding comparisons we still need a single string; for
      // anonymous traffic that's the per-Origin bucket. This keeps the
      // takeover-check coherent across requests on the same anon session.
      const apiKey = resolved.anonymous
        ? anonOriginBucket(c.req.raw.headers)
        : resolved.apiKey;

      let existingSession: Awaited<ReturnType<typeof sessionStore.get>> | null = null;
      if (!isInitialize && sessionIdHeader) {
        try {
          existingSession = await sessionStore.get(sessionIdHeader);
        } catch (error) {
          void logger.warning('mcp_session', {
            message: 'Session lookup failed',
            error: (error as Error).message,
          });
        }
        if (!existingSession) {
          const staleTransport = transports.get(sessionIdHeader);
          if (staleTransport) {
            transports.delete(sessionIdHeader);
            staleTransport.close();
          }
          // Belt-and-braces: `transport.close()` should trigger
          // `onsessionclosed` which calls `disposeSession`, but if the
          // transport never finished initializing the callback may not
          // fire. Drop any matching per-session server directly.
          disposeSession(sessionIdHeader);
          return c.text('Invalid session', 404);
        }
      }

      if (
        sessionId &&
        !isInitialize &&
        existingSession?.apiKey &&
        existingSession.apiKey !== apiKey
      ) {
        void logger.warning('mcp_session', {
          message: 'Request API key differs from session binding',
          sessionId,
          originalApiKey: `${existingSession.apiKey.slice(0, 8)}...`,
          requestApiKey: `${apiKey.slice(0, 8)}...`,
        });
        // Hard reject — F3 closes the session-takeover seam. The binding
        // comparison runs UNCONDITIONALLY (F-8): an anonymous request
        // (`apiKey === 'anon:<Origin>'`) can no longer ride a session that
        // was bound to a real credential. The key is whatever principal
        // owns the session — real secret, or per-Origin anon bucket — and
        // it cannot be replaced by a different principal (anon or otherwise).
        c.header('www-authenticate', `Bearer realm="MCP"`);
        return c.json({ error: 'session_credential_mismatch' }, 401);
      }

      if (sessionId && isInitialized) {
        try {
          await sessionStore.update(sessionId, { initialized: true });
        } catch (error) {
          void logger.warning('mcp_session', {
            message: 'Failed to update session initialized flag',
            error: (error as Error).message,
          });
        }
      }

      // Persist identity snapshot onto the session when the strategy already
      // resolved one. The legacy code re-decoded the id_token here; the new
      // auth middleware decodes once, so we just compare-and-store.
      if (sessionId && auth?.identity) {
        if (!identityEquals(existingSession?.identity, auth.identity)) {
          void sessionStore
            .update(sessionId, { identity: auth.identity })
            .catch((error) =>
              logger.warning('mcp_session', {
                message: 'Failed to persist identity from auth context',
                error: (error as Error).message,
              }),
            );
        }
      } else if (sessionId && auth?.provider?.id_token) {
        const identity = extractIdentityFromProvider(auth.provider);
        if (identity && !identityEquals(existingSession?.identity, identity)) {
          void sessionStore.update(sessionId, { identity }).catch((error) =>
            logger.warning('mcp_session', {
              message: 'Failed to persist identity from provider id_token',
              error: (error as Error).message,
            }),
          );
        }
      }

      void logger.info('mcp_request', {
        message: 'Processing MCP request',
        sessionId,
        isInitialize,
        hasSessionIdHeader: !!sessionIdHeader,
        requestMethod: method,
        bodyMethod: messages[0]?.method,
      });

      let transport = sessionIdHeader ? transports.get(sessionIdHeader) : undefined;
      if (!transport) {
        if (!isInitialize) {
          if (sessionIdHeader) {
            void sessionStore.delete(sessionIdHeader).catch((error) =>
              logger.warning('mcp_session', {
                message: 'Failed to delete stale session record',
                sessionId: sessionIdHeader,
                error: (error as Error).message,
              }),
            );
          }
          return c.text('Invalid session', 404);
        }
        const created = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId as string,
          onsessioninitialized: async (sid: string) => {
            transports.set(sid, created);
            try {
              // For anonymous traffic (no resolvable credential — covers
              // `none`, `custom`, and any other strategy that fails to bind a
              // per-request identity) we bucket quota by `anon:<Origin>`
              // instead of the literal `'public'` apiKey. This caps anonymous
              // DOS exposure: an attacker on one Origin cannot evict sessions
              // from another (F-4 / F-5).
              const quotaKey = resolved.anonymous
                ? anonOriginBucket(c.req.raw.headers)
                : apiKey;
              await sessionStore.create(sid, quotaKey);
              if (protocolVersion) {
                await sessionStore.update(sid, { protocolVersion });
              }
            } catch (error) {
              void logger.warning('mcp_session', {
                message: 'Failed to create session record',
                error: (error as Error).message,
              });
            }
            void logger.info('mcp', {
              message: 'Session initialized',
              sessionId: sid,
            });
          },
          onsessionclosed: (sid: string) => {
            transports.delete(sid);
            disposeSession(sid);
            void sessionStore.delete(sid).catch((error) =>
              logger.warning('mcp_session', {
                message: 'Failed to delete session record on close',
                sessionId: sid,
                error: (error as Error).message,
              }),
            );
          },
        });
        transport = created;

        // Build a per-session `McpServer` and bind it to this transport
        // exactly once. Subsequent requests on the same session reuse the
        // transport (and therefore its bound server) via the `transports`
        // map; only the initialize path lands here.
        const sessionServer = buildServer();
        servers.set(sessionId as string, sessionServer);
        liveServers.add(sessionServer);
        try {
          await sessionServer.connect(transport);
        } catch (error) {
          // Connect failed — drop the half-wired server so we don't leak it
          // into liveServers / the per-session map. Surface the error to
          // the outer handler's 500 path.
          disposeSession(sessionId as string);
          throw error;
        }
        // Connect succeeded: the per-session server is now registered in
        // `servers`/`liveServers`. From here on, any throw before the
        // transport's `onsessioninitialized` callback populates `transports`
        // would orphan the entry. The outer `finally` below witnesses this
        // by checking `transports.get(createdSessionId)` and cleans up.
        createdSessionId = sessionId as string;
      }

      transport.onerror = (error) => {
        void logger.error('transport', {
          message: 'Transport error',
          error: error.message,
        });
      };

      requestId =
        body && typeof body === 'object' && 'id' in body
          ? (body.id as string | number)
          : undefined;

      const catalogMethods = messages
        .map((msg) => msg.method)
        .filter((m): m is string => typeof m === 'string' && isMcpCatalogListMethod(m));
      if (audit && catalogMethods.length > 0) {
        const sid = (plannedSid ?? sessionIdHeader ?? sessionId) as string;
        void audit.emit(
          buildCatalogListEvent({
            methods: catalogMethods,
            sessionId: sid,
            requestId,
            authStrategy: auth?.kind,
            credentialPrefix: credentialPrefixFromHeaders(
              auth?.resolvedHeaders,
              apiKeyHeader,
              auth?.rsToken,
            ),
            provider: auth?.provider,
            sessionRecord: existingSession,
            policy,
            tools: registries?.tools ?? [],
            prompts: registries?.prompts ?? [],
            resources: registries?.resources ?? [],
          }),
        );
      }

      const requestContext: RequestContext = {
        sessionId: plannedSid ?? sessionIdHeader,
        cancellationToken: createCancellationToken(),
        requestId,
        timestamp: Date.now(),
        authStrategy: auth?.kind,
        resolvedHeaders: auth?.resolvedHeaders,
        providerToken: auth?.providerToken,
        provider: auth?.provider,
        rsToken: auth?.rsToken,
        identity: auth?.identity ?? existingSession?.identity,
      };

      const response = await runWithContext(requestContext, () =>
        transport.handleRequest(c.req.raw, { parsedBody: body }),
      );

      if (method === 'DELETE' && sessionIdHeader) {
        void logger.info('mcp', {
          message: 'Session terminated via DELETE',
          sessionId: sessionIdHeader,
        });
        transports.delete(sessionIdHeader);
        transport.close();
        disposeSession(sessionIdHeader);
        await sessionStore.delete(sessionIdHeader).catch((error) =>
          logger.warning('mcp_session', {
            message: 'Failed to delete session record on DELETE',
            sessionId: sessionIdHeader,
            error: (error as Error).message,
          }),
        );
      }

      return response;
    } catch (error) {
      void logger.error('mcp', {
        message: 'Error handling request',
        error: (error as Error).message,
      });
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        },
        500,
      );
    } finally {
      // Defense-in-depth orphan sweep: if we registered a per-session server
      // (post-`connect`) but the transport's `onsessioninitialized` callback
      // never fired — e.g. `transport.handleRequest` threw before it ran —
      // the entry would otherwise leak forever. `transports.has` is the
      // witness: a successful initialize populates it from inside the
      // callback. If it's missing, no client ever learned the session id,
      // so dispose. The other lifecycle paths (DELETE, onsessionclosed,
      // !existingSession 404, sessionServer.connect catch) already call
      // `disposeSession` and either run BEFORE `createdSessionId` is set or
      // remove the `transports` entry, so this guard won't double-dispose.
      if (createdSessionId !== undefined && !transports.has(createdSessionId)) {
        disposeSession(createdSessionId);
      }
    }
  }

  app.post('/', handleMcpRequest);
  app.get('/', handleMcpRequest);
  app.delete('/', handleMcpRequest);

  return app;
}
