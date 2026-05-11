// In-memory storage implementation with TTL, size limits, and cleanup
// Provider-agnostic version from Spotify MCP

import { sharedLogger as logger } from '@mcp-toolkit/core/logger';
import type {
  ProviderTokens,
  RsRecord,
  SessionRecord,
  SessionStore,
  TokenStore,
  Transaction,
} from './interface.ts';
import { MAX_SESSIONS_PER_API_KEY } from './interface.ts';

/** Default TTL for transactions (10 minutes per OAuth spec) */
const DEFAULT_TXN_TTL_MS = 10 * 60 * 1000;

/** Default TTL for authorization codes (10 minutes per OAuth spec) */
const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000;

/** Default TTL for sessions (24 hours) */
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Default TTL for RS tokens (7 days) */
const DEFAULT_RS_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Upper bound applied to `expiresAt` on `restore()`. Caps forgery windows
 * when an attacker can write the snapshot file (requires the encryption key,
 * but defense-in-depth) — without this, a record with `expiresAt: Number.MAX_VALUE`
 * would be treated as live forever. Records with `expiresAt` past this bound
 * are clamped (not rejected) so an honest snapshot with a misconfigured long
 * TTL still loads, just truncated.
 */
const MAX_RESTORE_EXPIRES_AT_MS = 30 * 24 * 60 * 60 * 1000;

/** Maximum number of RS token records */
const MAX_RS_RECORDS = 10_000;

/** Maximum number of transactions */
const MAX_TRANSACTIONS = 1_000;

/** Maximum number of sessions */
const MAX_SESSIONS = 10_000;

/** Cleanup interval (1 minute) */
const CLEANUP_INTERVAL_MS = 60_000;

/**
 * Internal-but-stable shape used by persistent backends (e.g. `FileTokenStore`)
 * to snapshot the RS-token state of a `MemoryTokenStore` without reaching into
 * its private fields.
 *
 * The serialized form is intentionally `RsRecord & { expiresAt: number }` so
 * the on-disk JSON shape matches what `FileTokenStore` historically wrote when
 * it stringified `rsAccessMap.values()` directly. Don't reshape this without
 * also writing a migration in `node/file.ts`.
 *
 * Transactions and OAuth codes are deliberately excluded — they are short-lived
 * flow state and the file backend already declines to persist them.
 */
export interface MemoryTokenSnapshot {
  /** RS-access-token-keyed records, including their expiration timestamp. */
  rsRecords: Array<RsRecord & { expiresAt: number }>;
}

/**
 * Wrapper for entries with expiration time.
 */
interface TimedEntry<T> {
  value: T;
  expiresAt: number;
  createdAt: number;
}

/**
 * LRU-like eviction: remove oldest entries when limit reached.
 */
function evictOldest<K, V extends { created_at?: number; createdAt?: number }>(
  map: Map<K, V>,
  maxSize: number,
  countToRemove = 1,
): void {
  if (map.size < maxSize) return;

  const entries = [...map.entries()].sort((a, b) => {
    const aTime = a[1].created_at ?? a[1].createdAt ?? 0;
    const bTime = b[1].created_at ?? b[1].createdAt ?? 0;
    return aTime - bTime;
  });

  for (let i = 0; i < countToRemove && i < entries.length; i++) {
    map.delete(entries[i][0]);
  }
}

/**
 * Remove expired entries from a timed map.
 */
function cleanupExpired<K, V extends { expiresAt: number }>(map: Map<K, V>): number {
  const now = Date.now();
  let removed = 0;

  for (const [key, entry] of map) {
    if (now >= entry.expiresAt) {
      map.delete(key);
      removed++;
    }
  }

  return removed;
}

