/**
 * F3 + G1 regressions for the session binding and anonymous quota.
 *
 *   1. Session credential mismatch → 401. Pre-F3 the transport only logged a
 *      `warning` when a request's resolved API key differed from the key the
 *      session was bound to at create-time; now it hard-rejects (closes the
 *      session-takeover seam).
 *
 *   2. Anonymous DOS quota. Pre-F3 every anonymous (`none` strategy) session
 *      was bucketed under the literal `'public'` apiKey, so once
 *      MAX_SESSIONS_PER_API_KEY (=5) was reached, every new anon initialize
 *      would evict an existing anon session. F3 bucketed per-session id which
 *      removed per-API-key DOS but left the global `MAX_SESSIONS` cap as the
 *      only protection — a single attacker could exhaust it.
 *
 *   3. G1 F-5: anon traffic is bucketed by `anon:<Origin>` so an attacker
 *      hammering one Origin cannot evict sessions from a different Origin.
 *      Within a single Origin the per-API-key cap still applies (LRU
 *      eviction). G1 F-4 extends the anonymous-detection from `kind === 'none'`
 *      to "no resolvable credential" so `customHeadersStrategy` (kind: 'custom')
 *      and similar paths get the same treatment.
 *
 * Note on origins: the per-Origin tests run in `NODE_ENV=production` with an
 * explicit `ALLOWED_ORIGINS` allowlist; the security middleware in dev mode
 * only accepts loopback origins, which would block any cross-origin test.
 */

import { describe, expect, it } from 'bun:test';
import { MAX_SESSIONS_PER_API_KEY } from '@mcp-toolkit/storage';
import { bootWorkers } from './__helpers__/harness.ts';
import { callMcp, initializeSession } from './__helpers__/mcp.ts';

describe('sessions: credential mismatch on a known session → 401', () => {
  it('rejects tools/list when the apiKey header differs from the binding (workers)', async () => {
    const { app, runtime } = await bootWorkers({
      AUTH_STRATEGY: 'apikey',
      API_KEY: 'A',
    });

    const init = await initializeSession(app, { 'x-api-key': 'A' });
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();

    // Hand-fake a second apikey by mutating the stored session binding so
    // we can present a mismatching credential without booting a second
    // strategy. The strategy itself only knows about key 'A'; we want to
    // assert the transport's session-takeover gate, not the strategy's
    // verify gate.
    await runtime.sessionStore.update(init.sessionId, { apiKey: 'B' });

    const call = await callMcp(
      app,
      init.sessionId,
      'tools/list',
      {},
      { 'x-api-key': 'A' },
    );
    expect(call.status).toBe(401);
  });
});

describe('sessions: anonymous request on a credentialed session → 401 (H1 F-8)', () => {
  // Pre-H1 the session-takeover gate was guarded by `!resolved.anonymous`,
  // so an attacker who guessed or stole an `Mcp-Session-Id` could ride a
  // credentialed session simply by sending NO credential header
  // (`resolved.anonymous === true` skipped the binding check). F-8 compares
  // the request's bucket key (real apiKey or `anon:<Origin>`) to the
  // session's bound apiKey UNCONDITIONALLY.
  it('rejects anon request on a session bound to a real apiKey (workers)', async () => {
    const { app, runtime } = await bootWorkers({
      AUTH_STRATEGY: 'none',
    });

    // Boot a session through `none` (so no credentials are required for
    // initialize). Then bind it to a real apiKey to simulate a session
    // that was originally created by an authenticated client.
    const init = await initializeSession(app);
    expect(init.status).toBe(200);
    await runtime.sessionStore.update(init.sessionId, { apiKey: 'real-secret' });

    // Follow-up: anonymous request — no apiKey, no Bearer, no Origin.
    // Before F-8 this slipped past the binding check because
    // `resolved.anonymous === true`. After F-8 it 401s — the bucket key
    // `anon:unknown` does not match the session's `'real-secret'` binding.
    const call = await callMcp(app, init.sessionId, 'tools/list', {});
    expect(call.status).toBe(401);
  });

  it('rejects anon request on a session bound to a different anon Origin (workers)', async () => {
    // A subtler variant: the session was bound to `anon:https://A.example`
    // (a legitimate anon client on Origin A). An attacker spoofing a
    // different Origin gets a different bucket key (`anon:https://B.example`)
    // and is rejected. Within F-11 limits — non-browser callers can spoof
    // Origin — but the binding gate still enforces "one principal per
    // session lifetime."
    const A = 'https://a.example';
    const B = 'https://b.example';
    const { app } = await bootWorkers({
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: `${A},${B}`,
      AUTH_STRATEGY: 'none',
    });

    const init = await initializeSession(app, { Origin: A });
    expect(init.status).toBe(200);

    const call = await callMcp(app, init.sessionId, 'tools/list', {}, { Origin: B });
    expect(call.status).toBe(401);
  });
});

