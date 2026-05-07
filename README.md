# opencode-trae-cli-auth

An [opencode](https://opencode.ai/) provider plugin that exposes Trae models through Trae raw-chat SSE or an OpenAI-compatible HTTP endpoint.

It is intended to make Trae act as an LLM backend for opencode. For coding workflows, use OAuth/PAT plus a provider base URL; the legacy `traecli` subprocess path is disabled by default.

## Features

- Adds a `trae` provider to opencode.
- Prefers direct Trae raw-chat SSE streaming when `pat` is configured.
- Supports generic OpenAI-compatible streaming when `openaiBaseURL` and `openaiApiKey` are configured.
- Disables legacy `traecli` fallback by default to avoid CLI-internal tool restrictions leaking into OpenCode.
- Exposes common Trae cloud models, including `GLM-5.1`, `Doubao-Seed-2.0-Code`, `DeepSeek-V3.2`, `Qwen3-Coder-Next`, and more.
- Reads the current model from `~/.trae/trae_cli.yaml` / `~/.trae/traecli.yaml` when available.
- Provides stable text-first generation and an optional experimental tool-call bridge for coding workflows.
- Supports local `file://` plugin installs for development.

## Prerequisites

- Node.js >= 20
- opencode >= 1.14
- A Trae enterprise/PAT token or an OpenAI-compatible endpoint token

## Install

From npm:

```bash
opencode plugin opencode-trae-cli-auth
```

For local development from this repository:

```bash
npm install
npm run build
opencode plugin file:///absolute/path/to/opencode-trae-cli-auth/dist/index.js
```

You can also add it manually to an opencode config:

```json
{
  "plugin": [
    "opencode-trae-cli-auth"
  ],
  "model": "trae/GLM-5.1"
}
```

Local file example:

```json
{
  "plugin": [
    "file:///Users/you/dev/opencode-trae-cli-auth/dist/index.js"
  ],
  "model": "trae/GLM-5.1"
}
```

## Models

List models after installing:

```bash
opencode models trae
```

Built-in model ids currently include:

- `trae/Doubao-Seed-Code`
- `trae/GLM-5.1`
- `trae/MiniMax-M2.7`
- `trae/Kimi-K2.6`
- `trae/DeepSeek-V4-Pro`

## Usage

```bash
opencode run --agent build --model trae/GLM-5.1 "reply with 'ok'"
```

## Capability Boundary

This package can use these backend transports:

- Direct Trae raw-chat HTTP: enabled by `pat`; posts to Trae enterprise raw chat and consumes real SSE output.
- Direct OpenAI-compatible HTTP: enabled by `openaiBaseURL` + `openaiApiKey`; supports SSE text streaming and OpenAI-style streamed `tool_calls`.
- Legacy Trae CLI fallback: disabled by default. Enable only with `allowCliFallback: true` for debugging or migration.

The provider uses a single model-first configuration path. Users select a model directly, and behavior changes only through explicit options.

Tool execution still belongs to OpenCode runtime (permissions, sandbox, command execution). Trae CLI is not used as a standalone tool runtime.

## Options

When loading the plugin programmatically, the intended user-facing options are:

```ts
type TraePluginOptions = {
  pat?: string
  openaiBaseURL?: string
  openaiApiKey?: string
  modelName?: string
  enableToolCalling?: boolean
  allowCliFallback?: boolean
  cliPath?: string
}
```

- `pat`: explicit Trae PAT/OAuth token for direct raw-chat transport. This is intentionally read only from `provider.trae.options.pat`, not from environment variables.
- `openaiBaseURL`: optional OpenAI-compatible base URL. When set with `openaiApiKey`, this transport is used before CLI fallback.
- `openaiApiKey`: bearer token for the OpenAI-compatible endpoint.
- `modelName`: force a Trae `model.name` regardless of opencode model id. Leave unset to use the selected opencode model id directly.
- `enableToolCalling`: defaults to `true`; when `true`, provider forwards Trae `function` tool calls to OpenCode.
- `allowCliFallback`: defaults to `false`. Keep it false for real OpenCode usage; set true only to debug the legacy `traecli` subprocess path.
- `cliPath`: legacy only; override the `traecli` binary path when `allowCliFallback=true`.

## Known limitations

- Tool execution depends on OpenCode runtime permissions and sandbox policy.
- Experimental mode: `enableToolCalling=true` supports forwarding streamed function tool calls observed from direct HTTP transports.
- In experimental tool-calling mode, common tool input aliases are normalized (`file_path -> filePath`, `old_string/new_string -> oldString/newString`, etc.).
- Usage/token counts may be zero when the upstream transport does not emit usage metadata.
- Legacy CLI mode can leak `traecli` internal tool restrictions into model behavior and is not recommended for coding agents.

## Development

```bash
bun install
bun run test
bun run build
bun pm pack --dry-run
```

Smoke check a local Trae CLI and OpenCode install:

```bash
traecli "reply with ok" -p --json
opencode run --agent build --model trae/GLM-5.1 "reply with ok"
```

Recommended local config examples:

Direct Trae raw-chat transport:

```json
{
  "provider": {
    "trae": {
      "options": {
        "pat": "your-token"
      }
    }
  },
  "model": "trae/Kimi-K2.6"
}
```

`pat` is explicit by design. The plugin does not read `TRAE_RAW_API_KEY`, `TRAECLI_PERSONAL_ACCESS_TOKEN`, or other token environment variables.

Direct OpenAI-compatible transport:

```json
{
  "provider": {
    "trae": {
      "options": {
        "openaiBaseURL": "https://your-enterprise-openai-compatible-host/v1",
        "openaiApiKey": "your-token"
      }
    }
  },
  "model": "trae/DeepSeek-V4-Pro"
}
```

OpenAI-compatible credentials are also explicit config only; the plugin does not read token environment variables.

Legacy CLI debug example:

```json
{
  "provider": {
    "trae": {
      "options": {
        "allowCliFallback": true
      }
    }
  },
  "model": "trae/GLM-5.1"
}
```

Optional soak test (success rate + latency summary):

```bash
bun run soak -- --model trae/GLM-5.1 --runs 12 --concurrency 3
```

Tool-calling smoke (reports whether `tool-call` events are observed):

```bash
bun run smoke:tools -- --model trae/GLM-5.1
```

Strict mode (non-zero exit if no `tool-call` event):

```bash
bun run smoke:tools -- --model trae/GLM-5.1 --strict
```

Overnight agentic run (prompt-file driven, no built-in demo prompts):

```bash
bun run overnight -- \
  --model trae/GLM-5.1 \
  --hours 8 \
  --concurrency 2 \
  --timeoutMs 180000 \
  --promptsFile /absolute/path/to/prompts.txt
```

`prompts.txt` format: one real task prompt per line, lines starting with `#` are ignored.
Results are written to `artifacts/overnight/*.jsonl` plus a `*.summary.json`.
`--maxRuns` is optional; omit it for true overnight runs. Use it for short verification runs.


## Trae CLI env helper

This repository includes `scripts/trae-cli-env.sh`, a sourceable shell helper for machines where Trae CLI is already installed.

Usage:

```bash
PAT=<your-token> source scripts/trae-cli-env.sh
trae-cli --print "say hello"
```

The helper creates the minimal Trae config files only when missing:

- `~/.trae/traecli.yaml`
- `~/.trae/trae_cli.yaml`

It exports `TRAECLI_PERSONAL_ACCESS_TOKEN` and `SEC_TOKEN_PATH`, and adds the detected `trae-cli` binary directory to `PATH`.

## License

MIT