export class MemoryTokenStore implements TokenStore {
  protected rsAccessMap = new Map<string, RsRecord & { expiresAt: number }>();
  protected rsRefreshMap = new Map<string, RsRecord & { expiresAt: number }>();
  protected transactions = new Map<string, TimedEntry<Transaction>>();
  protected codes = new Map<string, TimedEntry<string>>();

  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanup();
  }

  /**
   * Start periodic cleanup of expired entries.
   */
  startCleanup(): void {
    if (this.cleanupIntervalId) return;

    this.cleanupIntervalId = setInterval(() => {
      this.cleanup();
    }, CLEANUP_INTERVAL_MS);

    // Don't prevent process exit
    if (
      typeof this.cleanupIntervalId === 'object' &&
      'unref' in this.cleanupIntervalId
    ) {
      this.cleanupIntervalId.unref();
    }
  }

  /**
   * Stop periodic cleanup.
   */
  stopCleanup(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }

  /**
   * Run cleanup of all expired entries.
   */
  cleanup(): { tokens: number; transactions: number; codes: number } {
    const now = Date.now();

    // Clean RS tokens
    let tokensRemoved = 0;
    for (const [key, entry] of this.rsAccessMap) {
      if (now >= entry.expiresAt) {
        this.rsAccessMap.delete(key);
        tokensRemoved++;
      }
    }
    for (const [key, entry] of this.rsRefreshMap) {
      if (now >= entry.expiresAt) {
        this.rsRefreshMap.delete(key);
      }
    }

    const transactionsRemoved = cleanupExpired(this.transactions);
    const codesRemoved = cleanupExpired(this.codes);

    return {
      tokens: tokensRemoved,
      transactions: transactionsRemoved,
      codes: codesRemoved,
    };
  }

  async storeRsMapping(
    rsAccess: string,
    provider: ProviderTokens,
    rsRefresh?: string,
    ttlMs: number = DEFAULT_RS_TOKEN_TTL_MS,
  ): Promise<RsRecord> {
    const now = Date.now();
    const expiresAt = now + ttlMs;

    // Evict oldest if at capacity
    evictOldest(this.rsAccessMap, MAX_RS_RECORDS, 10);

    // Check for existing refresh token record
    if (rsRefresh) {
      const existing = this.rsRefreshMap.get(rsRefresh);
      if (existing) {
        this.rsAccessMap.delete(existing.rs_access_token);
        existing.rs_access_token = rsAccess;
        existing.provider = { ...provider };
        existing.expiresAt = expiresAt;
        this.rsAccessMap.set(rsAccess, existing);
        return existing;
      }
    }

    const record: RsRecord & { expiresAt: number } = {
      rs_access_token: rsAccess,
      rs_refresh_token: rsRefresh ?? crypto.randomUUID(),
      provider: { ...provider },
      created_at: now,
      expiresAt,
    };

    this.rsAccessMap.set(record.rs_access_token, record);
    this.rsRefreshMap.set(record.rs_refresh_token, record);
    return record;
  }

  async getByRsAccess(rsAccess: string): Promise<RsRecord | null> {
    const entry = this.rsAccessMap.get(rsAccess);
    if (!entry) return null;

    // Check expiration
    if (Date.now() >= entry.expiresAt) {
      this.rsAccessMap.delete(rsAccess);
      this.rsRefreshMap.delete(entry.rs_refresh_token);
      return null;
    }

    return entry;
  }

  async getByRsRefresh(rsRefresh: string): Promise<RsRecord | null> {
    const entry = this.rsRefreshMap.get(rsRefresh);
    if (!entry) return null;

    // Check expiration
    if (Date.now() >= entry.expiresAt) {
      this.rsAccessMap.delete(entry.rs_access_token);
      this.rsRefreshMap.delete(rsRefresh);
      return null;
    }

    return entry;
  }

  async updateByRsRefresh(
    rsRefresh: string,
    provider: ProviderTokens,
    maybeNewRsAccess?: string,
    ttlMs: number = DEFAULT_RS_TOKEN_TTL_MS,
  ): Promise<RsRecord | null> {
    const rec = this.rsRefreshMap.get(rsRefresh);
    if (!rec) return null;

    const now = Date.now();

    if (maybeNewRsAccess) {
      this.rsAccessMap.delete(rec.rs_access_token);
      rec.rs_access_token = maybeNewRsAccess;
      rec.created_at = now;
    }

    rec.provider = { ...provider };
    rec.expiresAt = now + ttlMs;

    this.rsAccessMap.set(rec.rs_access_token, rec);
    this.rsRefreshMap.set(rsRefresh, rec);
    return rec;
  }

  async saveTransaction(
    txnId: string,
    txn: Transaction,
    ttlSeconds?: number,
  ): Promise<void> {
    const ttlMs = ttlSeconds ? ttlSeconds * 1000 : DEFAULT_TXN_TTL_MS;
    const now = Date.now();

    // Evict oldest if at capacity
    evictOldest(this.transactions, MAX_TRANSACTIONS, 10);

    this.transactions.set(txnId, {
      value: txn,
      expiresAt: now + ttlMs,
      createdAt: now,
    });
  }

  async getTransaction(txnId: string): Promise<Transaction | null> {
    const entry = this.transactions.get(txnId);
    if (!entry) return null;

    // Check expiration
    if (Date.now() >= entry.expiresAt) {
      this.transactions.delete(txnId);
      return null;
    }

    return entry.value;
  }

  async deleteTransaction(txnId: string): Promise<void> {
    this.transactions.delete(txnId);
  }

  async saveCode(code: string, txnId: string, ttlSeconds?: number): Promise<void> {
    const ttlMs = ttlSeconds ? ttlSeconds * 1000 : DEFAULT_CODE_TTL_MS;
    const now = Date.now();

    this.codes.set(code, {
      value: txnId,
      expiresAt: now + ttlMs,
      createdAt: now,
    });
  }

  async getTxnIdByCode(code: string): Promise<string | null> {
    const entry = this.codes.get(code);
    if (!entry) return null;

    // Check expiration
    if (Date.now() >= entry.expiresAt) {
      this.codes.delete(code);
      return null;
    }

    return entry.value;
  }

  async deleteCode(code: string): Promise<void> {
    this.codes.delete(code);
  }

  /**
   * Get current store statistics.
   */
  getStats(): {
    rsTokens: number;
    transactions: number;
    codes: number;
  } {
    return {
      rsTokens: this.rsAccessMap.size,
      transactions: this.transactions.size,
      codes: this.codes.size,
    };
  }

  /**
   * Snapshot the RS-token state for persistence by an external backend.
   *
   * The returned object is a shallow copy: callers may mutate the outer array
   * and the records inside it without affecting this store, but the nested
   * `provider` objects are shared by reference (the file backend immediately
   * serializes the snapshot, so this is safe in practice and avoids a deep
   * clone on every save).
   *
   * Transactions and authorization codes are intentionally omitted — they are
   * short-lived OAuth flow state and persisting them across restarts would
   * defeat their TTL semantics.
   */
  snapshot(): MemoryTokenSnapshot {
    return {
      rsRecords: Array.from(this.rsAccessMap.values()).map((rec) => ({ ...rec })),
    };
  }

  /**
   * Restore RS-token state from a snapshot. Used by persistent backends on
   * startup. This REPLACES any in-memory RS-token state on this instance;
   * transaction/code state is left untouched.
   *
   * Each record is validated against the `RsRecord & { expiresAt: number }`
   * shape; malformed entries are skipped with a warning rather than written
   * blindly (a missing `rs_access_token` would otherwise become
   * `Map.set(undefined, rec)`, and an attacker-controlled snapshot with a
   * far-future `expiresAt` could forge an identity). `expiresAt` is clamped
   * at `now + MAX_RESTORE_EXPIRES_AT_MS` to limit any forgery window even
   * if the snapshot is honest.
   *
   * Records whose `expiresAt` is already in the past are skipped so a stale
   * snapshot can't resurrect tokens that should already be evicted.
   */
  restore(snap: MemoryTokenSnapshot): void {
    this.rsAccessMap.clear();
    this.rsRefreshMap.clear();

    const now = Date.now();
    const maxExpiresAt = now + MAX_RESTORE_EXPIRES_AT_MS;
    for (const rec of snap.rsRecords) {
      if (!isValidRsRecord(rec)) {
        logger.warning('memory_token_store', {
          message: 'Skipping invalid record during restore',
          rs_access_prefix:
            typeof (rec as { rs_access_token?: unknown })?.rs_access_token === 'string'
              ? ((rec as { rs_access_token: string }).rs_access_token as string).slice(
                  0,
                  8,
                )
              : '<missing>',
        });
        continue;
      }
      if (rec.expiresAt <= now) continue;
      // Clamp far-future expirations to limit forgery windows.
      if (rec.expiresAt > maxExpiresAt) {
        rec.expiresAt = maxExpiresAt;
      }
      this.rsAccessMap.set(rec.rs_access_token, rec);
      this.rsRefreshMap.set(rec.rs_refresh_token, rec);
    }
  }
}