describe('sessions: anonymous quota — bucketed per-Origin (G1 F-5)', () => {
  const ATTACKER = 'https://attacker.example';
  const LEGIT = 'https://legitimate.example';

  it('attacker on one Origin cannot evict sessions on another Origin (workers)', async () => {
    const { app, runtime } = await bootWorkers({
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: `${LEGIT},${ATTACKER}`,
      AUTH_STRATEGY: 'none',
    });

    // 1) A legitimate client establishes a session on its own Origin.
    const legit = await initializeSession(app, { Origin: LEGIT });
    expect(legit.status).toBe(200);

    // 2) Attacker fills MAX_SESSIONS_PER_API_KEY+1 sessions on a different
    //    Origin. Pre-G1 the literal `'public'` bucket made this evict the
    //    legitimate session; with the per-Origin bucket each Origin has its
    //    own LRU slice.
    const attackerCount = MAX_SESSIONS_PER_API_KEY + 1;
    for (let i = 0; i < attackerCount; i++) {
      const init = await initializeSession(app, { Origin: ATTACKER });
      expect(init.status).toBe(200);
      expect(init.sessionId).toBeTruthy();
    }

    // 3) Legitimate session is still alive — it lives in the
    //    `anon:https://legitimate.example` bucket, untouched by the attacker's
    //    `anon:https://attacker.example` traffic.
    const record = await runtime.sessionStore.get(legit.sessionId);
    expect(record).not.toBeNull();
  });

  it('anonymous quota uses anon:<Origin> bucket (workers)', async () => {
    const A = 'https://a.example';
    const B = 'https://b.example';
    const { app, runtime } = await bootWorkers({
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: `${A},${B}`,
      AUTH_STRATEGY: 'none',
    });

    const a = await initializeSession(app, { Origin: A });
    const b = await initializeSession(app, { Origin: B });
    expect(a.sessionId).not.toBe(b.sessionId);

    // Each Origin gets its own bucket of size 1.
    expect(await runtime.sessionStore.countByApiKey(`anon:${A}`)).toBe(1);
    expect(await runtime.sessionStore.countByApiKey(`anon:${B}`)).toBe(1);
    // The literal 'public' bucket is no longer used.
    expect(await runtime.sessionStore.countByApiKey('public')).toBe(0);
  });

  it('non-browser anon traffic shares anon:unknown bucket (workers)', async () => {
    // Anon clients without an Origin header collapse into a single bucket.
    // Such clients generally don't reuse sessions so this is acceptable.
    const { app, runtime } = await bootWorkers({
      AUTH_STRATEGY: 'none',
    });

    const a = await initializeSession(app);
    expect(a.status).toBe(200);
    expect(await runtime.sessionStore.countByApiKey('anon:unknown')).toBe(1);
  });

  // Node parity: the Node Hono transport ALSO buckets anonymous sessions by
  // `anon:<Origin>` (see `routes/mcp-node.ts:onsessioninitialized`). We don't
  // run the "fill the bucket" check on Node here because the SDK's `McpServer`
  // rejects a second `server.connect()` against a fresh transport ("Already
  // connected to a transport"). That's an MCP SDK limitation — one McpServer
  // instance only handles one initialize per test boot. The Workers transport
  // dispatches JSON-RPC directly so the regression checks above are the
  // canonical ones for the per-Origin quota fix.
});
