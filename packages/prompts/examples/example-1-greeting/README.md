# Example 1 — `greetingPrompt`

A minimal prompt demonstrating typed arguments with an optional enum.

## What it does

Produces a single-message `user` prompt asking the model to generate a warm,
personalized greeting in one of four languages.

## Arguments

| Name       | Type                          | Required | Default | Description                              |
| ---------- | ----------------------------- | -------- | ------- | ---------------------------------------- |
| `name`     | string                        | yes      | —       | Person to greet                          |
| `language` | `'en' \| 'es' \| 'fr' \| 'de'` | no       | `en`    | Language for the opening greeting word   |

## Example invocation

```ts
import { greetingPrompt } from '@mcp-toolkit/prompts/examples';

const result = await greetingPrompt.handler({ name: 'Ada', language: 'fr' });
// result.messages[0].content.text starts with: "Create a warm, personalized greeting for Ada. Start with \"Bonjour, Ada!\"..."
```

Or via an MCP client:

```json
{ "method": "prompts/get", "params": { "name": "greeting", "arguments": { "name": "Ada", "language": "fr" } } }
```

## Policy gating

This prompt does no gating itself. The `@mcp-toolkit/mcp` dispatcher calls
`assertPromptAllowed('greeting')` before invoking the handler, so a deployment
that wires policy via `buildServer` can deny this prompt by name without any
change to the prompt code.
