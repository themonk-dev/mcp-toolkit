/**
 * Policy filtering integration tests for prompts, resources, and default-deny.
 *
 * The smoke test covers tools/list filtering and tools/call denial. This file
 * extends to:
 *
 *   1. prompts/list filtering (Workers dispatcher path).
 *   2. prompts/get denial — through the Node Hono path because the Workers
 *      dispatcher does not implement `prompts/get` (returns -32601). The
 *      builder-side gate in `buildServer` throws "Forbidden: ..." which the
 *      SDK transport surfaces as JSON-RPC error -32603.
 *   3. resources/list filtering (Workers dispatcher path).
 *   4. resources/read denial — Node Hono path for the same reason as (2).
 *   5. default-deny: `mode: enforce` + a tool not listed → tool absent from
 *      tools/list (Workers).
 */

import { describe, expect, it } from 'bun:test';
import { bootNode, bootWorkers } from './__helpers__/harness.ts';
import { callMcp, initializeSession } from './__helpers__/mcp.ts';

const denyGreetingPolicy = [
  'version: 1',
  'mode: enforce',
  'tools: []',
  'prompts:',
  '  - name: greeting',
  '    allow_groups: ["nobody"]',
  '    deny_groups: ["*"]',
  'resources: []',
].join('\n');

const denyConfigResourcePolicy = [
  'version: 1',
  'mode: enforce',
  'tools: []',
  'prompts: []',
  'resources:',
  '  - uri: "config://server"',
  '    allow_groups: ["nobody"]',
  '    deny_groups: ["*"]',
].join('\n');

describe('policy-integration: prompts filtering', () => {
  it('hides denied prompts from prompts/list (workers dispatcher)', async () => {
    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'apikey',
      AUTH_ENABLED: 'true',
      API_KEY: 'secret',
      MCP_POLICY: denyGreetingPolicy,
    });

    const init = await initializeSession(app, { 'x-api-key': 'secret' });
    expect(init.status).toBe(200);

    const list = await callMcp(
      app,
      init.sessionId,
      'prompts/list',
      {},
      { 'x-api-key': 'secret' },
    );
    expect(list.status).toBe(200);
    const names = (
      (list.body.result as { prompts?: Array<{ name: string }> } | undefined)
        ?.prompts ?? []
    ).map((p) => p.name);
    expect(names).not.toContain('greeting');
  });

  it('returns Forbidden on prompts/get for a denied prompt (node SDK path)', async () => {
    // Workers dispatcher does not implement `prompts/get`. The Node Hono
    // transport routes through the SDK server, which calls the builder's
    // policy gate and throws "Forbidden: ..." on denial.
    const { app } = await bootNode({
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
      MCP_POLICY: denyGreetingPolicy,
    });
    const init = await initializeSession(app);
    expect(init.status).toBe(200);

    const get = await callMcp(app, init.sessionId, 'prompts/get', {
      name: 'greeting',
      arguments: { name: 'alice' },
    });
    expect(get.body.error).toBeDefined();
    const message = String(get.body.error?.message ?? '');
    expect(message.toLowerCase()).toContain('forbidden');
    expect(message).toContain('greeting');
  });
});

describe('policy-integration: resources filtering', () => {
  it('hides denied resources from resources/list (workers dispatcher)', async () => {
    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'apikey',
      AUTH_ENABLED: 'true',
      API_KEY: 'secret',
      MCP_POLICY: denyConfigResourcePolicy,
    });

    const init = await initializeSession(app, { 'x-api-key': 'secret' });
    expect(init.status).toBe(200);

    const list = await callMcp(
      app,
      init.sessionId,
      'resources/list',
      {},
      { 'x-api-key': 'secret' },
    );
    expect(list.status).toBe(200);
    const uris = (
      (list.body.result as { resources?: Array<{ uri: string }> } | undefined)
        ?.resources ?? []
    ).map((r) => r.uri);
    expect(uris).not.toContain('config://server');
  });

  it('returns Forbidden on resources/read for a denied URI (node SDK path)', async () => {
    // As with prompts/get, the Workers dispatcher does not implement
    // `resources/read`; the Node SDK transport surfaces the builder-side gate.
    const { app } = await bootNode({
      AUTH_STRATEGY: 'none',
      AUTH_ENABLED: 'false',
      MCP_POLICY: denyConfigResourcePolicy,
    });
    const init = await initializeSession(app);
    expect(init.status).toBe(200);

    const read = await callMcp(app, init.sessionId, 'resources/read', {
      uri: 'config://server',
    });
    expect(read.body.error).toBeDefined();
    const message = String(read.body.error?.message ?? '');
    expect(message.toLowerCase()).toContain('forbidden');
    expect(message).toContain('config://server');
  });
});

describe('policy-integration: default-deny under mode=enforce', () => {
  it('omits tools that are not listed in the policy from tools/list', async () => {
    // Policy lists `health` only with a real principal-required allow rule.
    // `echo` and `whoami` are not listed → no rules match → default-deny in
    // `canAccessWithRules` (empty rule set returns false). Tools missing from
    // the policy never appear in the catalog.
    const policyYaml = [
      'version: 1',
      'mode: enforce',
      'tools:',
      '  - name: health',
      '    allow_groups: ["everyone"]',
      'prompts: []',
      'resources: []',
    ].join('\n');

    const { app } = await bootWorkers({
      AUTH_STRATEGY: 'apikey',
      AUTH_ENABLED: 'true',
      API_KEY: 'secret',
      MCP_POLICY: policyYaml,
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
    expect(list.status).toBe(200);
    const names = (
      (list.body.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []
    ).map((t) => t.name);
    // echo and whoami have no policy rules → default-deny → absent.
    expect(names).not.toContain('echo');
    expect(names).not.toContain('whoami');
  });
});
