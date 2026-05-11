import { describe, expect, it } from 'bun:test';
import { multimodalPrompt } from './prompt.ts';

describe('prompts/examples/multimodal', () => {
  it('includes an image content block when include_image=true', async () => {
    const result = await multimodalPrompt.handler({
      task: 'describe',
      include_image: true,
    });
    const types = result.messages.map((m) => m.content.type);
    expect(types).toContain('image');

    const imageMsg = result.messages.find((m) => m.content.type === 'image');
    expect(imageMsg).toBeDefined();
    const c = imageMsg?.content as { mimeType?: string; data?: string };
    expect(c.mimeType).toBe('image/png');
    expect(typeof c.data).toBe('string');
  });
});
