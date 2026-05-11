import { describe, expect, it } from 'bun:test';
import { analysisPrompt } from './prompt.ts';

describe('prompts/examples/analysis', () => {
  it('embeds the topic and reflects the requested depth in the prompt text', async () => {
    const result = await analysisPrompt.handler({
      topic: 'TS',
      depth: 'advanced',
    });
    const msg = result.messages[0];
    expect(msg?.role).toBe('user');
    const text = String((msg?.content as { text?: string }).text ?? '');
    expect(text).toContain('"TS"');
    // 'advanced' depth instruction text is unique to that level.
    expect(text.toLowerCase()).toContain('advanced');
  });
});
