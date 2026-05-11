import { describe, expect, it } from 'bun:test';
import { parsePolicyDocument } from './load.ts';

describe('policy/load', () => {
  it('parses both YAML and JSON inline documents into the same shape', () => {
    const yaml = [
      'version: 1',
      'mode: enforce',
      'tools:',
      '  - name: echo',
      '    allow_groups: [engineers]',
      'resources: []',
      'prompts: []',
    ].join('\n');

    const json = JSON.stringify({
      version: 1,
      mode: 'enforce',
      tools: [{ name: 'echo', allow_groups: ['engineers'] }],
      resources: [],
      prompts: [],
    });

    const fromYaml = parsePolicyDocument(yaml);
    const fromJson = parsePolicyDocument(json);

    expect(fromYaml.mode).toBe('enforce');
    expect(fromYaml.version).toBe(1);
    expect(fromYaml.tools).toEqual([{ name: 'echo', allow_groups: ['engineers'] }]);
    expect(fromJson).toEqual(fromYaml);
  });

  it('throws on malformed input that fails zod validation', () => {
    // mode must be 'off' | 'enforce'
    expect(() =>
      parsePolicyDocument(
        JSON.stringify({
          version: 1,
          mode: 'audit',
          tools: [],
          resources: [],
          prompts: [],
        }),
      ),
    ).toThrow();

    // missing required `version`
    expect(() =>
      parsePolicyDocument(
        JSON.stringify({ mode: 'enforce', tools: [], resources: [], prompts: [] }),
      ),
    ).toThrow();

    // tool rule requires non-empty allow_groups
    expect(() =>
      parsePolicyDocument(
        JSON.stringify({
          version: 1,
          mode: 'enforce',
          tools: [{ name: 'echo', allow_groups: [] }],
          resources: [],
          prompts: [],
        }),
      ),
    ).toThrow();
  });
});
