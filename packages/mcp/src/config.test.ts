import { describe, expect, it } from 'bun:test';
import { mcpConfigSchema } from './config.ts';

describe('mcpConfigSchema', () => {
  it('parses empty input to sensible defaults', () => {
    const parsed = mcpConfigSchema.parse({ icon: {} });
    expect(parsed.title).toBe('MCP Server');
    expect(parsed.version).toBe('0.1.0');
    expect(parsed.protocolVersion).toBe('2025-06-18');
    expect(parsed.instructions).toBeUndefined();
    expect(parsed.userAuditOnList).toBe(false);
    expect(parsed.icon).toEqual({
      url: undefined,
      mime: undefined,
      sizes: [],
    });
  });

  it('round-trips a full nested input with comma-separated icon sizes', () => {
    const parsed = mcpConfigSchema.parse({
      title: 'Custom MCP',
      version: '1.2.3',
      instructions: 'Use it gently.',
      protocolVersion: '2025-06-18',
      icon: {
        url: 'https://example.com/icon.png',
        mime: 'image/png',
        sizes: '64x64, 128x128, 512x512',
      },
      userAuditOnList: 'true',
    });
    expect(parsed).toEqual({
      title: 'Custom MCP',
      version: '1.2.3',
      instructions: 'Use it gently.',
      protocolVersion: '2025-06-18',
      icon: {
        url: 'https://example.com/icon.png',
        mime: 'image/png',
        sizes: ['64x64', '128x128', '512x512'],
      },
      userAuditOnList: true,
    });
  });

  it('coerces userAuditOnList: "true" → true; undefined → false', () => {
    const truthy = mcpConfigSchema.parse({
      icon: {},
      userAuditOnList: 'true',
    });
    expect(truthy.userAuditOnList).toBe(true);

    const falsy = mcpConfigSchema.parse({ icon: {} });
    expect(falsy.userAuditOnList).toBe(false);
  });
});
