import { describe, expect, it } from 'bun:test';
import { contextRegistry } from './registry.ts';

describe('mcp/registry', () => {
  it('create() registers a context, get() returns it, delete() removes it', () => {
    const requestId = `req-${Math.random().toString(36).slice(2)}`;
    const ctx = contextRegistry.create(requestId, 'session-x');
    expect(ctx.requestId).toBe(requestId);
    expect(ctx.sessionId).toBe('session-x');
    expect(contextRegistry.get(requestId)).toBe(ctx);

    expect(contextRegistry.delete(requestId)).toBe(true);
    expect(contextRegistry.get(requestId)).toBeUndefined();
    expect(contextRegistry.delete(requestId)).toBe(false);
  });

  it('cancel() flips isCancelled on the registered cancellation token', () => {
    const requestId = `req-${Math.random().toString(36).slice(2)}`;
    const ctx = contextRegistry.create(requestId, 'session-y');
    expect(ctx.cancellationToken.isCancelled).toBe(false);

    expect(contextRegistry.cancel(requestId)).toBe(true);
    expect(ctx.cancellationToken.isCancelled).toBe(true);

    // cancel() on an unknown id returns false.
    expect(contextRegistry.cancel('does-not-exist')).toBe(false);

    contextRegistry.delete(requestId);
  });
});
