import { describe, expect, it } from 'bun:test';
import { policyConfigSchema } from './config.ts';

describe('policy/config', () => {
  it('parses empty input to content: undefined', () => {
    const parsed = policyConfigSchema.parse({});
    expect(parsed).toEqual({ content: undefined });
  });

  it('round-trips an inline YAML policy document as a string', () => {
    const yaml = [
      'version: 1',
      'mode: enforce',
      'tools:',
      '  - name: echo',
      '    allow_groups: [engineers]',
      'resources: []',
      'prompts: []',
    ].join('\n');

    const parsed = policyConfigSchema.parse({ content: yaml });

    expect(parsed.content).toBe(yaml);
    expect(typeof parsed.content).toBe('string');
  });
});
