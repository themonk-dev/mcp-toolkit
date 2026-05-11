import { describe, expect, it } from 'bun:test';
import { greetingPrompt } from './prompt.ts';

describe('prompts/examples/greeting', () => {
  it('produces a user message containing the supplied name', async () => {
    const result = await greetingPrompt.handler({ name: 'Alice' });
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0];
    expect(msg?.role).toBe('user');
    expect(msg?.content.type).toBe('text');
    expect(String((msg?.content as { text?: string }).text ?? '')).toContain('Alice');
  });
});
