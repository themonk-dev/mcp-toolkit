import { describe, expect, it } from 'bun:test';
import { examplePrompts } from './index.ts';

describe('prompts/examples/index', () => {
  it('exports greeting / analysis / multimodal in the examplePrompts array', () => {
    const names = examplePrompts.map((p) => p.name);
    expect(names).toContain('greeting');
    expect(names).toContain('analysis');
    expect(names).toContain('multimodal');
  });
});
