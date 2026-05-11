# Example 3 — `multimodalPrompt`

A prompt that emits a multi-block, multi-turn payload mixing text, image,
audio, and embedded-resource content blocks.

## What it does

Builds a sequence of `PromptMessage`s. Always emits an opening `user` text
block describing the task and a closing `user` text block asking for
recommendations. Between them, optionally includes an image, audio, and/or
embedded resource. When any rich block is present, an `assistant`
acknowledgement turn is inserted so the resulting prompt is multi-turn.

## Arguments

| Name               | Type    | Required | Default | Description                                |
| ------------------ | ------- | -------- | ------- | ------------------------------------------ |
| `task`             | string  | yes      | —       | The analysis task                          |
| `include_image`    | boolean | no       | `false` | Add a sample PNG content block             |
| `include_audio`    | boolean | no       | `false` | Add a sample WAV content block             |
| `include_resource` | boolean | no       | `false` | Add an embedded markdown resource block    |

The boolean flags also accept the string literals `'true'` / `'false'` because
some MCP clients serialize all `prompts/get` arguments as strings.

## Example invocation

```ts
import { multimodalPrompt } from '@mcp-toolkit/prompts/examples';

const result = await multimodalPrompt.handler({
  task: 'analyze this diagram',
  include_image: true,
  include_resource: true,
});
// result.messages.length === 5  (text + image + resource + assistant ack + closing text)
```

## Policy gating

This prompt is registered under the name `multimodal`. The `@mcp-toolkit/mcp`
dispatcher calls `assertPromptAllowed('multimodal')` before invoking the
handler, so a deployment can deny it via `@mcp-toolkit/policy` without changing
the prompt's source.
