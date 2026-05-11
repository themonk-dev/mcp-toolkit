import { describe, expect, it } from 'bun:test';
import { exampleTools } from './index.ts';

describe('tools/examples/index', () => {
  it('exports echo / health / whoami in the exampleTools array', () => {
    const names = exampleTools.map((t) => t.name);
    expect(names).toContain('echo');
    expect(names).toContain('health');
    expect(names).toContain('whoami');
  });
});
