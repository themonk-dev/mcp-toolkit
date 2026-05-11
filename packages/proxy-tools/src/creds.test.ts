import { describe, expect, it } from 'bun:test';
import type { ConnectedServer } from './config.ts';
import { EnvCredentialResolver } from './creds.ts';

const noneServer: ConnectedServer = {
  id: 'public',
  url: 'https://example.com/mcp',
  authType: 'none',
};

const apiKeyServer: ConnectedServer = {
  id: 'linear',
  url: 'https://example.com/mcp',
  authType: 'api_key',
  headerName: 'x-api-key',
  key: 'lin_xxx',
};

const bearerServer: ConnectedServer = {
  id: 'github',
  url: 'https://example.com/mcp',
  authType: 'bearer',
  token: 'ghp_xxx',
};

describe('proxy-tools/creds/EnvCredentialResolver', () => {
  it('resolves a none-auth server to a none credential', () => {
    const resolver = new EnvCredentialResolver([noneServer]);
    expect(resolver.resolve('public')).toEqual({ authType: 'none' });
  });

  it('resolves an api_key server to an api_key credential with headerName and key', () => {
    const resolver = new EnvCredentialResolver([apiKeyServer]);
    expect(resolver.resolve('linear')).toEqual({
      authType: 'api_key',
      headerName: 'x-api-key',
      key: 'lin_xxx',
    });
  });

  it('resolves a bearer server to a bearer credential with token', () => {
    const resolver = new EnvCredentialResolver([bearerServer]);
    expect(resolver.resolve('github')).toEqual({
      authType: 'bearer',
      token: 'ghp_xxx',
    });
  });

  it('throws a clear error when the server id is unknown', () => {
    const resolver = new EnvCredentialResolver([bearerServer]);
    expect(() => resolver.resolve('unknown')).toThrow(/unknown/);
    expect(() => resolver.resolve('unknown')).toThrow(/server/);
  });

  it('supports heterogeneous fleets — resolves each by id independently', () => {
    const resolver = new EnvCredentialResolver([
      noneServer,
      apiKeyServer,
      bearerServer,
    ]);
    expect(resolver.resolve('public').authType).toBe('none');
    expect(resolver.resolve('linear').authType).toBe('api_key');
    expect(resolver.resolve('github').authType).toBe('bearer');
  });
});
