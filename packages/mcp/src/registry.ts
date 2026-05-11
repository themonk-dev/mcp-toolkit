/**
 * Per-request context registry.
 *
 * Maps JSON-RPC request IDs to live `RequestContext` records, including
 * cancellation tokens. The dispatcher and the auth middleware coordinate
 * through this registry — entries are explicitly created when a request
 * lands and explicitly deleted when it completes.
 *
 * No `node:*` imports — this file is runtime-agnostic. AsyncLocalStorage
 * lives in `runtime/als-{node,workers}.ts`.
 */

import {
  type CancellationToken,
  createCancellationToken,
  sharedLogger as logger,
  type RequestContext,
  type SessionIdentity,
} from '@mcp-toolkit/core';

/**
 * Registry for per-request contexts.
 *
 * Follows SDK best practice: event-driven cleanup (delete on response/close)
 * rather than relying on periodic timers. The optional cleanup interval below
 * is a safety net only.
 */
class ContextRegistry {
  private contexts = new Map<string | number, RequestContext>();

  /**
   * Create and register a new request context.
   */
  create(
    requestId: string | number,
    sessionId?: string,
    authData?: {
      authStrategy?: RequestContext['authStrategy'];
      resolvedHeaders?: RequestContext['resolvedHeaders'];
      rsToken?: string;
      providerToken?: string;
      provider?: RequestContext['provider'];
      identity?: SessionIdentity;
    },
  ): RequestContext {
    const context: RequestContext = {
      sessionId,
      cancellationToken: createCancellationToken(),
      requestId,
      timestamp: Date.now(),
      authStrategy: authData?.authStrategy,
      resolvedHeaders: authData?.resolvedHeaders,
      rsToken: authData?.rsToken,
      providerToken: authData?.providerToken,
      provider: authData?.provider,
      identity: authData?.identity,
    };

    this.contexts.set(requestId, context);
    return context;
  }

  /** Get the context for a request ID. */
  get(requestId: string | number): RequestContext | undefined {
    return this.contexts.get(requestId);
  }

  /** Get the cancellation token for a request ID. */
  getCancellationToken(requestId: string | number): CancellationToken | undefined {
    return this.contexts.get(requestId)?.cancellationToken;
  }

  /** Cancel a request by its ID. Returns true if the context existed. */
  cancel(requestId: string | number, _reason?: string): boolean {
    const context = this.contexts.get(requestId);
    if (!context) return false;

    context.cancellationToken.cancel();
    return true;
  }

  /**
   * Delete a request context.
   * Call this when the request completes (response sent, connection closed,
   * or error).
   */
  delete(requestId: string | number): boolean {
    return this.contexts.delete(requestId);
  }

  /**
   * Delete all contexts for a session.
   * Call this when session is terminated (DELETE /mcp or transport close).
   */
  deleteBySession(sessionId: string): number {
    let deleted = 0;
    for (const [requestId, context] of this.contexts.entries()) {
      if (context.sessionId === sessionId) {
        this.contexts.delete(requestId);
        deleted++;
      }
    }
    if (deleted > 0) {
      logger.debug('context_registry', {
        message: 'Cleaned up contexts for session',
        sessionId,
        count: deleted,
      });
    }
    return deleted;
  }

  /** Get current context count (for monitoring/debugging). */
  get size(): number {
    return this.contexts.size;
  }

  /**
   * Clean up expired contexts (safety net for orphaned requests).
   * This should NOT be relied upon for normal operation — prefer explicit
   * delete() calls in the request lifecycle.
   */
  cleanupExpired(maxAgeMs = 10 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [requestId, context] of this.contexts.entries()) {
      if (now - context.timestamp > maxAgeMs) {
        this.contexts.delete(requestId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.warning('context_registry', {
        message: 'Cleaned up expired contexts (this indicates missing cleanup calls)',
        count: cleaned,
        maxAgeMs,
      });
    }

    return cleaned;
  }

  /** Clear all contexts (for shutdown or testing). */
  clear(): void {
    this.contexts.clear();
  }
}

/** Global context registry instance. */
export const contextRegistry = new ContextRegistry();

/** Interval handle for optional safety-net cleanup. */
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Start optional periodic cleanup as a safety net for orphaned contexts.
 *
 * NOTE: This is a defensive measure, not the primary cleanup mechanism.
 * Primary cleanup should happen via explicit delete() calls when:
 * - Response is sent
 * - Connection closes
 * - Request errors
 *
 * @param intervalMs - How often to run cleanup (default: 60 seconds)
 * @param maxAgeMs - Maximum age before context is considered expired (default: 10 minutes)
 */
export function startContextCleanup(
  intervalMs = 60_000,
  maxAgeMs = 10 * 60 * 1000,
): void {
  if (cleanupIntervalId) return;
  cleanupIntervalId = setInterval(() => {
    contextRegistry.cleanupExpired(maxAgeMs);
  }, intervalMs);
  // Prevent interval from keeping process alive
  cleanupIntervalId.unref?.();
}

/**
 * Stop the cleanup interval.
 * Call this during graceful shutdown.
 */
export function stopContextCleanup(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
}
