import { describe, expect, it } from 'bun:test';
import { connectedServerSchema, connectedServersSchema } from './config.ts';

describe('proxy-tools/config/connectedServerSchema', () => {
  it('accepts a none-auth server with just id and url', () => {
    const ok = connectedServerSchema.safeParse({
      id: 'public-mcp',
      url: 'https://example.com/mcp',
      authType: 'none',
    });
    expect(ok.success).toBe(true);
  });

  it('accepts an api_key server with headerName and key', () => {
    const ok = connectedServerSchema.safeParse({
      id: 'linear',
      url: 'https://example.com/mcp',
      authType: 'api_key',
      headerName: 'x-api-key',
      key: 'lin_xxx',
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a bearer server with token', () => {
    const ok = connectedServerSchema.safeParse({
      id: 'github',
      url: 'https://example.com/mcp',
      authType: 'bearer',
      token: 'ghp_xxx',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects an api_key entry with empty key (loud throw for missing secret)', () => {
    const err = connectedServerSchema.safeParse({
      id: 'linear',
      url: 'https://example.com/mcp',
      authType: 'api_key',
      headerName: 'x-api-key',
      key: '',
    });
    expect(err.success).toBe(false);
    if (!err.success) {
      expect(err.error.issues.some((i) => i.path.includes('key'))).toBe(true);
    }
  });

  it('rejects a bearer entry with empty token (loud throw for missing secret)', () => {
    const err = connectedServerSchema.safeParse({
      id: 'github',
      url: 'https://example.com/mcp',
      authType: 'bearer',
      token: '',
    });
    expect(err.success).toBe(false);
    if (!err.success) {
      expect(err.error.issues.some((i) => i.path.includes('token'))).toBe(true);
    }
  });

  it('rejects an api_key entry missing the headerName', () => {
    const err = connectedServerSchema.safeParse({
      id: 'linear',
      url: 'https://example.com/mcp',
      authType: 'api_key',
      key: 'lin_xxx',
    });
    expect(err.success).toBe(false);
  });

  it('rejects an unknown authType', () => {
    const err = connectedServerSchema.safeParse({
      id: 'x',
      url: 'https://example.com/mcp',
      authType: 'oauth2',
      token: 'foo',
    });
    expect(err.success).toBe(false);
  });

  it('rejects ids that are not slug-shaped', () => {
    const err = connectedServerSchema.safeParse({
      id: 'GitHub',
      url: 'https://example.com/mcp',
      authType: 'none',
    });
    expect(err.success).toBe(false);
  });

  it('rejects non-URL urls', () => {
    const err = connectedServerSchema.safeParse({
      id: 'github',
      url: 'not-a-url',
      authType: 'none',
    });
    expect(err.success).toBe(false);
  });
});

describe('proxy-tools/config/connectedServersSchema', () => {
  it('defaults to an empty array when input is omitted', () => {
    const ok = connectedServersSchema.safeParse(undefined);
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toEqual([]);
  });

  it('accepts an empty array', () => {
    const ok = connectedServersSchema.safeParse([]);
    expect(ok.success).toBe(true);
  });

  it('accepts a heterogeneous array of valid entries', () => {
    const ok = connectedServersSchema.safeParse([
      { id: 'github', url: 'https://a/mcp', authType: 'bearer', token: 't' },
      {
        id: 'linear',
        url: 'https://b/mcp',
        authType: 'api_key',
        headerName: 'x-api-key',
        key: 'k',
      },
      { id: 'public', url: 'https://c/mcp', authType: 'none' },
    ]);
    expect(ok.success).toBe(true);
  });

  it('rejects an array with duplicate ids', () => {
    const err = connectedServersSchema.safeParse([
      { id: 'github', url: 'https://a/mcp', authType: 'bearer', token: 't1' },
      { id: 'github', url: 'https://b/mcp', authType: 'bearer', token: 't2' },
    ]);
    expect(err.success).toBe(false);
    if (!err.success) {
      expect(
        err.error.issues.some((i) => i.message.toLowerCase().includes('duplicate')),
      ).toBe(true);
    }
  });

  it('surfaces nested error paths so operators see which entry failed', () => {
    const err = connectedServersSchema.safeParse([
      { id: 'github', url: 'https://a/mcp', authType: 'bearer', token: '' },
    ]);
    expect(err.success).toBe(false);
    if (!err.success) {
      const paths = err.error.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => p.startsWith('0.') && p.endsWith('token'))).toBe(true);
    }
  });
});
