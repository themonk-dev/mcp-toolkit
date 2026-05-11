import { describe, expect, it } from 'bun:test';
import { docsResource } from './resource.ts';

describe('resources/examples/docs', () => {
  it('returns markdown content with non-empty text', async () => {
    const result = await docsResource.handler();
    expect(result.contents).toHaveLength(1);
    const entry = result.contents[0];
    expect(entry?.uri).toBe('docs://overview');
    expect(entry?.mimeType).toBe('text/markdown');
    expect(typeof entry?.text).toBe('string');
    expect((entry?.text ?? '').length).toBeGreaterThan(0);
  });
});
