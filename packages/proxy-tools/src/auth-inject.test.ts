import { describe, expect, it } from 'bun:test';
import { buildAuthInject } from './auth-inject.ts';

function baseRequest(): Request {
  return new Request('https://example.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

describe('proxy-tools/auth-inject/none', () => {
  it('returns the request unchanged', () => {
    const inject = buildAuthInject({ authType: 'none' });
    const req = baseRequest();
    const out = inject(req);
    expect(out.headers.get('Authorization')).toBeNull();
    expect(out.headers.get('Content-Type')).toBe('application/json');
  });
});

describe('proxy-tools/auth-inject/api_key', () => {
  it('sets the configured custom header to the configured value', () => {
    const inject = buildAuthInject({
      authType: 'api_key',
      headerName: 'x-api-key',
      key: 'secret-key',
    });
    const out = inject(baseRequest());
    expect(out.headers.get('x-api-key')).toBe('secret-key');
  });

  it('does not touch the Authorization header', () => {
    const inject = buildAuthInject({
      authType: 'api_key',
      headerName: 'x-api-key',
      key: 'k',
    });
    const out = inject(baseRequest());
    expect(out.headers.get('Authorization')).toBeNull();
  });

  it('preserves other headers (Content-Type, MCP-Protocol-Version, etc.)', () => {
    const inject = buildAuthInject({
      authType: 'api_key',
      headerName: 'x-api-key',
      key: 'k',
    });
    const req = new Request('https://example.com/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2025-06-18',
      },
      body: '{}',
    });
    const out = inject(req);
    expect(out.headers.get('Content-Type')).toBe('application/json');
    expect(out.headers.get('MCP-Protocol-Version')).toBe('2025-06-18');
  });
});

describe('proxy-tools/auth-inject/bearer', () => {
  it('sets Authorization to "Bearer <token>"', () => {
    const inject = buildAuthInject({ authType: 'bearer', token: 'tok-123' });
    const out = inject(baseRequest());
    expect(out.headers.get('Authorization')).toBe('Bearer tok-123');
  });

  it('overrides an existing Authorization header', () => {
    const inject = buildAuthInject({ authType: 'bearer', token: 'fresh' });
    const req = new Request('https://example.com/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer stale',
      },
      body: '{}',
    });
    const out = inject(req);
    expect(out.headers.get('Authorization')).toBe('Bearer fresh');
  });
});
