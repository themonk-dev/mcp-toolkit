/**
 * Bundled example prompts for `@mcp-toolkit/prompts`.
 *
 * Each example is a `PromptDefinition` produced by `definePrompt(...)` and
 * lives in its own folder with a README. The `examplePrompts` array is the
 * convenient drop-in for `buildServer({ prompts: examplePrompts })`.
 */

import type { PromptDefinition } from '@mcp-toolkit/mcp';
import { greetingPrompt } from './example-1-greeting/prompt.ts';
import { analysisPrompt } from './example-2-analysis/prompt.ts';
import { multimodalPrompt } from './example-3-multimodal/prompt.ts';

export { analysisPrompt, greetingPrompt, multimodalPrompt };

/**
 * The bundled example prompts. Cast is local to this file (see the tools
 * package's `examples/index.ts` for the rationale on handler variance).
 */
export const examplePrompts = [
  greetingPrompt,
  analysisPrompt,
  multimodalPrompt,
] as unknown as PromptDefinition[];
