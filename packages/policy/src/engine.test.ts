import { describe, expect, test } from 'bun:test';
import { createPolicyEngine } from './engine.ts';
import { globMatches } from './glob.ts';
import type { McpAccessPolicy } from './schema.ts';
import { buildPolicySubject } from './subject.ts';

describe('globMatches', () => {
  test('tool-style * matches', () => {
    expect(globMatches('echo', 'echo', false)).toBe(true);
    expect(globMatches('ec*', 'echo', false)).toBe(true);
    expect(globMatches('*', 'echo', false)).toBe(true);
    expect(globMatches('health', 'echo', false)).toBe(false);
  });

  test('uri ** crosses slashes', () => {
    expect(globMatches('docs://**', 'docs://overview', true)).toBe(true);
    expect(globMatches('example://**', 'example://items/books/1', true)).toBe(true);
    expect(globMatches('docs://overview', 'docs://other', true)).toBe(false);
  });
});

describe('createPolicyEngine', () => {
  const policy: McpAccessPolicy = {
    version: 1,
    mode: 'enforce',
    tools: [{ name: 'echo', allow_groups: ['engineers'] }],
    resources: [{ uri: 'config://**', allow_groups: ['*'] }],
    prompts: [{ name: 'greeting', allow_groups: ['hr'] }],
  };

  test('default deny when no rule matches', () => {
    const engine = createPolicyEngine(policy);
    const subj = buildPolicySubject({ groups: ['engineers'], sub: 'u1' }, undefined);
    expect(engine.canAccessTool('health', subj)).toBe(false);
    expect(engine.canAccessTool('echo', subj)).toBe(true);
  });

  test('allow * requires hasSubject', () => {
    const engine = createPolicyEngine(policy);
    const noSubject = buildPolicySubject(null, undefined);
    expect(engine.canAccessResource('config://server', noSubject)).toBe(false);

    const withSubject = buildPolicySubject({ sub: 'x' }, undefined);
    expect(engine.canAccessResource('config://server', withSubject)).toBe(true);
  });

  test('deny_groups wins over allow', () => {
    const p: McpAccessPolicy = {
      ...policy,
      tools: [
        {
          name: 'echo',
          allow_groups: ['engineers'],
          deny_groups: ['contractors'],
        },
      ],
    };
    const engine = createPolicyEngine(p);
    const subj = buildPolicySubject(
      { groups: ['engineers', 'contractors'], sub: 'u1' },
      undefined,
    );
    expect(engine.canAccessTool('echo', subj)).toBe(false);
  });

  test('mode off allows all', () => {
    const engine = createPolicyEngine({ ...policy, mode: 'off' });
    const subj = buildPolicySubject(null, undefined);
    expect(engine.canAccessTool('anything', subj)).toBe(true);
    expect(engine.isEnforced()).toBe(false);
  });

  test('filterTools', () => {
    const engine = createPolicyEngine(policy);
    const subj = buildPolicySubject({ groups: ['engineers'], sub: '1' }, undefined);
    const out = engine.filterTools([{ name: 'echo' }, { name: 'health' }], subj);
    expect(out.map((t) => t.name)).toEqual(['echo']);
  });

  test('finance group cannot access echo when only engineers allowed (policy mirror)', () => {
    const p: McpAccessPolicy = {
      version: 1,
      mode: 'enforce',
      tools: [
        { name: 'health', allow_groups: ['*'] },
        { name: 'echo', allow_groups: ['engineers'] },
      ],
      resources: [],
      prompts: [],
    };
    const engine = createPolicyEngine(p);
    const finance = buildPolicySubject(
      { groups: ['finance'], sub: 'u1', email: 'finance@example.com' },
      undefined,
    );
    expect(engine.canAccessTool('echo', finance)).toBe(false);
    expect(engine.canAccessTool('health', finance)).toBe(true);
    const catalog = [{ name: 'health' }, { name: 'echo' }];
    expect(engine.filterTools(catalog, finance).map((t) => t.name)).toEqual(['health']);
  });
});

