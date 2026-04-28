# opencode-trae-cli-auth

An [opencode](https://opencode.ai/) provider plugin that proxies model calls through your local `traecli` login.

It is useful when Trae CLI already works locally and you want to use the same account/models from opencode.

## Features

- Adds a `trae` provider to opencode.
- Uses the local `traecli` binary and existing Trae login; no API key is stored by this package.
- Exposes common Trae cloud models, including `GLM-5.1`, `Doubao-Seed-2.0-Code`, `DeepSeek-V3.2`, `Qwen3-Coder-Next`, and more.
- Reads the current model from `~/.trae/trae_cli.yaml` / `~/.trae/traecli.yaml` when available.
- Provides text-only LLM generation; OpenCode tools are not delegated to Trae CLI.
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

This package uses Trae CLI only as a text-in/text-out LLM backend. OpenCode tools, shell commands, file reads, MCP calls, and permission prompts are not delegated to Trae CLI.

Model metadata intentionally advertises `tool_call: false` and `attachment: false`. This provider does not support OpenCode tool/function calling and does not use Trae CLI as an agent runtime.

## Options

When loading the plugin programmatically, the plugin accepts:

```ts
type TraePluginOptions = {
  cliPath?: string
  modelName?: string
  queryTimeout?: number
  includeToolHistory?: boolean
  enforceTextOnly?: boolean
  maxRetries?: number
  retryDelayMs?: number
  extraArgs?: string[]
  sessionId?: string
}
```

- `cliPath`: override the `traecli` binary path.
- `modelName`: force a Trae `model.name` regardless of opencode model id.
- `queryTimeout`: timeout in seconds for `traecli --query-timeout`.
- `includeToolHistory`: defaults to `false`; omit prior `tool-call/tool-result` history from prompt to reduce context bloat in text-only mode.
- `enforceTextOnly`: defaults to `true`; adds `--disallowed-tool` flags for common tools (`Read/Bash/Edit/Replace/Write/Glob/Grep/Task`) to keep Trae CLI in text-only behavior.
- `maxRetries`: transient error retry count, default `1`.
- `retryDelayMs`: delay between retries in milliseconds, default `800`.
- `extraArgs`: extra arguments appended to `traecli`.
- `sessionId`: retained for configuration compatibility, but not used by the text-only execution path.

## Known limitations

- This provider is text-only by design. It does not support OpenCode tool/function calling and does not use Trae CLI as an agent runtime.
- Usage/token counts may be zero when Trae CLI does not emit usage metadata.
- Trae CLI may print `keyring is not supported on this system`; this is a Trae CLI environment warning and usually does not prevent responses.

## Development

```bash
npm install
npm test
npm run build
npm pack --dry-run
```

Smoke check a local Trae CLI and OpenCode install:

```bash
traecli "reply with ok" -p --json
opencode run --model trae/default "reply with ok"
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
