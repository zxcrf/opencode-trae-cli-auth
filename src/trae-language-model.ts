import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
  ProviderV2,
} from '@ai-sdk/provider'
import { accessSync, constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPromptFromOptions } from './prompt-builder.js'
import { extractFunctionToolCalls, type TraeCliResult } from './cli/json-output.js'
import { contentToText } from './cli/text-content.js'
import { mapUsage } from './cli/usage.js'
import { runCliLlm } from './cli/cli-runner.js'
import { TRAE_MODEL_PROFILES } from './models.js'

export type TraeProviderOptions = {
  cliPath?: string
  modelName?: string
  modelAliases?: Record<string, string>
  enableToolCalling?: boolean
  queryTimeout?: number
  includeToolHistory?: boolean
  maxPromptMessages?: number
  maxPromptChars?: number
  extraArgs?: string[]
  enforceTextOnly?: boolean
  maxRetries?: number
  retryDelayMs?: number
  sessionId?: string
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
          const selectedModel = resolveTraeModelName(this.modelId, this.providerOptions)
          const result = await runCliLlm({
            cliPath,
            modelName: selectedModel,
            prompt: buildPromptFromOptions(options, {
              includeToolHistory: this.providerOptions?.includeToolHistory ?? this.providerOptions?.enableToolCalling === true,
              maxMessages: this.providerOptions?.maxPromptMessages ?? 40,
              maxChars: this.providerOptions?.maxPromptChars ?? 12000,
            }),
            queryTimeout: this.providerOptions?.queryTimeout,
            extraArgs: this.providerOptions?.extraArgs,
            enforceTextOnly: resolveEnforceTextOnly(this.providerOptions),
            maxRetries: this.providerOptions?.maxRetries,
            retryDelayMs: this.providerOptions?.retryDelayMs,
            abortSignal: options.abortSignal,
          })
          emitResult(controller, result, this.providerOptions?.enableToolCalling === true)
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

function resolveTraeModelName(modelId: string, options?: TraeProviderOptions): string | undefined {
  if (options?.modelName) return options.modelName
  if (modelId === 'default') return undefined
  const aliases = {
    ...TRAE_MODEL_PROFILES,
    ...(options?.modelAliases ?? {}),
  }
  return aliases[modelId] ?? modelId
}

function emitResult(
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>,
  result: TraeCliResult,
  enableToolCalling: boolean,
): void {
  const parts = contentToText(result.message?.content)
  const toolCalls = enableToolCalling ? extractFunctionToolCalls(result) : []
  if (parts.length > 0) controller.enqueue({ type: 'text-start', id: 'trae-0' })
  for (const part of parts) {
    controller.enqueue({ type: 'text-delta', id: 'trae-0', delta: part })
  }
  if (parts.length > 0) controller.enqueue({ type: 'text-end', id: 'trae-0' })
  for (const call of toolCalls) {
    const toolName = normalizeToolName(call.name)
    const normalizedInput = normalizeToolInput(toolName, call.input)
    controller.enqueue({ type: 'tool-input-start', id: call.id, toolName } as LanguageModelV2StreamPart)
    controller.enqueue({ type: 'tool-input-delta', id: call.id, delta: normalizedInput } as LanguageModelV2StreamPart)
    controller.enqueue({ type: 'tool-input-end', id: call.id } as LanguageModelV2StreamPart)
    controller.enqueue({
      type: 'tool-call',
      toolCallId: call.id,
      toolName,
      input: normalizedInput,
    } as LanguageModelV2StreamPart)
  }
  controller.enqueue({
    type: 'finish',
    finishReason: decorateFinishReason(toolCalls.length > 0 ? 'tool-calls' : 'stop'),
    usage: mapUsage(result.usage ?? result.message?.response_meta?.usage),
  })
}

function resolveEnforceTextOnly(options?: TraeProviderOptions): boolean | undefined {
  if (typeof options?.enforceTextOnly === 'boolean') return options.enforceTextOnly
  if (options?.enableToolCalling === true) return false
  return undefined
}

function normalizeToolInput(toolName: string, input: string): string {
  const parsed = parseInputObject(input)
  if (!parsed) return input
  const normalizedToolName = toolName.toLowerCase()
  if (normalizedToolName === 'read' || normalizedToolName === 'read_file') {
    if (typeof parsed.filePath !== 'string') {
      const pathValue = parsed.path ?? parsed.filepath ?? parsed.file_path
      if (typeof pathValue === 'string' && pathValue.trim()) parsed.filePath = pathValue
    }
  }
  return JSON.stringify(parsed)
}

function parseInputObject(input: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(input)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    return { ...(value as Record<string, unknown>) }
  } catch {
    return undefined
  }
}

function normalizeToolName(name: string): string {
  const lowered = name.toLowerCase()
  if (lowered === 'askuserquestion') return 'question'
  return lowered
}
