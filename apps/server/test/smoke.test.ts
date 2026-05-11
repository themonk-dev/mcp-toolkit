/**
 * Smoke tests for `apps/server`.
 *
 *   1. `tools/list` over the apikey strategy (without + with header).
 *   2. Policy `mode: enforce` denies `echo` (catalog hides it; call returns
 *      JSON-RPC error code -32009).
 *   3. `/.well-known/oauth-authorization-server` is served (sanity check
 *      against the `AUTH_STRATEGY=none` discovery surface — no remote AS
 *      required).
 *
 * Boot helpers live in `__helpers__/`; this file only contains assertions.
 * The Node Hono transport is configured for the legacy "Bearer + RS-token"
 * flow, so the apikey/policy assertions exercise the runtime through the
 * Workers handler — which honours the injected `AuthStrategy` directly via
 * `auth.verify`. Both transports share the same `compose()` runtime.
 */

import { describe, expect, it } from 'bun:test';
import { bootNode, bootWorkers } from './__helpers__/harness.ts';
import {
  callMcp,
  INIT_BODY,
  initializeSession,
  jsonReq,
  readJson,
} from './__helpers__/mcp.ts';

describe('smoke: apikey strategy', () => {
  it('rejects requests without the configured key and accepts them with it', async () => {
    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'apikey',
      AUTH_ENABLED: 'true',
      API_KEY: 'secret',
      MCP_USER_AUDIT_ON_LIST: 'false',
    });

    // (a) Without API key — should be rejected with 401.
    const denied = await app.fetch(jsonReq('http://localhost/mcp', INIT_BODY));
    expect(denied.status).toBe(401);

    // (b) With API key — initialize should succeed and return a session id.
    const init = await initializeSession(app, { 'x-api-key': 'secret' });
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();

    // (c) tools/list with the session id should return the example tools.
    const list = await callMcp(
      app,
      init.sessionId,
      'tools/list',
      {},
      { 'x-api-key': 'secret' },
    );
    expect(list.status).toBe(200);
    const names = (
      (list.body.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []
    )
      .map((t) => t.name)
      .sort();
    expect(names).toContain('echo');
    expect(names).toContain('health');
    expect(names).toContain('whoami');
  });
});

describe('smoke: policy denies a tool', () => {
  it('hides echo from tools/list and returns -32009 from tools/call', async () => {
    const policyYaml = [
      'version: 1',
      'mode: enforce',
      'tools:',
      '  - name: echo',
      '    allow_groups: ["nobody"]',
      '    deny_groups: ["*"]',
      'prompts: []',
      'resources: []',
    ].join('\n');

    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'apikey',
      AUTH_ENABLED: 'true',
      API_KEY: 'secret',
      MCP_POLICY: policyYaml,
      MCP_USER_AUDIT_ON_LIST: 'false',
    });

    const init = await initializeSession(app, { 'x-api-key': 'secret' });
    expect(init.status).toBe(200);

    const list = await callMcp(
      app,
      init.sessionId,
      'tools/list',
      {},
      { 'x-api-key': 'secret' },
    );
    const names = (
      (list.body.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []
    ).map((t) => t.name);
    expect(names).not.toContain('echo');

    const call = await callMcp(
      app,
      init.sessionId,
      'tools/call',
      { name: 'echo', arguments: { message: 'hi' } },
      { 'x-api-key': 'secret' },
    );

    if (call.body.error) {
      expect(call.body.error.code).toBe(-32009);
    } else {
      // Builder-side gate fallback (when the dispatcher path is bypassed).
      const result = call.body.result as
        | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
        | undefined;
      expect(result?.isError).toBe(true);
      const text = result?.content?.[0]?.text ?? '';
      expect(text.toLowerCase()).toContain('forbidden');
    }
  });
});

describe('smoke: discovery without OIDC', () => {
  it('returns 200 + AS metadata advertising local proxy endpoints (no remote AS)', async () => {
    const { app } = await bootNode({
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
    });

    const res = await app.fetch(
      new Request('http://localhost/.well-known/oauth-authorization-server'),
    );
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      issuer?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
    };
    expect(typeof body.issuer).toBe('string');
    expect(typeof body.authorization_endpoint).toBe('string');
    expect(typeof body.token_endpoint).toBe('string');
  });
});
