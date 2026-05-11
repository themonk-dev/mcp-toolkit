import { describe, expect, it } from 'bun:test';
import { logoResource, logoSvgResource } from './resource.ts';

describe('resources/examples/logo', () => {
  it('returns a base64 blob for the PNG logo', async () => {
    const result = await logoResource.handler();
    const entry = result.contents[0];
    expect(entry?.mimeType).toBe('image/png');
    expect(typeof entry?.blob).toBe('string');
    expect((entry?.blob ?? '').length).toBeGreaterThan(0);
    expect(entry?.text).toBeUndefined();
  });

  it('returns SVG text for the SVG logo variant', async () => {
    const result = await logoSvgResource.handler();
    const entry = result.contents[0];
    expect(entry?.mimeType).toBe('image/svg+xml');
    expect(typeof entry?.text).toBe('string');
    expect(entry?.text ?? '').toContain('<svg');
    expect(entry?.blob).toBeUndefined();
  });
});
