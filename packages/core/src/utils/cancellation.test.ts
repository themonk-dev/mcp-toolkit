import { describe, expect, it } from 'bun:test';
import { CancellationToken, createCancellationToken } from './cancellation.ts';

describe('core/utils/cancellation', () => {
  it('flips isCancelled exactly once when cancel is called', () => {
    const token = createCancellationToken();
    expect(token.isCancelled).toBe(false);

    token.cancel();
    expect(token.isCancelled).toBe(true);

    // Idempotent: a second cancel is a no-op (no throw, listeners not re-fired).
    token.cancel();
    expect(token.isCancelled).toBe(true);
  });

  it('aborts a registered AbortController when cancelled', () => {
    const token = new CancellationToken();
    const controller = new AbortController();
    token.onCancelled(() => controller.abort());

    expect(controller.signal.aborted).toBe(false);
    token.cancel();
    expect(controller.signal.aborted).toBe(true);
  });

  it('notifies multiple subscribers including those registered after cancellation', () => {
    const token = new CancellationToken();
    const calls: string[] = [];

    token.onCancelled(() => calls.push('a'));
    token.onCancelled(() => calls.push('b'));
    token.cancel();

    expect(calls).toEqual(['a', 'b']);

    // A late subscriber registered after cancellation must fire synchronously.
    token.onCancelled(() => calls.push('c'));
    expect(calls).toEqual(['a', 'b', 'c']);
  });
});
