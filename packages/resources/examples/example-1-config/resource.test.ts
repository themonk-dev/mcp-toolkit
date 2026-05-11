import { describe, expect, it } from 'bun:test';
import { configResource } from './resource.ts';

describe('resources/examples/config', () => {
  it('returns a contents array and redacts sensitive keys', async () => {
    const prev = process.env.RS_TOKENS_ENC_KEY;
    process.env.RS_TOKENS_ENC_KEY = 'super-secret-do-not-leak';
    try {
      const result = await configResource.handler();
      expect(Array.isArray(result.contents)).toBe(true);
      expect(result.contents).toHaveLength(1);

      const entry = result.contents[0];
      expect(entry?.uri).toBe('config://server');
      expect(entry?.mimeType).toBe('application/json');

      const parsed = JSON.parse(entry?.text ?? '{}') as Record<string, unknown>;
      expect(parsed.RS_TOKENS_ENC_KEY).toBe('[REDACTED]');
      // The plaintext value must not leak in the rendered JSON.
      expect(entry?.text ?? '').not.toContain('super-secret-do-not-leak');
    } finally {
      if (prev === undefined) {
        delete process.env.RS_TOKENS_ENC_KEY;
      } else {
        process.env.RS_TOKENS_ENC_KEY = prev;
      }
    }
  });
});
