# Trae Text-Only Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `opencode-trae-cli-auth` into a stable text-only OpenCode provider backed by Trae CLI.

**Architecture:** Keep the public OpenCode provider in `src/trae-language-model.ts`, but move reusable CLI mechanics into `src/cli/*`. The bridge remains Trae-specific for this delivery while preserving future SDK boundaries around prompt serialization, child-process execution, JSON parsing, usage mapping, and stream conversion.

**Tech Stack:** TypeScript, Node.js child processes, `@ai-sdk/provider` `LanguageModelV2`, Vitest, OpenCode plugin hooks.

---

## File Structure

- Modify: `src/models.ts`
  Keep model metadata text-only and make that intent explicit in tests.
- Modify: `src/prompt-builder.ts`
  Serialize multi-turn OpenCode history safely, including prior tool-call and tool-result parts as text context.
- Create: `src/cli/json-output.ts`
  Parse noisy CLI output and produce either a response object or a typed parse error.
- Create: `src/cli/text-content.ts`
  Convert Trae CLI response content variants into text chunks.
- Create: `src/cli/usage.ts`
  Convert known usage field names into `LanguageModelV2Usage`.
- Create: `src/cli/cli-runner.ts`
  Own child-process execution, timeout, abort, stdout/stderr capture, and argument construction.
- Modify: `src/trae-language-model.ts`
  Use the new CLI modules and keep OpenCode stream event emission well-formed.
- Modify: `index.ts`
  Preserve provider injection behavior and ensure options still pass through.
- Modify: `README.md`
  Document text-only capability and non-goals.
- Modify tests under `tests/`
  Add focused unit coverage for each boundary and update existing expectations.

---

### Task 1: Lock Text-Only Model Capabilities

**Files:**
- Modify: `src/models.ts`
- Modify: `tests/models.test.ts`
- Modify: `tests/plugin.test.ts`

- [x] **Step 1: Add capability constants and failing tests**

Update `tests/models.test.ts` to assert every model is text-only:

```ts
it('advertises Trae as text-only without tool calling or attachments', () => {
  for (const [id, model] of Object.entries(TRAE_MODELS)) {
    expect(model.attachment, `${id}.attachment`).toBe(false)
    expect(model.tool_call, `${id}.tool_call`).toBe(false)
    expect(model.reasoning, `${id}.reasoning`).toBe(false)
  }
})
```

Update `tests/plugin.test.ts` to assert injected discovered models stay text-only:

```ts
expect(config.provider?.trae?.models?.sonnet?.tool_call).toBe(false)
expect(config.provider?.trae?.models?.sonnet?.attachment).toBe(false)
```

- [x] **Step 2: Run the focused tests**

Run:

```bash
npm test -- tests/models.test.ts tests/plugin.test.ts
```

Expected: tests either pass already or fail only because the new explicit expectations expose metadata drift.

- [x] **Step 3: Make `src/models.ts` explicit**

Add a local helper constant and use it from `createTraeModelDefinition`:

```ts
const TEXT_ONLY_CAPABILITIES = {
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: false,
} as const
```

Then return:

```ts
return {
  id,
  name: description || id,
  ...TEXT_ONLY_CAPABILITIES,
  cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  limit: { context: contextWindow ?? 128000, output: 8192 },
}
```

Use the same spread for `default`.

- [x] **Step 4: Verify**

Run:

```bash
npm test -- tests/models.test.ts tests/plugin.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models.ts tests/models.test.ts tests/plugin.test.ts
git commit -m "chore: document trae text-only capabilities"
```

---

### Task 2: Harden Prompt Serialization

**Files:**
- Modify: `src/prompt-builder.ts`
- Modify: `tests/trae-language-model.test.ts`
- Create: `tests/prompt-builder.test.ts`

- [x] **Step 1: Add prompt-builder tests**

Create `tests/prompt-builder.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../src/prompt-builder.js'

describe('prompt builder', () => {
  it('serializes multi-turn text history with role tags', () => {
    const prompt = buildPrompt([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ] as any)

    expect(prompt).toContain('<system>\nBe concise.\n</system>')
    expect(prompt).toContain('<user>\nhello\n</user>')
    expect(prompt).toContain('<assistant>\nhi\n</assistant>')
    expect(prompt).toContain('<user>\ncontinue\n</user>')
  })

  it('preserves prior tool calls and tool results as plain history', () => {
    const prompt = buildPrompt([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'read',
            input: { filePath: 'README.md' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'read',
            output: { type: 'text', value: 'contents' },
          },
        ],
      },
    ] as any)

    expect(prompt).toContain('<tool_call id="call-1" name="read">')
    expect(prompt).toContain('"filePath":"README.md"')
    expect(prompt).toContain('<tool_result id="call-1" name="read">')
    expect(prompt).toContain('contents')
  })

  it('represents unsupported media without throwing', () => {
    const prompt = buildPrompt([
      {
        role: 'user',
        content: [{ type: 'file', mediaType: 'image/png', data: 'abc' }],
      },
    ] as any)

    expect(prompt).toContain('[Unsupported file input omitted: image/png]')
  })
})
```

