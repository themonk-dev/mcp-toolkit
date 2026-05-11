import { describe, expect, it } from 'bun:test';
import {
  DownstreamAuthError,
  DownstreamProtocolError,
  DownstreamTransportError,
} from './errors.ts';

describe('mcp-client/errors/DownstreamAuthError', () => {
  it('carries serverId, status, and body, with a descriptive message', () => {
    const err = new DownstreamAuthError('github', 401, 'token expired');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DownstreamAuthError');
    expect(err.serverId).toBe('github');
    expect(err.status).toBe(401);
    expect(err.body).toBe('token expired');
    expect(err.message).toContain('github');
    expect(err.message).toContain('401');
  });

  it('accepts 403 as a valid status', () => {
    const err = new DownstreamAuthError('linear', 403, 'forbidden');
    expect(err.status).toBe(403);
    expect(err.message).toContain('403');
  });
});

describe('mcp-client/errors/DownstreamTransportError', () => {
  it('carries serverId and message, with optional cause', () => {
    const err = new DownstreamTransportError('github', 'connection reset');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DownstreamTransportError');
    expect(err.serverId).toBe('github');
    expect(err.message).toContain('connection reset');
    expect(err.cause).toBeUndefined();
  });

  it('preserves a thrown cause', () => {
    const inner = new TypeError('fetch failed');
    const err = new DownstreamTransportError('github', 'network error', inner);
    expect(err.cause).toBe(inner);
  });
});

describe('mcp-client/errors/DownstreamProtocolError', () => {
  it('carries serverId, JSON-RPC code, message, and optional data', () => {
    const err = new DownstreamProtocolError('github', -32601, 'method not found');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DownstreamProtocolError');
    expect(err.serverId).toBe('github');
    expect(err.code).toBe(-32601);
    expect(err.message).toContain('method not found');
    expect(err.data).toBeUndefined();
  });

  it('preserves structured data', () => {
    const err = new DownstreamProtocolError('github', -32602, 'invalid params', {
      param: 'foo',
    });
    expect(err.data).toEqual({ param: 'foo' });
  });
});
