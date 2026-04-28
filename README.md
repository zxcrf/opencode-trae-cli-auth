# opencode-trae-cli-auth

An [opencode](https://opencode.ai/) provider plugin that proxies model calls through your local `traecli` login.

It is useful when Trae CLI already works locally and you want to use the same account/models from opencode.

## Features

- Adds a `trae` provider to opencode.
- Uses the local `traecli` binary and existing Trae login; no API key is stored by this package.
- Exposes common Trae cloud models, including `GLM-5.1`, `Doubao-Seed-2.0-Code`, `DeepSeek-V3.2`, `Qwen3-Coder-Next`, and more.
- Reads the current model from `~/.trae/trae_cli.yaml` / `~/.trae/traecli.yaml` when available.
- Provides stable text-first generation and an optional experimental tool-call bridge for coding workflows.
- Supports local `file://` plugin installs for development.

## Prerequisites

- Node.js >= 20
- opencode >= 1.14
- `traecli` installed and logged in

Verify Trae CLI first:

```bash
traecli "reply with 'ok'" -p --json
```

If this command fails, fix Trae CLI login/config before using this plugin.

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

- `trae/default`
- `trae/Doubao-Seed-2.0-Code`
- `trae/Doubao-Seed-Code`
- `trae/GLM-5.1`
- `trae/GLM-5`
- `trae/GLM-4.7`
- `trae/MiniMax-M2.7`
- `trae/fast` (alias to `MiniMax-M2.7`)
- `trae/balanced` (alias to `GLM-5.1`)
- `trae/strong` (alias to `Kimi-K2.6`)
- `trae/coding` (alias to `GLM-5.1`)
- `trae/MiniMax-M2.5`
- `trae/Qwen3-Coder-Next`
- `trae/Kimi-K2.6`
- `trae/Kimi-K2.5`
- `trae/DeepSeek-V3.2`
- `trae/DeepSeek-V3.1-Terminus`

`trae/default` does not pass `model.name` and uses the default model selected in Trae CLI.

Other model ids are passed to Trae CLI as:

```bash
--config model.name=<model-id>
```

## Usage

```bash
opencode run --model trae/GLM-5.1 "reply with 'ok'"
```

## Capability Boundary

This package uses Trae CLI as the model backend. In default `coding` profile, tool-calling forwarding is enabled (`enableToolCalling=true`) so OpenCode can execute tools locally while Trae emits tool intents.

Tool execution still belongs to OpenCode runtime (permissions, sandbox, command execution). Trae CLI is not used as a standalone tool runtime.

## Options

When loading the plugin programmatically, the plugin accepts:

```ts
type TraePluginOptions = {
  profile?: "coding" | "text" | "tools"
  cliPath?: string
  modelName?: string
  modelAliases?: Record<string, string>
  enableToolCalling?: boolean
  queryTimeout?: number
  includeToolHistory?: boolean
  maxPromptMessages?: number
  maxPromptChars?: number
  maxToolPayloadChars?: number
  enforceTextOnly?: boolean
  maxRetries?: number
  retryDelayMs?: number
  extraArgs?: string[]
  sessionId?: string
}
```

- `profile`: quick preset. default is `coding`. `coding` = coding-oriented defaults, `text` = stable text-only defaults, `tools` = experimental tool-calling defaults.
- `cliPath`: override the `traecli` binary path.
- `modelName`: force a Trae `model.name` regardless of opencode model id.
- `modelAliases`: optional alias map, e.g. `{ coding: "GLM-5.1" }`, so users can call `trae/coding`.
- `enableToolCalling`: experimental, defaults to `false`; when `true`, provider forwards Trae `function` tool calls to OpenCode.
- `queryTimeout`: timeout in seconds for `traecli --query-timeout`.
- `includeToolHistory`: defaults to `false`; omit prior `tool-call/tool-result` history from prompt to reduce context bloat in text-only mode.
- `maxPromptMessages`: defaults to `40`; keep all `system` messages and only the most recent non-system messages.
- `maxPromptChars`: defaults to `12000`; truncates oversized serialized prompt from the head and keeps the newest tail context.
- `maxToolPayloadChars`: truncates oversized tool call inputs and tool result payloads before they are injected back into prompt history (default: `coding=4000`, `tools=6000`, `text=2000`).
- `enforceTextOnly`: defaults to `true`; adds `--disallowed-tool` flags for common tools (`Read/Bash/Edit/Replace/Write/Glob/Grep/Task`) to keep Trae CLI in text-only behavior.
- `maxRetries`: transient error retry count, default `1`.
- `retryDelayMs`: delay between retries in milliseconds, default `800`.
- `extraArgs`: extra arguments appended to `traecli`.
- `sessionId`: retained for configuration compatibility, but not used by the text-only execution path.

## Known limitations

- Tool execution depends on OpenCode runtime permissions and sandbox policy.
- Experimental mode: `enableToolCalling=true` only supports forwarding function tool calls observed in Trae JSON output; behavior may vary across Trae CLI versions.
- In experimental tool-calling mode, common tool input aliases are normalized (`file_path -> filePath`, `old_string/new_string -> oldString/newString`, etc.).
- Usage/token counts may be zero when Trae CLI does not emit usage metadata.
- Trae CLI may print `keyring is not supported on this system`; this is a Trae CLI environment warning and usually does not prevent responses.

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
opencode run --model trae/default "reply with ok"
```

Recommended local config presets:

Coding default preset:

```json
{
  "provider": {
    "trae": {
      "options": {
        "profile": "coding",
        "modelName": "GLM-5.1",
        "enableToolCalling": true,
        "includeToolHistory": true,
        "enforceTextOnly": false,
        "maxPromptMessages": 60,
        "maxPromptChars": 20000,
        "maxToolPayloadChars": 4000
      }
    }
  },
  "model": "trae/coding"
}
```

Text-only stable preset:

```json
{
  "provider": {
    "trae": {
      "options": {
        "profile": "text",
        "enableToolCalling": false,
        "enforceTextOnly": true,
        "maxPromptMessages": 40,
        "maxPromptChars": 12000,
        "maxToolPayloadChars": 2000
      }
    }
  },
  "model": "trae/coding"
}
```

Experimental tool-calling preset:

```json
{
  "provider": {
    "trae": {
      "options": {
        "profile": "tools",
        "enableToolCalling": true,
        "includeToolHistory": true,
        "enforceTextOnly": false,
        "maxPromptMessages": 50,
        "maxPromptChars": 16000,
        "maxToolPayloadChars": 6000
      }
    }
  },
  "model": "trae/coding"
}
```

Ready-to-use config files are included:

- `examples/opencode.coding.json`
- `examples/opencode.text.json`
- `examples/opencode.tools.json`

Optional soak test (success rate + latency summary):

```bash
bun run soak -- --model trae/default --runs 12 --concurrency 3
```

Tool-calling smoke (reports whether `tool-call` events are observed):

```bash
bun run smoke:tools -- --model trae/coding
```

Strict mode (non-zero exit if no `tool-call` event):

```bash
bun run smoke:tools -- --model trae/coding --strict
```


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
