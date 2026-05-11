import { afterEach, describe, expect, it } from 'bun:test';
import { MAX_SESSIONS_PER_API_KEY } from './interface.ts';
import { MemorySessionStore, MemoryTokenStore } from './memory.ts';

describe('storage/memory/MemoryTokenStore', () => {
  const stores: Array<MemoryTokenStore> = [];
  afterEach(() => {
    while (stores.length) stores.pop()?.stopCleanup();
  });

  it('puts a record, fetches it back via rs_access, and deletes via internal map', async () => {
    const store = new MemoryTokenStore();
    stores.push(store);

    const provider = {
      access_token: 'upstream-access',
      refresh_token: 'upstream-refresh',
      expires_at: Date.now() + 60_000,
    };
    const record = await store.storeRsMapping('rs-access-1', provider, 'rs-refresh-1');
    expect(record.rs_access_token).toBe('rs-access-1');
    expect(record.rs_refresh_token).toBe('rs-refresh-1');
    expect(record.provider.access_token).toBe('upstream-access');

    const got = await store.getByRsAccess('rs-access-1');
    expect(got?.rs_access_token).toBe('rs-access-1');

    const byRefresh = await store.getByRsRefresh('rs-refresh-1');
    expect(byRefresh?.rs_access_token).toBe('rs-access-1');

    expect(await store.getByRsAccess('does-not-exist')).toBeNull();
  });

  it('honors expiry of stored records via the internal expiresAt timestamp', async () => {
    const store = new MemoryTokenStore();
    stores.push(store);

    // Insert with a TTL deterministically in the past so the record is
    // expired the moment it is stored — no clock-resolution race.
    // The concrete class accepts an optional ttlMs as the 4th positional arg.
    await (
      store.storeRsMapping as (
        rsAccess: string,
        provider: { access_token: string },
        rsRefresh?: string,
        ttlMs?: number,
      ) => Promise<unknown>
    )('rs-expiring', { access_token: 'aa' }, 'rs-expiring-refresh', -1_000);

    // Read the internal expiresAt and assert it is strictly in the past.
    const internal = (
      store as unknown as {
        rsAccessMap: Map<string, { expiresAt: number }>;
      }
    ).rsAccessMap.get('rs-expiring');
    expect(internal).toBeDefined();
    expect(internal!.expiresAt).toBeLessThan(Date.now());

    // Public API treats it as expired and returns null (also evicting the entry).
    expect(await store.getByRsAccess('rs-expiring')).toBeNull();
  });

  it('persists transactions and codes within their TTL window', async () => {
    const store = new MemoryTokenStore();
    stores.push(store);

    await store.saveTransaction('txn-1', {
      codeChallenge: 'c',
      createdAt: Date.now(),
    });
    expect((await store.getTransaction('txn-1'))?.codeChallenge).toBe('c');

    await store.saveCode('code-1', 'txn-1');
    expect(await store.getTxnIdByCode('code-1')).toBe('txn-1');

    await store.deleteCode('code-1');
    expect(await store.getTxnIdByCode('code-1')).toBeNull();
  });
});