/**
 * Type guard for snapshot records consumed by `MemoryTokenStore.restore()`.
 *
 * Validates the structural shape of `RsRecord & { expiresAt: number }` —
 * non-empty string identifiers, a provider object with a non-empty
 * `access_token`, and a finite numeric `expiresAt`. Optional fields on
 * `ProviderTokens` (`refresh_token`, `expires_at`, `scopes`, `id_token`,
 * `id_token_sub`) are not required and not type-checked here — the snapshot
 * round-trips data this store itself produced, so optional fields are
 * permitted to be `undefined`.
 */
function isValidRsRecord(rec: unknown): rec is RsRecord & { expiresAt: number } {
  if (!rec || typeof rec !== 'object') return false;
  const r = rec as Record<string, unknown>;
  if (typeof r.rs_access_token !== 'string' || !r.rs_access_token) return false;
  if (typeof r.rs_refresh_token !== 'string' || !r.rs_refresh_token) return false;
  if (!r.provider || typeof r.provider !== 'object') return false;
  const p = r.provider as Record<string, unknown>;
  if (typeof p.access_token !== 'string' || !p.access_token) return false;
  if (typeof r.expiresAt !== 'number' || !Number.isFinite(r.expiresAt)) return false;
  if (typeof r.created_at !== 'number' || !Number.isFinite(r.created_at)) return false;
  return true;
}

