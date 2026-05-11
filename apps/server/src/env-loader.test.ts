/**
 * Unit tests for the grouped JSON config loader.
 *
 * The tests below cover the runtime path that operators hit (grouped JSON
 * env vars). The smoke / strategy / oidc-e2e tests in `apps/server/test/`
 * use the `envFor(flatOverrides)` helper, which bypasses this loader — so
 * loader regressions wouldn't surface there. These tests close that gap.
 */

import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigFromStrings } from './env-loader.ts';
import { loadNodeConfig } from './env-node.ts';
import { loadWorkersConfig } from './env-workers.ts';

describe('env-loader: defaults', () => {
  it('returns minimum-default AppConfig when every env var is unset', () => {
    const config = loadConfigFromStrings({});
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.server.port).toBe(3000);
    expect(config.auth.strategy).toBe('none');
    expect(config.mcp.title).toBe('MCP Server');
    expect(config.storage.tokensFile).toBe('.data/tokens.json');
    expect(config.policy.content).toBeUndefined();
  });

  it('treats empty / whitespace-only strings as unset', () => {
    const config = loadConfigFromStrings({
      AUTH: '',
      MCP: '   ',
      POLICY: '\n',
    });
    expect(config.auth.strategy).toBe('none');
    expect(config.mcp.title).toBe('MCP Server');
  });
});

describe('env-loader: valid JSON round-trips', () => {
  it('parses a full nested AUTH var', () => {
    const config = loadConfigFromStrings({
      AUTH: JSON.stringify({ strategy: 'apikey', requireRs: false }),
      AUTH_KEYS: JSON.stringify({
        apikey: { key: 'secret', headerName: 'x-api-key' },
      }),
    });
    expect(config.auth.strategy).toBe('apikey');
    expect(config.auth.apikey.key).toBe('secret');
    expect(config.auth.apikey.headerName).toBe('x-api-key');
  });

  it('parses SERVER and RUNTIME and merges them into config.server', () => {
    const config = loadConfigFromStrings({
      SERVER: JSON.stringify({ port: 8080, allowedOrigins: ['https://x.example'] }),
      RUNTIME: JSON.stringify({ nodeEnv: 'production', logLevel: 'warning' }),
    });
    expect(config.server.port).toBe(8080);
    expect(config.server.nodeEnv).toBe('production');
    expect(config.server.logLevel).toBe('warning');
    expect(config.server.allowedOrigins).toEqual(['https://x.example']);
  });

  it('nests MCP_ICON under mcp.icon (the parent stays under mcp.*)', () => {
    const config = loadConfigFromStrings({
      MCP: JSON.stringify({ title: 'Test', version: '9.9.9' }),
      MCP_ICON: JSON.stringify({
        url: 'https://x.example/icon.png',
        mime: 'image/png',
      }),
    });
    expect(config.mcp.title).toBe('Test');
    expect(config.mcp.icon.url).toBe('https://x.example/icon.png');
    expect(config.mcp.icon.mime).toBe('image/png');
  });

  it('shallow-merges AUTH + AUTH_KEYS + AUTH_OAUTH into config.auth', () => {
    const config = loadConfigFromStrings({
      AUTH: JSON.stringify({ strategy: 'oidc', requireRs: true }),
      AUTH_KEYS: JSON.stringify({ jwt: { jwksUrl: 'https://x.example/jwks' } }),
      AUTH_OAUTH: JSON.stringify({
        oidc: { issuer: 'https://x.example' },
        provider: { clientId: 'cid', clientSecret: 'sec' },
      }),
    });
    expect(config.auth.strategy).toBe('oidc');
    expect(config.auth.requireRs).toBe(true);
    expect(config.auth.jwt.jwksUrl).toBe('https://x.example/jwks');
    expect(config.auth.oidc.issuer).toBe('https://x.example');
    expect(config.auth.provider.clientId).toBe('cid');
  });
});

describe('env-loader: error paths', () => {
  it('throws with the var name when JSON is malformed', () => {
    expect(() => loadConfigFromStrings({ AUTH: '{not-json' })).toThrow(
      /Invalid JSON in AUTH/,
    );
  });

  it('rejects JSON arrays', () => {
    expect(() => loadConfigFromStrings({ SERVER: '["array"]' })).toThrow(
      /SERVER must be a JSON object, got array/,
    );
  });

  it('rejects JSON primitives (number, boolean)', () => {
    expect(() => loadConfigFromStrings({ MCP: '42' })).toThrow(
      /MCP must be a JSON object/,
    );
    expect(() => loadConfigFromStrings({ MCP: 'true' })).toThrow(
      /MCP must be a JSON object/,
    );
  });

  it('rejects JSON null', () => {
    expect(() => loadConfigFromStrings({ STORAGE: 'null' })).toThrow(
      /STORAGE must be a JSON object, got null/,
    );
  });

  it('surfaces zod validation errors with the namespaced path', () => {
    expect(() =>
      loadConfigFromStrings({ SERVER: JSON.stringify({ port: 'not-a-number' }) }),
    ).toThrow(/Invalid config: server\.port:/);
  });
});

describe('env-loader: POLICY handling', () => {
  it('passes inline POLICY.content through (trimmed of surrounding whitespace)', () => {
    const yaml = 'version: 1\nmode: off';
    const config = loadConfigFromStrings({
      POLICY: JSON.stringify({ content: `\n${yaml}\n` }),
    });
    // `optionalString` trims; the YAML body itself is preserved verbatim.
    expect(config.policy.content).toBe(yaml);
  });

  it('Workers rejects POLICY.path with a clear error', () => {
    expect(() =>
      loadWorkersConfig({ POLICY: JSON.stringify({ path: './x.yaml' }) }),
    ).toThrow(/POLICY\.path is not supported on Workers/);
  });

  it('Node resolves POLICY.path to file bytes', () => {
    const dir = join(tmpdir(), `mcp-toolkit-loader-${randomUUID()}`);
    const policyPath = join(dir, 'policy.yaml');
    const body =
      'version: 1\nmode: enforce\ntools:\n  - name: echo\n    allow_groups: ["*"]';
    mkdirSync(dir, { recursive: true });
    writeFileSync(policyPath, body, 'utf8');
    try {
      const config = loadNodeConfig({
        POLICY: JSON.stringify({ path: policyPath }),
      } as NodeJS.ProcessEnv);
      // `optionalString` trims; the YAML body itself is preserved verbatim.
      expect(config.policy.content).toBe(body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Node throws with absolute path when POLICY.path file is missing', () => {
    const missing = join(tmpdir(), `mcp-toolkit-missing-${randomUUID()}.yaml`);
    expect(() =>
      loadNodeConfig({
        POLICY: JSON.stringify({ path: missing }),
      } as NodeJS.ProcessEnv),
    ).toThrow(/Failed to read POLICY\.path/);
  });

  it('Node prefers inline POLICY.content over POLICY.path when both are set', () => {
    const config = loadNodeConfig({
      POLICY: JSON.stringify({ content: 'inline wins', path: '/nowhere' }),
    } as NodeJS.ProcessEnv);
    expect(config.policy.content).toBe('inline wins');
  });
});