describe('storage/memory/MemoryTokenStore snapshot/restore', () => {
  const stores: Array<MemoryTokenStore> = [];
  afterEach(() => {
    while (stores.length) stores.pop()?.stopCleanup();
  });

  it('snapshot() returns a populated shape after storeRsMapping', async () => {
    const store = new MemoryTokenStore();
    stores.push(store);

    await store.storeRsMapping(
      'rs-access-snap',
      { access_token: 'up-access', refresh_token: 'up-refresh' },
      'rs-refresh-snap',
    );

    const snap = store.snapshot();
    expect(snap.rsRecords.length).toBe(1);
    expect(snap.rsRecords[0].rs_access_token).toBe('rs-access-snap');
    expect(snap.rsRecords[0].rs_refresh_token).toBe('rs-refresh-snap');
    expect(snap.rsRecords[0].provider.access_token).toBe('up-access');
    expect(typeof snap.rsRecords[0].expiresAt).toBe('number');
    expect(snap.rsRecords[0].expiresAt).toBeGreaterThan(Date.now());
  });

  it('restore(snap) repopulates so getByRsAccess and getByRsRefresh work', async () => {
    const source = new MemoryTokenStore();
    stores.push(source);
    await source.storeRsMapping(
      'rs-access-restore',
      { access_token: 'src-access' },
      'rs-refresh-restore',
    );
    const snap = source.snapshot();

    const target = new MemoryTokenStore();
    stores.push(target);
    target.restore(snap);

    const byAccess = await target.getByRsAccess('rs-access-restore');
    expect(byAccess?.provider.access_token).toBe('src-access');
    expect(byAccess?.rs_refresh_token).toBe('rs-refresh-restore');

    const byRefresh = await target.getByRsRefresh('rs-refresh-restore');
    expect(byRefresh?.rs_access_token).toBe('rs-access-restore');
  });

  it('restore() skips records missing rs_access_token', async () => {
    const store = new MemoryTokenStore();
    stores.push(store);

    const now = Date.now();
    store.restore({
      // Cast away the type so we can feed a malformed record — this mirrors
      // what would happen if `.data/tokens.json` were tampered with on disk.
      rsRecords: [
        {
          // rs_access_token deliberately omitted
          rs_refresh_token: 'rs-orphan-refresh',
          provider: { access_token: 'orphan' },
          created_at: now,
          expiresAt: now + 60_000,
        } as unknown as Parameters<typeof store.restore>[0]['rsRecords'][0],
      ],
    });

    expect(await store.getByRsRefresh('rs-orphan-refresh')).toBeNull();
    expect(
      (store as unknown as { rsAccessMap: Map<unknown, unknown> }).rsAccessMap.size,
    ).toBe(0);
  });

  it('restore() skips records with non-string types or missing provider', async () => {
    const store = new MemoryTokenStore();
    stores.push(store);

    const now = Date.now();
    store.restore({
      rsRecords: [
        // rs_access_token is a number
        {
          rs_access_token: 123,
          rs_refresh_token: 'rs-a-refresh',
          provider: { access_token: 'a' },
          created_at: now,
          expiresAt: now + 60_000,
        },
        // provider missing
        {
          rs_access_token: 'rs-b',
          rs_refresh_token: 'rs-b-refresh',
          created_at: now,
          expiresAt: now + 60_000,
        },
        // provider.access_token empty
        {
          rs_access_token: 'rs-c',
          rs_refresh_token: 'rs-c-refresh',
          provider: { access_token: '' },
          created_at: now,
          expiresAt: now + 60_000,
        },
        // expiresAt not finite
        {
          rs_access_token: 'rs-d',
          rs_refresh_token: 'rs-d-refresh',
          provider: { access_token: 'd' },
          created_at: now,
          expiresAt: Number.POSITIVE_INFINITY,
        },
      ] as unknown as Parameters<typeof store.restore>[0]['rsRecords'],
    });

    expect(
      (store as unknown as { rsAccessMap: Map<unknown, unknown> }).rsAccessMap.size,
    ).toBe(0);
  });

  it('restore() clamps far-future expiresAt to limit forgery windows', () => {
    const store = new MemoryTokenStore();
    stores.push(store);

    const now = Date.now();
    store.restore({
      rsRecords: [
        {
          rs_access_token: 'rs-forge',
          rs_refresh_token: 'rs-forge-refresh',
          provider: { access_token: 'forge' },
          created_at: now,
          // Year 275760 — would be live forever absent clamping.
          expiresAt: Number.MAX_SAFE_INTEGER,
        },
      ],
    });

    const internal = (
      store as unknown as {
        rsAccessMap: Map<string, { expiresAt: number }>;
      }
    ).rsAccessMap.get('rs-forge');
    expect(internal).toBeDefined();
    // 30-day cap: must be at most now + 30 days (with a small fudge for
    // clock drift between restore() and this assertion).
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(internal!.expiresAt).toBeLessThanOrEqual(Date.now() + thirtyDaysMs);
    expect(internal!.expiresAt).toBeGreaterThan(now);
  });

  it('restore() drops already-expired records and clears any prior state', async () => {
    const store = new MemoryTokenStore();
    stores.push(store);

    // Seed with a live record so we can prove restore() clears it.
    await store.storeRsMapping(
      'rs-pre-existing',
      { access_token: 'p' },
      'rs-pre-existing-refresh',
    );

    const now = Date.now();
    store.restore({
      rsRecords: [
        {
          rs_access_token: 'rs-live',
          rs_refresh_token: 'rs-live-refresh',
          provider: { access_token: 'live' },
          created_at: now,
          expiresAt: now + 60_000,
        },
        {
          rs_access_token: 'rs-dead',
          rs_refresh_token: 'rs-dead-refresh',
          provider: { access_token: 'dead' },
          created_at: now - 120_000,
          expiresAt: now - 60_000,
        },
      ],
    });

    expect(await store.getByRsAccess('rs-pre-existing')).toBeNull();
    expect((await store.getByRsAccess('rs-live'))?.provider.access_token).toBe('live');
    expect(await store.getByRsAccess('rs-dead')).toBeNull();
  });
});

describe('storage/memory/MemorySessionStore', () => {
  const stores: Array<MemorySessionStore> = [];
  afterEach(() => {
    while (stores.length) stores.pop()?.stopCleanup();
  });

  it('supports the create/get/update/delete lifecycle', async () => {
    const store = new MemorySessionStore();
    stores.push(store);

    const created = await store.create('s1', 'k1');
    expect(created.apiKey).toBe('k1');
    expect(created.initialized).toBe(false);

    const got = await store.get('s1');
    expect(got).not.toBeNull();
    expect(got!.apiKey).toBe('k1');

    await store.update('s1', { initialized: true, protocolVersion: '2025-03-26' });
    const updated = await store.get('s1');
    expect(updated?.initialized).toBe(true);
    expect(updated?.protocolVersion).toBe('2025-03-26');

    await store.delete('s1');
    expect(await store.get('s1')).toBeNull();
  });

  it('caps active sessions per API key at MAX_SESSIONS_PER_API_KEY via LRU eviction', async () => {
    const store = new MemorySessionStore();
    stores.push(store);

    const apiKey = 'tenant-a';

    // Fill exactly to the cap.
    for (let i = 0; i < MAX_SESSIONS_PER_API_KEY; i++) {
      await store.create(`s${i}`, apiKey);
    }
    expect(await store.countByApiKey(apiKey)).toBe(MAX_SESSIONS_PER_API_KEY);

    // The oldest session is the one created first; touching others promotes them
    // via last_accessed so the eviction target remains s0.
    for (let i = 1; i < MAX_SESSIONS_PER_API_KEY; i++) {
      await store.get(`s${i}`);
    }

    // One more create must trigger LRU eviction; total stays at the cap.
    await store.create('s-new', apiKey);
    expect(await store.countByApiKey(apiKey)).toBe(MAX_SESSIONS_PER_API_KEY);

    // The oldest (least-recently-accessed) session was dropped.
    expect(await store.get('s0')).toBeNull();
    expect(await store.get('s-new')).not.toBeNull();
  });
});
