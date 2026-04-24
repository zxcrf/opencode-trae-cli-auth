# opencode-trae-cli-auth

An [opencode](https://opencode.ai/) provider plugin that proxies model calls through your local `traecli` login.

It is useful when Trae CLI already works locally and you want to use the same account/models from opencode.

## Features

- Adds a `trae` provider to opencode.
- Uses the local `traecli` binary and existing Trae login; no API key is stored by this package.
- Exposes common Trae cloud models, including `GLM-5.1`, `Doubao-Seed-2.0-Code`, `DeepSeek-V3.2`, `Qwen3-Coder-Next`, and more.
- Reads the current model from `~/.trae/trae_cli.yaml` / `~/.trae/traecli.yaml` when available.
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

## Options

When loading the plugin programmatically, the plugin accepts:

```ts
type TraePluginOptions = {
  cliPath?: string
  modelName?: string
  queryTimeout?: number
  extraArgs?: string[]
  sessionId?: string
}
```

- `cliPath`: override the `traecli` binary path.
- `modelName`: force a Trae `model.name` regardless of opencode model id.
- `queryTimeout`: timeout in seconds for `traecli --query-timeout`.
- `extraArgs`: extra arguments appended to `traecli`.
- `sessionId`: optional session id; not passed by default because some Trae CLI versions crash with explicit session ids.

## Known limitations

- Tool calls are not supported yet; models are advertised with `tool_call: false`.
- Usage/token counts may be zero when Trae CLI does not emit usage metadata.
- Trae CLI may print `keyring is not supported on this system`; this is a Trae CLI environment warning and usually does not prevent responses.

## Development

```bash
npm install
npm test
npm run build
npm pack --dry-run
```

## License

MIT
