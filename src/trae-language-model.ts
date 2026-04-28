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
  const normalized = normalizeToolInputObject(normalizedToolName, parsed)
  if ((normalizedToolName === 'read' || normalizedToolName === 'read_file') && typeof normalized.filePath !== 'string') {
    const pathValue = normalized.path ?? normalized.filepath ?? normalized.file_path
    if (typeof pathValue === 'string' && pathValue.trim()) normalized.filePath = pathValue
  }
  return JSON.stringify(normalized)
}

function normalizeToolInputObject(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
    case 'read':
    case 'read_file':
    case 'write':
      return renameKeys(input, { file_path: 'filePath' })
    case 'edit':
    case 'str_replace_based_edit_tool':
      return renameKeys(input, {
        file_path: 'filePath',
        old_string: 'oldString',
        new_string: 'newString',
        replace_all: 'replaceAll',
      })
    case 'grep': {
      const next = renameKeys(input, {})
      if (!pickString(next.include)) {
        next.include = pickString(next.glob) ?? inferIncludeFromType(next.type)
      }
      delete next.glob
      delete next.type
      delete next.output_mode
      delete next.multiline
      return next
    }
    case 'question': {
      const next = renameKeys(input, {})
      if (Array.isArray(next.questions)) {
        next.questions = next.questions.map((question) => {
          if (!question || typeof question !== 'object' || Array.isArray(question)) return question
          const mapped = renameKeys(question as Record<string, unknown>, { multiSelect: 'multiple' })
          delete mapped.answers
          return mapped
        })
      }
      delete next.answers
      return next
    }
    case 'task': {
      const next = renameKeys(input, {})
      const subagentType = pickString(next.subagent_type)
      if (subagentType) next.subagent_type = mapSubagentType(subagentType)
      return next
    }
    default:
      return input
  }
}

function renameKeys(
  input: Record<string, unknown>,
  keyMap: Record<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [keyMap[key] ?? key, value]),
  )
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function inferIncludeFromType(type: unknown): string | undefined {
  const ext = pickString(type)
  return ext ? `*.${ext}` : undefined
}

function mapSubagentType(value: string): string {
  const lower = value.toLowerCase()
  if (lower === 'explore') return 'explorer'
  if (lower === 'execute') return 'worker'
  return lower
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
  const lower = name.toLowerCase()
  if (lower === 'askuserquestion') return 'question'
  if (lower === 'agent') return 'task'
  if (lower === 'exitplanmode') return 'plan_exit'
  if (lower === 'str_replace_based_edit_tool') return 'edit'
  if (lower.startsWith('mcp__')) {
    const withoutPrefix = lower.slice(5)
    const separatorIdx = withoutPrefix.indexOf('__')
    if (separatorIdx > 0) {
      const serverName = withoutPrefix.slice(0, separatorIdx)
      const toolName = withoutPrefix.slice(separatorIdx + 2)
      return `${serverName}_${toolName}`
    }
    return withoutPrefix
  }
  return lower
}