describe('policy/engine', () => {
  test('filterPrompts returns only prompts the subject is allowed to access', () => {
    const policy: McpAccessPolicy = {
      version: 1,
      mode: 'enforce',
      tools: [],
      resources: [],
      prompts: [
        { name: 'greeting', allow_groups: ['hr'] },
        { name: 'analysis', allow_groups: ['engineers'] },
        { name: 'public', allow_groups: ['*'] },
      ],
    };
    const engine = createPolicyEngine(policy);
    const subj = buildPolicySubject({ groups: ['engineers'], sub: 'u1' }, undefined);
    const prompts = [
      { name: 'greeting' },
      { name: 'analysis' },
      { name: 'public' },
      { name: 'unlisted' },
    ];
    expect(engine.filterPrompts(prompts, subj).map((p) => p.name)).toEqual([
      'analysis',
      'public',
    ]);
  });

  test('filterResources returns only resources whose uri the subject can access', () => {
    const policy: McpAccessPolicy = {
      version: 1,
      mode: 'enforce',
      tools: [],
      resources: [
        { uri: 'config://**', allow_groups: ['*'] },
        { uri: 'docs://internal/**', allow_groups: ['engineers'] },
      ],
      prompts: [],
    };
    const engine = createPolicyEngine(policy);
    const subj = buildPolicySubject({ groups: ['hr'], sub: 'u1' }, undefined);
    const resources = [
      { uri: 'config://server' },
      { uri: 'docs://internal/runbook' },
      { uri: 'docs://public/welcome' },
    ];
    expect(engine.filterResources(resources, subj).map((r) => r.uri)).toEqual([
      'config://server',
    ]);
  });

  test('default-deny under mode:enforce excludes tools not listed in policy', () => {
    const policy: McpAccessPolicy = {
      version: 1,
      mode: 'enforce',
      tools: [{ name: 'echo', allow_groups: ['engineers'] }],
      resources: [],
      prompts: [],
    };
    const engine = createPolicyEngine(policy);
    const subj = buildPolicySubject({ groups: ['engineers'], sub: 'u1' }, undefined);
    expect(engine.canAccessTool('unlisted', subj)).toBe(false);
    const filtered = engine.filterTools([{ name: 'echo' }, { name: 'unlisted' }], subj);
    expect(filtered.map((t) => t.name)).toEqual(['echo']);
  });

  test('principal_aliases remap group names before allow checks', () => {
    const policy: McpAccessPolicy = {
      version: 1,
      mode: 'enforce',
      tools: [{ name: 'echo', allow_groups: ['engineering'] }],
      resources: [],
      prompts: [],
      principal_aliases: { 'eng-v2': 'engineering' },
    };
    const engine = createPolicyEngine(policy);
    const aliased = buildPolicySubject(
      { groups: ['eng-v2'], sub: 'u1' },
      policy.principal_aliases,
    );
    expect(engine.canAccessTool('echo', aliased)).toBe(true);

    const unaliased = buildPolicySubject({ groups: ['eng-v2'], sub: 'u1' }, undefined);
    expect(engine.canAccessTool('echo', unaliased)).toBe(false);
  });

  test('allow_groups ["*"] admits authenticated subjects and rejects anonymous', () => {
    const policy: McpAccessPolicy = {
      version: 1,
      mode: 'enforce',
      tools: [{ name: 'echo', allow_groups: ['*'] }],
      resources: [],
      prompts: [],
    };
    const engine = createPolicyEngine(policy);

    const authedBySub = buildPolicySubject({ sub: 'u1' }, undefined);
    expect(engine.canAccessTool('echo', authedBySub)).toBe(true);

    const authedByEmail = buildPolicySubject({ email: 'a@example.com' }, undefined);
    expect(engine.canAccessTool('echo', authedByEmail)).toBe(true);

    const anon = buildPolicySubject(null, undefined);
    expect(engine.canAccessTool('echo', anon)).toBe(false);

    const empty = buildPolicySubject({}, undefined);
    expect(engine.canAccessTool('echo', empty)).toBe(false);
  });
});
