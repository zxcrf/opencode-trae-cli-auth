# Trae Text-Only OpenCode Bridge Design

## Goal

Build `opencode-trae-cli-auth` into a stable, long-lived OpenCode provider that uses Trae CLI only as a text-in/text-out LLM backend.

The provider must not claim or emulate function calling. It must not use Trae CLI as an agent runtime, must not rely on Trae CLI TUI behavior, and must not let Trae CLI execute local tools. OpenCode remains responsible for its own tools, permissions, UI, and session state.

## Scope

In scope:

- Stable OpenCode `LanguageModelV2` provider behavior for text generation.
- Multi-turn prompt serialization from OpenCode message history.
- Safe handling of assistant history, including prior tool-call and tool-result messages as plain conversation context.
- Robust child-process execution for `traecli`, `trae-cli`, or `trae`.
- Timeout, abort, stderr noise, nonzero exit, malformed JSON, and empty-output handling.
- Clear capability metadata: `tool_call: false`, `attachment: false`, no embeddings, no image generation.
- Internal file boundaries that can later become a small CLI LLM bridge core.

Out of scope:

- OpenCode tool-call event emission.
- Prompt-based function-call parsing.
- Trae CLI interactive/TUI mode.
- Trae CLI `--session-id` as the primary state mechanism.
- Trae CLI built-in tool execution.
- General SDK package extraction. The code should be shaped for extraction, but the first delivery remains Trae-specific.

## Capability Model

The bridge exposes Trae CLI as a text-only LLM provider:

```ts
type CliLlmCapabilities = {
  text: true
  structuredOutput: false
  toolCalling: false
  attachments: false
}
```

OpenCode-facing model definitions must keep:

```ts
tool_call: false
attachment: false
```

This is deliberate. The provider should never advertise function calling unless the backend can produce reliable, schema-bound tool invocations through a real API contract. Prompt-based parsing is not function calling and is not part of this project.

## Architecture

The implementation should keep the current package but split responsibilities into focused modules:

```text
src/
  models.ts
  prompt-builder.ts
  trae-config-models.ts
  trae-language-model.ts
  cli/
    cli-runner.ts
    json-output.ts
    text-content.ts
    usage.ts
```

`trae-language-model.ts` remains the OpenCode `ProviderV2` and `LanguageModelV2` integration point. It should be thin: resolve CLI path, build the prompt, invoke the runner, convert the result into `LanguageModelV2StreamPart` events, and map failures into safe OpenCode stream finishes.

`prompt-builder.ts` owns serialization from `LanguageModelV2Prompt` to a single text prompt. It should preserve enough conversation structure for multi-turn use while keeping the output deterministic and testable.

`src/cli/*` contains CLI backend mechanics that are not Trae-specific except for command arguments passed by the caller. This is the future extraction boundary for a reusable CLI LLM bridge core.

## Prompt Serialization

The provider should serialize OpenCode history into deterministic tagged text:

```text
<system>
...
</system>

<user>
...
</user>

<assistant>
...
</assistant>

<tool_call id="..." name="...">
{...}
</tool_call>

<tool_result id="..." name="...">
...
</tool_result>
```

Tool-call and tool-result prompt parts are preserved as history only. They are not interpreted as live function-calling capability. This allows OpenCode sessions that previously used tools with another model, or sessions that contain historical tool context, to continue without crashing the provider.

Unsupported message parts should be represented as short text placeholders rather than throwing, unless the part is invalid enough that prompt construction cannot proceed. Image/file inputs should not be advertised through model metadata; if they appear in history, the serializer should use a placeholder such as `[Unsupported image input omitted: image/png]`.

## CLI Execution

The provider should run Trae CLI only in non-interactive print mode:

```text
<cliPath> <prompt> -p --json --query-timeout <seconds>s [--config model.name=<model>]
```

Rules:

- Do not use TUI mode.
- Do not use `--session-id` by default.
- Do not pass OpenCode tools to Trae CLI.
- Do not depend on Trae CLI session files for correctness.
- Kill the child process on OpenCode abort.
- Enforce a provider-side timeout even if Trae CLI timeout behavior changes.
- Capture stdout and stderr separately.
- Parse the last valid JSON value from combined output only after retaining stderr for diagnostics.

The parser must accept noisy output where warnings appear before or after the JSON response. It must reject output that has no valid response object and return a typed error that can be rendered safely in OpenCode.

## Stream Behavior

The provider is allowed to be non-token-streaming in phase one, because Trae CLI print mode returns a complete JSON result. It should still expose a valid `ReadableStream<LanguageModelV2StreamPart>`:

```text
stream-start
text-start
text-delta
text-end
finish
```

For failures:

```text
stream-start
error
finish { finishReason: "error", usage: zero }
```

The stream must close exactly once. It must not throw after emitting `finish`. `doGenerate()` should consume `doStream()` and return the same text, finish reason, and usage.

## Error Policy

Errors should be specific enough for debugging but safe for OpenCode:

- Missing CLI: `traecli binary not found. Install traecli and ensure it is on PATH.`
- Timeout: `traecli timed out after <n>s`
- Abort: `traecli request aborted`
- Nonzero exit with no usable JSON: include trimmed stderr and exit code.
- Malformed output: include a short excerpt, capped to a small length.

Error messages should not dump full prompts, full environment variables, or token-like values.

## Testing

Unit tests must cover:

- Prompt serialization for system, user, assistant, prior tool-call, and tool-result messages.
- Unsupported image/file parts are represented safely.
- CLI JSON parser handles noisy stdout/stderr and rejects malformed output.
- CLI runner passes expected arguments, maps usage, supports abort, and handles nonzero exits.
- `TraeLanguageModel.doStream()` emits a valid event sequence for success and failure.
- Model metadata remains text-only with `tool_call: false`.

Integration smoke tests may remain opt-in because they require a working local Trae CLI login.

## Success Criteria

- `npm test` passes.
- `npm run build` passes.
- `opencode models trae` shows models with `tool_call: false`.
- `opencode run --model trae/default "reply with ok"` works when Trae CLI works locally.
- Multi-turn OpenCode prompts no longer crash because of prior assistant/tool history.
- CLI failures return controlled OpenCode errors instead of unhandled exceptions or malformed stream endings.

## Non-Goals Reaffirmed

This bridge does not make Trae CLI an OpenCode agent. It does not implement function calling. It does not parse model text into tool calls. It gives OpenCode a stable text-generation provider backed by Trae CLI.
