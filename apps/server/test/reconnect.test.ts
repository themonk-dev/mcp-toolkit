/**
 * Regression: the Node transport must accept a new `initialize` even when a
 * prior session is still alive on the same process.
 *
 * Pre-fix `compose()` produced a single `McpServer` instance shared across
 * every session, and `mcp-node.ts` called `server.connect(newTransport)` on
 * every `initialize`. The MCP SDK's `Protocol` binds one transport per server
 * lifetime, so the second connect threw "Already connected to a transport".
 * The user-visible symptom: clients (Cursor, etc.) that disable + re-enable
 * the MCP often skip the DELETE, so the second initialize tripped the seam.
 *
 * Fix shape: build a fresh `McpServer` per session in `mcp-node.ts`. These
 * tests pin the multi-session guarantee for the Node transport.
 */

import { describe, expect, it } from 'bun:test';
import { bootNode } from './__helpers__/harness.ts';
import { callMcp, initializeSession } from './__helpers__/mcp.ts';

describe('reconnect (node): multiple back-to-back initializes', () => {
  it('two initializes without DELETE both succeed with distinct session ids', async () => {
    const { app } = await bootNode({
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
    });

    const first = await initializeSession(app);
    expect(first.status).toBe(200);
    expect(first.sessionId).toBeTruthy();

    // Second initialize arrives *without* DELETE-ing the first — the
    // disable→re-enable flow Cursor (and other clients) use. Pre-fix this
    // returned 500 because `server.connect()` rejected the second transport.
    const second = await initializeSession(app);
    expect(second.status).toBe(200);
    expect(second.sessionId).toBeTruthy();
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it('original session is still usable after a new session is created', async () => {
    const { app } = await bootNode({
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
    });

    const first = await initializeSession(app);
    expect(first.status).toBe(200);

    const second = await initializeSession(app);
    expect(second.status).toBe(200);

    // The first session's transport must still be live and routable. If we
    // shared one server across sessions, the second connect would have
    // hijacked or invalidated the first transport binding.
    const list = await callMcp(app, first.sessionId, 'tools/list', {});
    expect(list.status).toBe(200);
  });

  it('liveServers reflects active sessions: grows on initialize, shrinks on DELETE', async () => {
    const { app, runtime } = await bootNode({
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
    });

    const first = await initializeSession(app);
    expect(first.status).toBe(200);
    const second = await initializeSession(app);
    expect(second.status).toBe(200);

    // Both initializes succeeded → the per-session servers must both be
    // registered. Pre-fix, an orphaned initialize (handleRequest throws
    // before `onsessioninitialized` fires) would leak into liveServers
    // without `transports` ever seeing the entry; this assertion pins the
    // happy-path bookkeeping the orphan sweep must preserve.
    expect(runtime.liveServers.size).toBe(2);

    const deleteReq = new Request('http://localhost/mcp', {
      method: 'DELETE',
      headers: {
        'mcp-session-id': first.sessionId,
        accept: 'application/json, text/event-stream',
      },
    });
    const deleteRes = await app.fetch(deleteReq);
    expect(deleteRes.status).toBeLessThan(500);

    // DELETE on the first session must drain its per-session McpServer.
    expect(runtime.liveServers.size).toBe(1);
  });

  it('three concurrent sessions can each run tools/list', async () => {
    const { app } = await bootNode({
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
    });

    const inits = await Promise.all([
      initializeSession(app),
      initializeSession(app),
      initializeSession(app),
    ]);
    for (const init of inits) {
      expect(init.status).toBe(200);
      expect(init.sessionId).toBeTruthy();
    }
    const ids = new Set(inits.map((i) => i.sessionId));
    expect(ids.size).toBe(3);

    const calls = await Promise.all(
      inits.map((i) => callMcp(app, i.sessionId, 'tools/list', {})),
    );
    for (const c of calls) expect(c.status).toBe(200);
  });
});