- [x] **Step 2: Run the failing prompt tests**

Run:

```bash
npm test -- tests/prompt-builder.test.ts
```

Expected: FAIL because current user messages are not wrapped in `<user>` and unsupported media is ignored.

- [x] **Step 3: Update `src/prompt-builder.ts`**

Implement role wrappers and safe part serialization:

```ts
function serializeMessage(message: LanguageModelV2Message): string {
  switch (message.role) {
    case 'system':
      return typeof message.content === 'string' ? wrap('system', message.content) : ''
    case 'user':
      return Array.isArray(message.content)
        ? wrap('user', message.content.map(serializePart).filter(Boolean).join('\n'))
        : ''
    case 'assistant':
      return Array.isArray(message.content)
        ? wrap('assistant', message.content.map(serializePart).filter(Boolean).join('\n'))
        : ''
    case 'tool':
      return Array.isArray(message.content)
        ? message.content.map(serializeToolResultPart).filter(Boolean).join('\n')
        : ''
    default:
      return ''
  }
}

function wrap(tag: string, value: string): string {
  return value.trim() ? `<${tag}>\n${value}\n</${tag}>` : ''
}
```

Use compact JSON for tool call inputs:

```ts
const input = typeof record.input === 'string' ? record.input : JSON.stringify(record.input ?? {})
```

Serialize tool results by output type:

```ts
function serializeToolResultOutput(output: unknown): string {
  if (!output || typeof output !== 'object') return String(output ?? '')
  const record = output as Record<string, unknown>
  if (record.type === 'text' && typeof record.value === 'string') return record.value
  if (record.type === 'json') return JSON.stringify(record.value)
  if (record.type === 'error-text' && typeof record.value === 'string') return `[Error] ${record.value}`
  if (record.type === 'error-json') return `[Error] ${JSON.stringify(record.value)}`
  return JSON.stringify(output)
}
```

For unsupported files:

```ts
if (record.type === 'file') {
  return `[Unsupported file input omitted: ${String(record.mediaType ?? 'unknown')}]`
}
```

- [x] **Step 4: Verify prompt tests**

Run:

```bash
npm test -- tests/prompt-builder.test.ts
```

Expected: PASS.

- [x] **Step 5: Run existing language model tests**

Run:

```bash
npm test -- tests/trae-language-model.test.ts
```

Expected: PASS after updating expected CLI prompt arguments from `ping` to `<user>\nping\n</user>` where needed.

- [ ] **Step 6: Commit**

```bash
git add src/prompt-builder.ts tests/prompt-builder.test.ts tests/trae-language-model.test.ts
git commit -m "fix: preserve trae prompt history safely"
```

---

### Task 3: Extract CLI Output Parsing and Usage Mapping

**Files:**
- Create: `src/cli/json-output.ts`
- Create: `src/cli/text-content.ts`
- Create: `src/cli/usage.ts`
- Create: `tests/cli-json-output.test.ts`
- Create: `tests/cli-text-content.test.ts`
- Create: `tests/cli-usage.test.ts`
- Modify: `src/trae-language-model.ts`

- [x] **Step 1: Add parser tests**

Create `tests/cli-json-output.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseLastJsonValue } from '../src/cli/json-output.js'

describe('parseLastJsonValue', () => {
  it('parses the last response object from noisy output', () => {
    const parsed = parseLastJsonValue('warn\n{"ignored":true}\n{"message":{"content":"ok"}}\nnoise')
    expect(parsed).toEqual({ message: { content: 'ok' } })
  })

  it('throws a short diagnostic when no json response exists', () => {
    expect(() => parseLastJsonValue('warning only')).toThrow(/Unable to parse traecli JSON output/)
  })
})
```

