import { describe, expect, it } from 'bun:test';
import { noneStrategy } from './none.ts';

describe('auth/strategies/none', () => {
  it('always returns ok with empty identity and resolvedHeaders', async () => {
    const strat = noneStrategy();
    expect(strat.kind).toBe('none');

    const req = new Request('https://srv.test/mcp');
    const res = await strat.verify(req, {});

    expect(res.ok).toBe(true);
    expect(res.identity).toBeUndefined();
    expect(res.resolvedHeaders).toEqual({});
  });
});
