import { describe, expect, it } from 'bun:test';
import { exampleResources, startStatusUpdates } from './index.ts';

describe('resources/examples/index', () => {
  it('exposes all 5 example resources by name', () => {
    const uris = exampleResources.map((r) => r.uri);
    expect(uris).toContain('config://server');
    expect(uris).toContain('docs://overview');
    expect(uris).toContain('logo://server');
    expect(uris).toContain('logo://server/svg');
    expect(uris).toContain('status://server');
    expect(exampleResources).toHaveLength(5);
  });

  it('re-exports startStatusUpdates from the lifecycle module', () => {
    expect(typeof startStatusUpdates).toBe('function');
  });
});
