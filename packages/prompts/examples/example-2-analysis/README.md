# Example 2 — `analysisPrompt`

A structured-analysis kickoff prompt with tunable depth.

## What it does

Builds a single-message `user` prompt that asks the model to produce a six-part
analysis (intro, components, benefits, challenges, trends, conclusion) of an
arbitrary topic, at the requested depth.

## Arguments

| Name               | Type   | Required | Default | Description                                                      |
| ------------------ | ------ | -------- | ------- | ---------------------------------------------------------------- |
| `topic`            | string | yes      | —       | Subject of the analysis                                          |
| `depth`            | string | no       | `basic` | One of `basic`, `intermediate`, `advanced`                        |
| `include_examples` | string | no       | `true`  | `true` or `false`; whether to ask for case studies and examples |

`depth` and `include_examples` are advertised as strings because most MCP
clients ship `prompts/get` arguments as strings. The handler coerces them.

## Example invocation

```ts
import { analysisPrompt } from '@mcp-toolkit/prompts/examples';

const result = await analysisPrompt.handler({
  topic: 'distributed consensus',
  depth: 'advanced',
  include_examples: 'true',
});
```

## Policy gating

This prompt is registered under the name `analysis`. Deployments that wire
`@mcp-toolkit/policy` via `buildServer` can deny it by name; the dispatcher calls
`assertPromptAllowed('analysis')` before this handler ever runs, so the prompt
itself stays free of policy concerns.
