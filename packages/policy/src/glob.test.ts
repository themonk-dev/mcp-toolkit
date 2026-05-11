import { describe, expect, it } from 'bun:test';
import { globMatches } from './glob.ts';

describe('policy/glob', () => {
  it('matches a literal pattern with no wildcards', () => {
    expect(globMatches('echo', 'echo', false)).toBe(true);
    expect(globMatches('docs://overview', 'docs://overview', true)).toBe(true);
  });

  it('treats a single * as a single-segment wildcard in path mode', () => {
    expect(globMatches('docs://*', 'docs://overview', true)).toBe(true);
    expect(globMatches('docs://*', 'docs://internal/runbook', true)).toBe(false);
    expect(globMatches('ec*', 'echo', false)).toBe(true);
  });

  it('treats ** as a cross-segment wildcard', () => {
    expect(globMatches('docs://**', 'docs://overview', true)).toBe(true);
    expect(globMatches('docs://**', 'docs://internal/runbook/v2', true)).toBe(true);
    expect(globMatches('example://items/**', 'example://items/books/1', true)).toBe(
      true,
    );
  });

  it('returns false when the value does not match the pattern', () => {
    expect(globMatches('echo', 'health', false)).toBe(false);
    expect(globMatches('docs://overview', 'docs://other', true)).toBe(false);
    expect(globMatches('config://**', 'docs://overview', true)).toBe(false);
  });
});