/** Internal session type with expiration */
type InternalSession = SessionRecord & { expiresAt: number; sessionId: string };

export class MemorySessionStore implements SessionStore {
  protected sessions = new Map<string, InternalSession>();
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanup();
  }

  /**
   * Start periodic cleanup of expired sessions.
   */
  startCleanup(): void {
    if (this.cleanupIntervalId) return;

    this.cleanupIntervalId = setInterval(() => {
      this.cleanup();
    }, CLEANUP_INTERVAL_MS);

    // Don't prevent process exit
    if (
      typeof this.cleanupIntervalId === 'object' &&
      'unref' in this.cleanupIntervalId
    ) {
      this.cleanupIntervalId.unref();
    }
  }

  /**
   * Stop periodic cleanup.
   */
  stopCleanup(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }

  /**
   * Remove expired sessions.
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [sessionId, session] of this.sessions) {
      if (now >= session.expiresAt) {
        this.sessions.delete(sessionId);
        removed++;
      }
    }

    return removed;
  }

  async create(
    sessionId: string,
    apiKey: string,
    ttlMs: number = DEFAULT_SESSION_TTL_MS,
  ): Promise<SessionRecord> {
    // Enforce session limit per API key
    const count = await this.countByApiKey(apiKey);
    if (count >= MAX_SESSIONS_PER_API_KEY) {
      await this.deleteOldestByApiKey(apiKey);
    }

    // Evict oldest globally if at capacity
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort(
        (a, b) => a[1].created_at - b[1].created_at,
      )[0];
      if (oldest) {
        this.sessions.delete(oldest[0]);
      }
    }

    const now = Date.now();
    const record: InternalSession = {
      sessionId,
      apiKey,
      created_at: now,
      last_accessed: now,
      initialized: false,
      expiresAt: now + ttlMs,
    };

    this.sessions.set(sessionId, record);
    return record;
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const now = Date.now();

    // Check expiration
    if (now >= session.expiresAt) {
      this.sessions.delete(sessionId);
      return null;
    }

    // Update last_accessed
    session.last_accessed = now;

    return session;
  }

  async update(sessionId: string, data: Partial<SessionRecord>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const now = Date.now();
    Object.assign(session, data, { last_accessed: now });
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async getByApiKey(apiKey: string): Promise<SessionRecord[]> {
    const results: SessionRecord[] = [];
    const now = Date.now();

    for (const session of this.sessions.values()) {
      if (session.apiKey === apiKey && now < session.expiresAt) {
        results.push(session);
      }
    }

    // Sort by last_accessed descending (most recent first)
    return results.sort((a, b) => b.last_accessed - a.last_accessed);
  }

  async countByApiKey(apiKey: string): Promise<number> {
    let count = 0;
    const now = Date.now();

    for (const session of this.sessions.values()) {
      if (session.apiKey === apiKey && now < session.expiresAt) {
        count++;
      }
    }

    return count;
  }

  async deleteOldestByApiKey(apiKey: string): Promise<void> {
    let oldest: InternalSession | null = null;
    const now = Date.now();

    for (const session of this.sessions.values()) {
      if (session.apiKey === apiKey && now < session.expiresAt) {
        if (!oldest || session.last_accessed < oldest.last_accessed) {
          oldest = session;
        }
      }
    }

    if (oldest) {
      this.sessions.delete(oldest.sessionId);
    }
  }

  /**
   * Get current session count.
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}
