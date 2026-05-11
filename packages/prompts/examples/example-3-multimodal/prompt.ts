import { definePrompt, type PromptMessage } from '@mcp-toolkit/mcp';
import { z } from 'zod';

/**
 * Argument schema for the multimodal prompt.
 *
 * The boolean toggles are advertised as booleans (the legacy registrar shape).
 * The handler also tolerates the string forms `'true'`/`'false'` because some
 * MCP clients send all `prompts/get` arguments as strings on the wire.
 */
export const multimodalArgsShape = {
  task: z
    .string()
    .min(1)
    .describe('The analysis task to perform (e.g., "analyze this diagram")'),
  include_image: z.boolean().optional().describe('Include example image content'),
  include_audio: z.boolean().optional().describe('Include example audio content'),
  include_resource: z.boolean().optional().describe('Include embedded resource'),
};

function coerceBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/** 1×1 red-pixel PNG (base64). Stand-in for a real diagram or screenshot. */
const EXAMPLE_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

/** Minimal WAV file (base64). Stand-in for a real audio recording. */
const EXAMPLE_AUDIO_BASE64 =
  'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAAB9AAACABAAZGF0YQAAAAA=';

/**
 * Multimodal prompt: demonstrates rich content blocks (text, image, audio,
 * embedded resource) in a single multi-turn prompt payload.
 *
 * Runtime-agnostic: no Node-only APIs.
 */
export const multimodalPrompt = definePrompt({
  name: 'multimodal',
  title: 'Multimodal Prompt',
  description:
    'Generate analysis prompts with rich content (images, audio, embedded resources)',
  argsSchema: multimodalArgsShape,
  handler: async (args) => {
    const task = z.string().min(1).parse(args.task);
    const includeImage = coerceBool(args.include_image);
    const includeAudio = coerceBool(args.include_audio);
    const includeResource = coerceBool(args.include_resource);

    const messages: PromptMessage[] = [];

    // Initial user instruction.
    messages.push({
      role: 'user',
      content: {
        type: 'text',
        text: `Task: ${task}\n\nPlease analyze the provided content below and provide detailed insights.`,
      },
    });

    if (includeImage) {
      messages.push({
        role: 'user',
        content: {
          type: 'image',
          data: EXAMPLE_IMAGE_BASE64,
          mimeType: 'image/png',
          annotations: {
            audience: ['assistant'],
            priority: 0.9,
          },
        },
      });
    }

    if (includeAudio) {
      messages.push({
        role: 'user',
        content: {
          type: 'audio',
          data: EXAMPLE_AUDIO_BASE64,
          mimeType: 'audio/wav',
          annotations: {
            audience: ['assistant'],
            priority: 0.8,
          },
        },
      });
    }

    if (includeResource) {
      messages.push({
        role: 'user',
        content: {
          type: 'resource',
          resource: {
            uri: 'docs://overview',
            mimeType: 'text/markdown',
            text: `# Context Document

This is an embedded resource that provides additional context for the analysis.

## Key Points
- Resources can be embedded directly in prompts
- This allows providing rich contextual information
- The LLM can reference this content in its analysis

Use this document as reference material when completing the task.`,
          },
        },
      });
    }

    // Demonstrates a multi-turn shape when extra content blocks are present.
    if (includeImage || includeAudio || includeResource) {
      messages.push({
        role: 'assistant',
        content: {
          type: 'text',
          text: "I've received the content. Let me analyze it for you.",
        },
      });
    }

    // Closing user instruction.
    messages.push({
      role: 'user',
      content: {
        type: 'text',
        text: 'Please provide a comprehensive analysis with specific observations and actionable recommendations.',
      },
    });

    return { messages };
  },
});
