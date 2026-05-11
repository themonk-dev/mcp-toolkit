# `@mcp-toolkit/prompts`

Prompt definition contract + bundled examples for `mcp-toolkit`. Bring your
own prompts, or use the three included ones to get a server running quickly.

## What this is

A thin package that re-exports the prompt contract types from `@mcp-toolkit/mcp`
(`PromptDefinition`, `PromptResult`, `PromptMessage`, `PromptArgument`,
`definePrompt`) and ships three runtime-agnostic example prompts. SDK
registration, policy gating, and pagination all live in `@mcp-toolkit/mcp`'s
`buildServer` — this package only produces `PromptDefinition` instances.

The examples have no `node:*` imports, so they run unchanged in Cloudflare
Workers as well as Node.

## Define your own prompt

```ts
import { definePrompt } from '@mcp-toolkit/prompts';
import { z } from 'zod';

export const myPrompt = definePrompt({
  name: 'my_prompt',
  title: 'My Prompt',
  description: 'One-line description shown in prompt catalogs',
  argsSchema: {
    target: z.string().describe('What to operate on'),
  },
  handler: async (args) => ({
    messages: [
      { role: 'user', content: { type: 'text', text: `Work on ${args.target}` } },
    ],
  }),
});
```

## Bundled examples

- **`greetingPrompt`** (`examples/example-1-greeting/`) — name + language → friendly hello.
- **`analysisPrompt`** (`examples/example-2-analysis/`) — topic + depth + include_examples → structured analysis kickoff.
- **`multimodalPrompt`** (`examples/example-3-multimodal/`) — task + optional image / audio / resource toggles → multi-block, multi-turn prompt.

Each folder has its own README with the argument table and an example call.

## How to register

```ts
import { buildServer } from '@mcp-toolkit/mcp';
import { examplePrompts } from '@mcp-toolkit/prompts/examples';

const server = buildServer({
  // ...tools, resources, auth, env...
  prompts: examplePrompts,
});
```

You can also pass a hand-picked subset, or mix examples with your own:

```ts
import { greetingPrompt } from '@mcp-toolkit/prompts/examples';
import { myPrompt } from './my-prompt.ts';

const server = buildServer({ prompts: [greetingPrompt, myPrompt] });
```

## Env keys

The bundled examples read no environment variables. See `.env.example` — it is
intentionally empty and exists so deployments have a place to drop fragments
when their own prompts pick up env keys.

## Testing your prompt

A `PromptDefinition`'s handler is a plain async function — call it directly:

```ts
import { greetingPrompt } from '@mcp-toolkit/prompts/examples';

const result = await greetingPrompt.handler({ name: 'Ada', language: 'fr' });
console.log(result.messages[0].content);
```

No SDK, no transport, no server required. Policy gating is applied by
`buildServer` before the handler runs, so unit tests of the handler itself
need not stub policy.
