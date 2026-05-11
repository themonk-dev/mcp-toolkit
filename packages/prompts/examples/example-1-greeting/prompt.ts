import { definePrompt } from '@mcp-toolkit/mcp';
import { z } from 'zod';

/**
 * Argument schema for the greeting prompt.
 *
 * Exposed as a `ZodRawShape` so `@mcp-toolkit/mcp`'s `buildServer` can hand it
 * straight to the SDK's `registerPrompt` for introspection.
 */
export const greetingArgsShape = {
  name: z.string().min(1).describe('Name to greet'),
  language: z
    .enum(['en', 'es', 'fr', 'de'])
    .optional()
    .describe('Language code (en, es, fr, de). Defaults to en.'),
};

const greetingArgs = z.object(greetingArgsShape);

const greetings: Record<'en' | 'es' | 'fr' | 'de', string> = {
  en: 'Hello',
  es: 'Hola',
  fr: 'Bonjour',
  de: 'Hallo',
};

/**
 * Greeting prompt: produces a friendly multilingual hello.
 *
 * Runtime-agnostic: works in Node and Cloudflare Workers. The handler validates
 * its own arguments so callers can pass loosely-typed `Record<string, unknown>`
 * straight from the wire.
 */
export const greetingPrompt = definePrompt({
  name: 'greeting',
  title: 'Greeting Prompt',
  description: 'Generate a personalized greeting in multiple languages',
  argsSchema: greetingArgsShape,
  handler: async (args) => {
    const parsed = greetingArgs.parse(args);
    const language = parsed.language ?? 'en';
    const greeting = greetings[language];

    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Create a warm, personalized greeting for ${parsed.name}. Start with "${greeting}, ${parsed.name}!" and then add a friendly welcome message that makes them feel valued and appreciated. Keep it concise but heartfelt.`,
          },
        },
      ],
    };
  },
});