Create `tests/cli-text-content.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { contentToText } from '../src/cli/text-content.js'

describe('contentToText', () => {
  it('extracts supported text content variants', () => {
    expect(contentToText('ok')).toEqual(['ok'])
    expect(contentToText([{ type: 'text', text: 'a' }, { type: 'output_text', text: 'b' }])).toEqual(['a', 'b'])
  })
})
```

Create `tests/cli-usage.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mapUsage } from '../src/cli/usage.js'

describe('mapUsage', () => {
  it('maps common usage field names', () => {
    expect(mapUsage({ prompt_tokens: 3, completion_tokens: 4 })).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
    })
  })
})
```

- [x] **Step 2: Run parser tests to verify they fail**

Run:

```bash
npm test -- tests/cli-json-output.test.ts tests/cli-text-content.test.ts tests/cli-usage.test.ts
```

Expected: FAIL because the modules do not exist.

- [x] **Step 3: Create `src/cli/json-output.ts`**

Move `parseLastJsonValue` and `findJsonEnd` out of `src/trae-language-model.ts` and export:

```ts
export type TraeCliResult = {
  message?: {
    content?: unknown
    response_meta?: {
      usage?: Record<string, unknown>
    }
  }
  usage?: Record<string, unknown>
}

export function parseLastJsonValue(text: string): TraeCliResult {
  const trimmed = text.trim()
  let fallback: TraeCliResult | undefined
  for (let i = trimmed.length - 1; i >= 0; i -= 1) {
    const ch = trimmed[i]
    if (ch !== '{' && ch !== '[') continue
    const candidate = trimmed.slice(i)
    const end = findJsonEnd(candidate)
    if (end > 0) {
      try {
        const parsed = JSON.parse(candidate.slice(0, end)) as TraeCliResult
        if (parsed && typeof parsed === 'object' && 'message' in parsed) return parsed
        fallback = fallback ?? parsed
      } catch {
        continue
      }
    }
  }
  if (fallback) return fallback
  throw new Error(`Unable to parse traecli JSON output: ${trimmed.slice(0, 240)}`)
}
```

Include the existing `findJsonEnd` helper unchanged.

- [x] **Step 4: Create `src/cli/text-content.ts`**

```ts
export function contentToText(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const chunks: string[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      chunks.push(item)
      continue
    }
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') chunks.push(record.text)
    if (record.type === 'output_text' && typeof record.text === 'string') chunks.push(record.text)
  }
  return chunks
}
```

- [x] **Step 5: Create `src/cli/usage.ts`**

```ts
import type { LanguageModelV2Usage } from '@ai-sdk/provider'

export function mapUsage(usage: Record<string, unknown> | undefined): LanguageModelV2Usage {
  const inputTokens = pickNumber(usage?.input_tokens ?? usage?.inputTokens ?? usage?.prompt_tokens)
  const outputTokens = pickNumber(usage?.output_tokens ?? usage?.outputTokens ?? usage?.completion_tokens)
  const totalTokens = pickNumber(usage?.total_tokens ?? usage?.totalTokens) ??
    (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined)
  return { inputTokens, outputTokens, totalTokens }
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
```

- [x] **Step 6: Update imports in `src/trae-language-model.ts`**

Remove local `TraeCliResult`, `contentToText`, `mapUsage`, `parseLastJsonValue`, `findJsonEnd`, and `pickNumber`. Import:

```ts
import { parseLastJsonValue, type TraeCliResult } from './cli/json-output.js'
import { contentToText } from './cli/text-content.js'
import { mapUsage } from './cli/usage.js'
```

- [x] **Step 7: Verify**

Run:

```bash
npm test -- tests/cli-json-output.test.ts tests/cli-text-content.test.ts tests/cli-usage.test.ts tests/trae-language-model.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/cli src/trae-language-model.ts tests/cli-json-output.test.ts tests/cli-text-content.test.ts tests/cli-usage.test.ts
git commit -m "refactor: extract trae cli parsing helpers"
```

---

### Task 4: Extract Robust CLI Runner

**Files:**
- Create: `src/cli/cli-runner.ts`
- Create: `tests/cli-runner.test.ts`
- Modify: `src/trae-language-model.ts`
- Modify: `tests/trae-language-model.test.ts`

- [x] **Step 1: Add runner tests**

Create `tests/cli-runner.test.ts` with mocked `spawn`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

const spawnMock = vi.fn()
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

function makeChild() {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  child.stdout = stdout as any
  child.stderr = stderr as any
  child.kill = vi.fn() as any
  return { child, stdout, stderr }
}

