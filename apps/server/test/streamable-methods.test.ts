/**
 * Streamable-HTTP method handling for the Node transport.
 *
 * Pins method-specific semantics for `/mcp`:
 *
 *   POST → JSON-RPC request/notification.
 *   GET  → open an SSE stream for server-initiated messages (no body).
 *   DELETE → end the session (no body required).
 *
 * The original Node handler unconditionally called `c.req.json()` on every
 * method and returned `-32700 Parse error` on the empty body of GET/DELETE.
 * That manifested client-side as
 * `Streamable HTTP error: Failed to open SSE stream: Bad Request` when the
 * client tried to open the notification stream right after `initialize`.
 */

import { describe, expect, it } from 'bun:test';
import { bootNode } from './__helpers__/harness.ts';
import { initializeSession } from './__helpers__/mcp.ts';

describe('streamable-methods (node): GET /mcp opens the SSE stream', () => {
  it('does NOT return -32700 Parse error on a bodiless GET with a valid session', async () => {
    const { app } = await bootNode({
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
    });

    const init = await initializeSession(app);
    expect(init.status).toBe(200);

    // No body. No content-type beyond Accept. This mirrors what the
    // upstream MCP client sends to open the server-push channel.
    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'GET',
        headers: {
          'mcp-session-id': init.sessionId,
          accept: 'application/json, text/event-stream',
        },
      }),
    );

    // The bug was: status 400 with a JSON-RPC envelope { error: { code: -32700 } }.
    // After the fix the response is whatever the streamable-HTTP transport
    // emits for an accepted SSE stream open (200 + text/event-stream is
    // typical, but we only pin "not the parse-error 400" so the assertion
    // stays robust across SDK versions).
    expect(res.status).not.toBe(400);

    // If the server did still 400 us, the body would carry the parse-error
    // code. Belt-and-braces assertion: the parse-error code must not appear.
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.startsWith('application/json')) {
      const body = (await res.json()) as { error?: { code?: number } };
      expect(body.error?.code).not.toBe(-32700);
    }
  });
});

describe('streamable-methods (node): DELETE /mcp closes a session', () => {
  it('accepts a bodiless DELETE with a valid session', async () => {
    const { app } = await bootNode({
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
    });

    const init = await initializeSession(app);
    expect(init.status).toBe(200);

    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'DELETE',
        headers: {
          'mcp-session-id': init.sessionId,
          accept: 'application/json, text/event-stream',
        },
      }),
    );

    expect(res.status).not.toBe(400);
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.startsWith('application/json')) {
      const body = (await res.json()) as { error?: { code?: number } };
      expect(body.error?.code).not.toBe(-32700);
    }
  });
});
