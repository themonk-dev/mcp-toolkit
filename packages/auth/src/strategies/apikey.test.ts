import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { apiKeyStrategy, constantTimeEqual, customHeadersStrategy } from './apikey.ts';

describe('auth/strategies/apikey', () => {
  it('verify returns ok when the configured key matches the default header', async () => {
    const strat = apiKeyStrategy({ apiKey: 'secret-1' });
    const req = new Request('https://srv.test/mcp', {
      headers: { 'x-api-key': 'secret-1' },
    });

    const res = await strat.verify(req, {});
    expect(res.ok).toBe(true);
    // No identity for the static API-key strategy (no IdP).
    expect(res.identity).toBeUndefined();
    expect(res.resolvedHeaders).toEqual({ 'x-api-key': 'secret-1' });
  });

  it('verify returns 401 challenge when the header is missing', async () => {
    const strat = apiKeyStrategy({ apiKey: 'secret-1' });
    const req = new Request('https://srv.test/mcp');

    const res = await strat.verify(req, {});
    expect(res.ok).toBe(false);
    expect(res.challenge?.status).toBe(401);
    expect(res.challenge?.headers['www-authenticate']).toContain('Bearer realm=');
  });

  it('verify returns 401 when the presented key does not match', async () => {
    const strat = apiKeyStrategy({ apiKey: 'secret-1' });
    const req = new Request('https://srv.test/mcp', {
      headers: { 'x-api-key': 'wrong' },
    });

    const res = await strat.verify(req, {});
    expect(res.ok).toBe(false);
    expect(res.challenge?.status).toBe(401);
  });

  it('honors a custom header name', async () => {
    const strat = apiKeyStrategy({ apiKey: 'k', headerName: 'X-Custom-Key' });

    const reqOk = new Request('https://srv.test/mcp', {
      headers: { 'x-custom-key': 'k' },
    });
    expect((await strat.verify(reqOk, {})).ok).toBe(true);

    // Default header should now NOT work.
    const reqDefault = new Request('https://srv.test/mcp', {
      headers: { 'x-api-key': 'k' },
    });
    expect((await strat.verify(reqDefault, {})).ok).toBe(false);
  });

  it('constantTimeEqual: true for equal, false for differing length or content', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('abcd', 'abce')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('auth/strategies/customHeaders boot warning', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let warnSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy?.mockRestore();
    if (originalNodeEnv === undefined) {
      delete (process.env as Record<string, string | undefined>).NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('emits a warning when NODE_ENV is not development', () => {
    process.env.NODE_ENV = 'production';
    customHeadersStrategy({ headers: { 'X-Custom': 'v' } });
    expect(warnSpy).toHaveBeenCalled();
    const arg = String(warnSpy?.mock.calls[0]?.[0] ?? '');
    expect(arg).toContain('auth_strategy');
    expect(arg).toContain('trusted-network');
  });

  it('emits a warning when NODE_ENV is test (only suppressed under development)', () => {
    process.env.NODE_ENV = 'test';
    customHeadersStrategy({ headers: { 'X-Custom': 'v' } });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('stays quiet under NODE_ENV=development', () => {
    process.env.NODE_ENV = 'development';
    customHeadersStrategy({ headers: { 'X-Custom': 'v' } });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns ok:true unconditionally from verify (documented behaviour)', async () => {
    process.env.NODE_ENV = 'development';
    const strat = customHeadersStrategy({ headers: { 'X-Token': 'abc' } });
    const res = await strat.verify(new Request('https://srv.test/mcp'), {});
    expect(res.ok).toBe(true);
    expect(res.resolvedHeaders).toEqual({ 'x-token': 'abc' });
  });
});
