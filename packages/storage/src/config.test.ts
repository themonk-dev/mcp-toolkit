import { describe, expect, it } from 'bun:test';
import { storageConfigSchema } from './config.ts';

describe('storage/config/storageConfigSchema', () => {
  it('parses empty input to defaults', () => {
    const result = storageConfigSchema.parse({});
    expect(result).toEqual({
      tokensFile: '.data/tokens.json',
      tokensEncKey: undefined,
    });
  });

  it('round-trips a fully-populated input', () => {
    const input = {
      tokensFile: '/var/lib/mcp-toolkit/tokens.json',
      tokensEncKey: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU',
    };
    const result = storageConfigSchema.parse(input);
    expect(result).toEqual(input);
  });
});