describe('runCliLlm', () => {
  beforeEach(() => {
    vi.resetModules()
    spawnMock.mockReset()
  })

  it('runs trae cli with print json arguments and parses output', async () => {
    const { child, stdout, stderr } = makeChild()
    spawnMock.mockReturnValue(child)
    const { runCliLlm } = await import('../src/cli/cli-runner.js')
    const promise = runCliLlm({
      cliPath: '/usr/bin/traecli',
      prompt: 'hello',
      modelName: 'GLM-5.1',
      queryTimeout: 33,
    })

    stdout.end('{"message":{"content":"ok"}}')
    stderr.end('')
    child.emit('close', 0)

    await expect(promise).resolves.toMatchObject({ message: { content: 'ok' } })
    expect(spawnMock.mock.calls[0][1]).toEqual([
      'hello',
      '-p',
      '--json',
      '--query-timeout',
      '33s',
      '--config',
      'model.name=GLM-5.1',
    ])
  })

  it('kills the process on abort', async () => {
    const { child } = makeChild()
    spawnMock.mockReturnValue(child)
    const { runCliLlm } = await import('../src/cli/cli-runner.js')
    const controller = new AbortController()
    const promise = runCliLlm({
      cliPath: '/usr/bin/traecli',
      prompt: 'hello',
      abortSignal: controller.signal,
    })

    controller.abort()
    child.emit('close', null)

    await expect(promise).rejects.toThrow(/aborted/)
    expect(child.kill).toHaveBeenCalled()
  })
})
```

- [x] **Step 2: Run runner tests to verify they fail**

Run:

```bash
npm test -- tests/cli-runner.test.ts
```

Expected: FAIL because `src/cli/cli-runner.ts` does not exist.

- [x] **Step 3: Create `src/cli/cli-runner.ts`**

```ts
import { spawn } from 'node:child_process'
import { parseLastJsonValue, type TraeCliResult } from './json-output.js'

export type CliLlmRunOptions = {
  cliPath?: string
  modelName?: string
  prompt: string
  queryTimeout?: number
  extraArgs?: string[]
  abortSignal?: AbortSignal
}

