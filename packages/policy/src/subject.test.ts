import { describe, expect, it } from 'bun:test';
import type { SessionIdentity } from '@mcp-toolkit/core';
import { buildPolicySubject } from './subject.ts';

describe('policy/subject', () => {
  it('combines identity.groups and identity.memberOf into a single groupSet', () => {
    const identity: SessionIdentity = {
      sub: 'u1',
      groups: ['engineers', 'oncall'],
      memberOf: ['oncall', 'admins'],
    };
    const subj = buildPolicySubject(identity, undefined);
    expect(Array.from(subj.groupSet).sort()).toEqual(['admins', 'engineers', 'oncall']);
    expect(subj.hasSubject).toBe(true);
  });

  it('applies principal_aliases to remap group names', () => {
    const identity: SessionIdentity = {
      sub: 'u1',
      groups: ['eng-v2', 'finance'],
    };
    const subj = buildPolicySubject(identity, { 'eng-v2': 'engineering' });
    expect(subj.groupSet.has('engineering')).toBe(true);
    expect(subj.groupSet.has('eng-v2')).toBe(false);
    expect(subj.groupSet.has('finance')).toBe(true);
  });

  it('flips hasSubject based on whether sub/email/preferred_username are set', () => {
    expect(buildPolicySubject({ sub: 'u1' }, undefined).hasSubject).toBe(true);
    expect(buildPolicySubject({ email: 'a@example.com' }, undefined).hasSubject).toBe(
      true,
    );
    expect(
      buildPolicySubject({ preferred_username: 'alice' }, undefined).hasSubject,
    ).toBe(true);

    expect(buildPolicySubject({}, undefined).hasSubject).toBe(false);
    expect(buildPolicySubject(null, undefined).hasSubject).toBe(false);
    expect(
      buildPolicySubject({ sub: '   ', email: '', preferred_username: '' }, undefined)
        .hasSubject,
    ).toBe(false);
  });
});
