import { definePrompt } from '@mcp-toolkit/mcp';
import { z } from 'zod';

/**
 * Argument schema for the analysis prompt.
 *
 * `depth` and `include_examples` are advertised as strings because the SDK's
 * `prompts/get` argument transport is string-only on most clients. The handler
 * coerces them into typed values.
 */
export const analysisArgsShape = {
  topic: z.string().min(1).describe('Topic to analyze'),
  depth: z
    .string()
    .optional()
    .describe('Depth level: basic | intermediate | advanced (default: basic)'),
  include_examples: z
    .string()
    .optional()
    .describe('Include examples: true | false (default: true)'),
};

type Depth = 'basic' | 'intermediate' | 'advanced';

const depthInstructions: Record<Depth, string> = {
  basic: 'Provide a high-level overview with key concepts and basic explanations.',
  intermediate:
    'Include detailed explanations, relationships between concepts, and practical considerations.',
  advanced:
    'Cover complex aspects, edge cases, advanced techniques, and expert-level insights.',
};

function coerceDepth(value: unknown): Depth {
  if (value === 'intermediate' || value === 'advanced') return value;
  return 'basic';
}

function coerceIncludeExamples(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'false') return false;
  // Default true preserves the legacy schema's behavior.
  return true;
}

/**
 * Analysis prompt: kicks off a structured, multi-section analysis of a topic.
 *
 * Runtime-agnostic: no Node-only APIs. The handler tolerates loose argument
 * shapes (strings, missing fields) so it can be driven from any MCP client.
 */
export const analysisPrompt = definePrompt({
  name: 'analysis',
  title: 'Analysis Prompt',
  description:
    'Generate a structured analysis prompt for any topic with customizable depth',
  argsSchema: analysisArgsShape,
  handler: async (args) => {
    const topic = z.string().min(1).parse(args.topic);
    const depth = coerceDepth(args.depth);
    const includeExamples = coerceIncludeExamples(args.include_examples);

    let analysisText = `Please provide a comprehensive analysis of "${topic}". ${depthInstructions[depth]}`;

    if (includeExamples) {
      analysisText +=
        ' Include relevant examples and case studies to illustrate key points.';
    }

    analysisText += `

Structure your analysis with:
1. Introduction and context
2. Key components or aspects
3. Benefits and advantages
4. Challenges and limitations
5. Current trends or developments
6. Conclusion and recommendations

Ensure the analysis is well-researched, balanced, and provides actionable insights.`;

    return {
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: analysisText },
        },
      ],
    };
  },
});