export async function runCliLlm(args: CliLlmRunOptions): Promise<TraeCliResult> {
  if (!args.cliPath) {
    throw new Error('traecli binary not found. Install traecli and ensure it is on PATH.')
  }

  const cliArgs = [
    args.prompt,
    '-p',
    '--json',
    '--query-timeout',
    formatDuration(args.queryTimeout ?? 120),
    ...(args.modelName ? ['--config', `model.name=${args.modelName}`] : []),
    ...(args.extraArgs ?? []),
  ]

  const child = spawn(args.cliPath, cliArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  let aborted = false
  const abort = () => {
    aborted = true
    child.kill()
  }
  args.abortSignal?.addEventListener('abort', abort, { once: true })

  try {
    const stdoutPromise = readStream(child.stdout)
    const stderrPromise = readStream(child.stderr)
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve(code))
    })
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])

    if (aborted) throw new Error('traecli request aborted')
    if (exitCode !== 0 && !stdout.trim()) {
      throw new Error(stderr.trim() || `traecli exited with code ${exitCode}`)
    }
    return parseLastJsonValue(`${stdout}\n${stderr}`)
  } finally {
    args.abortSignal?.removeEventListener('abort', abort)
  }
}
```

Move `formatDuration` and `readStream` from `src/trae-language-model.ts` into this file.

- [x] **Step 4: Update `src/trae-language-model.ts`**

Replace `runTraeCli(...)` with:

```ts
const result = await runCliLlm({
  cliPath,
  modelName: this.providerOptions?.modelName ?? (this.modelId === 'default' ? undefined : this.modelId),
  prompt: buildPromptFromOptions(options),
  queryTimeout: this.providerOptions?.queryTimeout,
  extraArgs: this.providerOptions?.extraArgs,
  abortSignal: options.abortSignal,
})
```

Remove `sessionId` from this call path. Keep the public option type only if backward compatibility is needed, but mark it unused in README.

- [x] **Step 5: Verify**

Run:

```bash
npm test -- tests/cli-runner.test.ts tests/trae-language-model.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/cli-runner.ts src/trae-language-model.ts tests/cli-runner.test.ts tests/trae-language-model.test.ts
git commit -m "refactor: isolate trae cli process runner"
```

---

### Task 5: Stabilize OpenCode Stream Emission

**Files:**
- Modify: `src/trae-language-model.ts`
- Modify: `tests/trae-language-model.test.ts`

- [x] **Step 1: Add stream event sequence tests**

Append to `tests/trae-language-model.test.ts`:

```ts
it('emits a complete OpenCode stream sequence for text output', async () => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  child.stdout = stdout as any
  child.stderr = stderr as any
  child.kill = vi.fn() as any
  spawnMock.mockReturnValue(child)

  const { TraeLanguageModel } = await import('../src/trae-language-model.js')
  const model = new TraeLanguageModel('default', { cliPath: '/usr/bin/traecli' })
  const streamPromise = model.doStream({
    inputFormat: 'prompt',
    mode: { type: 'regular' },
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  } as any)

  setImmediate(() => {
    stdout.end('{"message":{"content":"pong"},"usage":{"input_tokens":1,"output_tokens":1}}')
    stderr.end('')
    child.emit('close', 0)
  })

  const parts: any[] = []
  for await (const part of (await streamPromise).stream as any) parts.push(part)

  expect(parts.map((p) => p.type)).toEqual([
    'stream-start',
    'text-start',
    'text-delta',
    'text-end',
    'finish',
  ])
  expect(parts.at(-1).finishReason).toBe('stop')
})
```

Add an error sequence test:

```ts
it('emits error and finish without throwing from the stream producer', async () => {
  const { TraeLanguageModel } = await import('../src/trae-language-model.js')
  const model = new TraeLanguageModel('default', { cliPath: undefined })
  const parts: any[] = []
  for await (const part of (await model.doStream({
    inputFormat: 'prompt',
    mode: { type: 'regular' },
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  } as any)).stream as any) parts.push(part)

  expect(parts.map((p) => p.type)).toEqual(['stream-start', 'error', 'finish'])
  expect(parts.at(-1).finishReason).toBe('error')
})
```

- [x] **Step 2: Run tests**

Run:

```bash
npm test -- tests/trae-language-model.test.ts
```

Expected: PASS or fail with precise sequence differences.

- [x] **Step 3: Tighten `emitResult`**

Ensure `text-start` and `text-end` are emitted only when text exists. Ensure `finish` always appears once. If no text exists, emit only:

```text
stream-start
finish
```

Do not emit empty `text-delta` parts.

- [x] **Step 4: Verify full suite**

Run:

```bash
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trae-language-model.ts tests/trae-language-model.test.ts
git commit -m "fix: stabilize trae opencode stream events"
```

---

### Task 6: Update Documentation and Smoke Checklist

**Files:**
- Modify: `README.md`
- Modify: `package.json` if script additions are useful

- [x] **Step 1: Update README capability language**

Replace the known limitations line about tools with:

```md
- This provider is text-only by design. It does not support OpenCode tool/function calling and does not use Trae CLI as an agent runtime.
```

Add a short section:

```md
## Capability Boundary

This package uses Trae CLI only as a text-in/text-out LLM backend. OpenCode tools, shell commands, file reads, MCP calls, and permission prompts are not delegated to Trae CLI.

Model metadata intentionally advertises `tool_call: false` and `attachment: false`.
```

- [x] **Step 2: Add smoke commands**

Document:

```bash
npm test
npm run build
traecli "reply with ok" -p --json
opencode run --model trae/default "reply with ok"
```

- [x] **Step 3: Verify docs and package**

Run:

```bash
npm test
npm run build
npm pack --dry-run
```

Expected: PASS. The dry-run package includes `dist/`, `README.md`, and `LICENSE`.

- [ ] **Step 4: Commit**

```bash
git add README.md package.json package-lock.json
git commit -m "docs: clarify trae text-only bridge boundary"
```

---

## Self-Review

Spec coverage:

- Text-only capability is implemented in Task 1 and documented in Task 6.
- Multi-turn prompt serialization is implemented in Task 2.
- CLI parsing, usage mapping, and noisy output handling are implemented in Task 3.
- Abort and process runner boundaries are implemented in Task 4.
- OpenCode stream stability is implemented in Task 5.
- No function calling, no prompt-based tool parsing, and no Trae CLI agent runtime are preserved across Tasks 1, 4, and 6.

Placeholder scan:

- No task depends on undefined modules without creating them in the same task.
- No task asks for generic tests without concrete examples.
- No task includes deferred behavior.

Type consistency:

- `TraeCliResult` is defined once in `src/cli/json-output.ts`.
- `runCliLlm()` is the only child-process runner used by `TraeLanguageModel`.
- `mapUsage()` returns `LanguageModelV2Usage`.
- Model metadata continues to use existing `TraeModelDefinition` fields.
