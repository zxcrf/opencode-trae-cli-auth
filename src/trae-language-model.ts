import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
  ProviderV2,
} from '@ai-sdk/provider'
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPromptFromOptions } from './prompt-builder.js'

export type TraeProviderOptions = {
  cliPath?: string
  modelName?: string
  queryTimeout?: number
  extraArgs?: string[]
  sessionId?: string
}

type TraeCliResult = {
  message?: {
    content?: unknown
    response_meta?: {
      usage?: Record<string, unknown>
    }
  }
  usage?: Record<string, unknown>
}

function decorateFinishReason(reason: LanguageModelV2FinishReason): LanguageModelV2FinishReason {
  if (process.env.OPENCODE !== '1') return reason
  const wrapped = new String(reason) as String & {
    unified?: LanguageModelV2FinishReason
    raw?: string | undefined
  }
  wrapped.unified = reason
  wrapped.raw = undefined
  return wrapped as unknown as LanguageModelV2FinishReason
}

export function resolveTraeCliPath(): string | undefined {
  const candidates = [
    process.env.TRAECLI_PATH,
    ...(process.env.PATH ?? '').split(path.delimiter).flatMap((dir) => [
      path.join(dir, 'traecli'),
      path.join(dir, 'trae-cli'),
      path.join(dir, 'trae'),
    ]),
    '/Users/qqz/.local/bin/traecli',
    path.join(os.homedir(), '.local', 'bin', 'traecli'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)

  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function createTraeProvider(options?: TraeProviderOptions): ProviderV2 {
  return {
    languageModel: (modelId: string) => new TraeLanguageModel(modelId, options),
    textEmbeddingModel: () => {
      throw new Error('Trae provider does not support text embeddings')
    },
    imageModel: () => {
      throw new Error('Trae provider does not support image models')
    },
  }
}

export class TraeLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const
  readonly provider = 'trae'
  readonly supportedUrls: Record<string, RegExp[]> = {}

  constructor(public readonly modelId: string, private readonly providerOptions?: TraeProviderOptions) {}

  async doGenerate(options: LanguageModelV2CallOptions) {
    const { stream } = await this.doStream(options)
    const reader = stream.getReader()
    let text = ''
    let finishReason: LanguageModelV2FinishReason = 'stop'
    let usage: LanguageModelV2Usage | undefined

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value.type === 'text-delta') text += value.delta
      if (value.type === 'finish') {
        finishReason = String(value.finishReason) as LanguageModelV2FinishReason
        usage = value.usage
      }
      if (value.type === 'error') throw value.error instanceof Error ? value.error : new Error(String(value.error))
    }

    const content: LanguageModelV2Content[] = text ? [{ type: 'text', text }] : []
    return {
      content,
      finishReason,
      usage: usage ?? { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
      warnings: [],
    }
  }

  async doStream(options: LanguageModelV2CallOptions): Promise<{ stream: ReadableStream<LanguageModelV2StreamPart> }> {
    const cliPath = this.providerOptions?.cliPath ?? resolveTraeCliPath()
    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start: async (controller) => {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        try {
          const result = await runTraeCli({
            cliPath,
            modelName: this.providerOptions?.modelName ?? (this.modelId === 'default' ? undefined : this.modelId),
            prompt: buildPromptFromOptions(options),
            queryTimeout: this.providerOptions?.queryTimeout,
            extraArgs: this.providerOptions?.extraArgs,
            sessionId: this.providerOptions?.sessionId,
          })
          emitResult(controller, result)
        } catch (error) {
          controller.enqueue({ type: 'error', error: error instanceof Error ? error : new Error(String(error)) })
          controller.enqueue({
            type: 'finish',
            finishReason: decorateFinishReason('error'),
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          })
        } finally {
          controller.close()
        }
      },
    })

    return { stream }
  }
}

function emitResult(controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>, result: TraeCliResult): void {
  const parts = contentToText(result.message?.content)
  if (parts.length > 0) controller.enqueue({ type: 'text-start', id: 'trae-0' })
  for (const part of parts) {
    controller.enqueue({ type: 'text-delta', id: 'trae-0', delta: part })
  }
  if (parts.length > 0) controller.enqueue({ type: 'text-end', id: 'trae-0' })
  controller.enqueue({
    type: 'finish',
    finishReason: decorateFinishReason('stop'),
    usage: mapUsage(result.usage ?? result.message?.response_meta?.usage),
  })
}

function contentToText(content: unknown): string[] {
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

function mapUsage(usage: Record<string, unknown> | undefined): LanguageModelV2Usage {
  const inputTokens = pickNumber(usage?.input_tokens ?? usage?.inputTokens ?? usage?.prompt_tokens)
  const outputTokens = pickNumber(usage?.output_tokens ?? usage?.outputTokens ?? usage?.completion_tokens)
  const totalTokens = pickNumber(usage?.total_tokens ?? usage?.totalTokens) ??
    (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined)
  return { inputTokens, outputTokens, totalTokens }
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseLastJsonValue(text: string): TraeCliResult {
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
  throw new Error('Unable to parse traecli JSON output')
}

function findJsonEnd(text: string): number {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch)
      continue
    }
    if (ch === '}' || ch === ']') {
      const open = stack.pop()
      if (!open) return -1
      if ((open === '{' && ch !== '}') || (open === '[' && ch !== ']')) return -1
      if (stack.length === 0) return i + 1
    }
  }
  return -1
}

async function runTraeCli(args: {
  cliPath?: string
  modelName?: string
  prompt: string
  queryTimeout?: number
  extraArgs?: string[]
  sessionId?: string
}): Promise<TraeCliResult> {
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
    ...(args.sessionId ? ['--session-id', args.sessionId] : []),
    ...(args.extraArgs ?? []),
  ]

  const child = spawn(args.cliPath, cliArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  const stdoutPromise = readStream(child.stdout)
  const stderrPromise = readStream(child.stderr)
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])

  if (exitCode !== 0 && !stdout.trim()) {
    throw new Error(stderr.trim() || `traecli exited with code ${exitCode}`)
  }

  return parseLastJsonValue(`${stdout}\n${stderr}`)
}

function formatDuration(seconds: number): string {
  return `${Math.max(1, Math.floor(seconds))}s`
}

function readStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stream) return resolve('')
    const chunks: string[] = []
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => chunks.push(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(chunks.join('')))
  })
}
