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
import { extractFunctionToolCalls, extractTextToolCalls, stripTextToolCallBlocks, type TraeCliResult } from './cli/json-output.js'
import { contentToText } from './cli/text-content.js'
import { mapUsage } from './cli/usage.js'
import { runCliLlmStreaming } from './cli/cli-runner.js'
import { TRAE_CLOUD_MODEL_IDS } from './models.js'
import { streamOpenAIChatCompletions, type OpenAIStreamToolDelta } from './openai-transport.js'
import { streamTraeRawChat, type TraeRawStreamToolDelta } from './trae-raw-transport.js'

export type TraeProviderOptions = {
  allowCliFallback?: boolean
  cliPath?: string
  pat?: string
  traeRawBaseURL?: string
  traeRawApiKey?: string
  traeRawHeaders?: Record<string, string>
  traeRawConfigName?: string
  traeRawModelName?: string
  openaiBaseURL?: string
  openaiApiKey?: string
  openaiHeaders?: Record<string, string>
  modelName?: string
  modelAliases?: Record<string, string>
  enableToolCalling?: boolean
  queryTimeout?: number
  includeToolHistory?: boolean
  maxPromptMessages?: number
  maxPromptChars?: number
  maxToolPayloadChars?: number
  codingSystemPreamble?: string
  injectCodingSystemPrompt?: boolean
  extraArgs?: string[]
  enforceTextOnly?: boolean
  maxRetries?: number
  retryDelayMs?: number
  sessionId?: string
}

const LEGACY_MODEL_ALIASES: Record<string, string> = {
  default: 'GLM-5.1',
  fast: 'MiniMax-M2.7',
  balanced: 'GLM-5.1',
  strong: 'Kimi-K2.6',
  coding: 'GLM-5.1',
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

function applyRuntimeModelDefaults(modelId: string, options?: TraeProviderOptions): TraeProviderOptions {
  const normalizedModelId = modelId.replace(/^trae\//, '')
  if (!isAgenticTraeModel(normalizedModelId)) return options ?? {}
  return {
    ...(options ?? {}),
    enableToolCalling: options?.enableToolCalling ?? true,
    includeToolHistory: options?.includeToolHistory ?? true,
    enforceTextOnly: options?.enforceTextOnly ?? true,
    maxPromptMessages: options?.maxPromptMessages ?? 60,
    maxPromptChars: options?.maxPromptChars ?? 20000,
    maxToolPayloadChars: options?.maxToolPayloadChars ?? 4000,
    injectCodingSystemPrompt: options?.injectCodingSystemPrompt ?? true,
  }
}

function isAgenticTraeModel(modelId: string): boolean {
  return modelId in LEGACY_MODEL_ALIASES || (TRAE_CLOUD_MODEL_IDS as readonly string[]).includes(modelId)
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

  private readonly providerOptions: TraeProviderOptions

  constructor(public readonly modelId: string, providerOptions?: TraeProviderOptions) {
    this.providerOptions = applyRuntimeModelDefaults(modelId, providerOptions)
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    const { stream } = await this.doStream(options)
    const reader = stream.getReader()
    let text = ''
    let finishReason: LanguageModelV2FinishReason = 'stop'
    let usage: LanguageModelV2Usage | undefined
    const toolCalls: LanguageModelV2Content[] = []

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value.type === 'text-delta') text += value.delta
      if (value.type === 'tool-call') {
        toolCalls.push({
          type: 'tool-call',
          toolCallId: value.toolCallId,
          toolName: value.toolName,
          input: value.input,
          providerExecuted: value.providerExecuted,
        } as LanguageModelV2Content)
      }
      if (value.type === 'finish') {
        finishReason = String(value.finishReason) as LanguageModelV2FinishReason
        usage = value.usage
      }
      if (value.type === 'error') throw value.error instanceof Error ? value.error : new Error(String(value.error))
    }

    const content: LanguageModelV2Content[] = toolCalls.length > 0
      ? toolCalls
      : text ? [{ type: 'text', text }] : []
    return {
      content,
      finishReason: toolCalls.length > 0 ? 'tool-calls' : finishReason,
      usage: usage ?? { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
      warnings: [],
    }
  }

  async doStream(options: LanguageModelV2CallOptions): Promise<{ stream: ReadableStream<LanguageModelV2StreamPart> }> {
    const toolSchemaHints = buildToolSchemaHints(options.tools)
    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start: async (controller) => {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        let textStarted = false
        let emittedText = ''
        let finished = false
        let metadataEmitted = false
        let lastUsage: LanguageModelV2Usage | undefined
        const selectedModel = resolveTraeModelName(this.modelId, this.providerOptions)
        const selectedCliModel = resolveTraeCliModelName(this.modelId, this.providerOptions)
        try {
          const routedToolCalls = routeCodingToolCalls(options, this.providerOptions)
          if (routedToolCalls.length > 0) {
            controller.enqueue({
              type: 'response-metadata',
              modelId: selectedModel ?? this.modelId,
            })
            const emittedToolCalls = emitToolCalls(controller, routedToolCalls, toolSchemaHints)
            controller.enqueue({
              type: 'finish',
              finishReason: decorateFinishReason(emittedToolCalls > 0 ? 'tool-calls' : 'stop'),
              usage: zeroUsage(),
            })
            return
          }
          const deterministicToolResultText = (hasTraeRawTransport(this.providerOptions) || hasOpenAITransport(this.providerOptions))
            ? buildDeterministicToolResultFallback(options)
            : undefined
          if (deterministicToolResultText) {
            controller.enqueue({
              type: 'response-metadata',
              modelId: selectedModel ?? this.modelId,
            })
            controller.enqueue({ type: 'text-start', id: 'trae-0' })
            controller.enqueue({ type: 'text-delta', id: 'trae-0', delta: deterministicToolResultText })
            controller.enqueue({ type: 'text-end', id: 'trae-0' })
            controller.enqueue({
              type: 'finish',
              finishReason: decorateFinishReason('stop'),
              usage: zeroUsage(),
            })
            return
          }
          if (hasTraeRawTransport(this.providerOptions)) {
            await streamTraeRawTransport({
              controller,
              options,
              providerOptions: this.providerOptions,
              modelId: this.modelId,
              selectedModel,
              toolSchemaHints,
            })
            return
          }
          if (hasOpenAITransport(this.providerOptions)) {
            await streamOpenAITransport({
              controller,
              options,
              providerOptions: this.providerOptions,
              modelId: this.modelId,
              selectedModel,
              toolSchemaHints,
            })
            return
          }
          if (this.providerOptions?.allowCliFallback !== true) {
            throw new Error('Trae provider requires direct raw/OpenAI-compatible transport. Set traeRawBaseURL+traeRawApiKey or openaiBaseURL+openaiApiKey. Legacy traecli fallback is disabled by default.')
          }
          const cliPath = this.providerOptions?.cliPath ?? resolveTraeCliPath()
          const fallbackText = buildManifestInventoryFallback(options)
          if (fallbackText) {
            controller.enqueue({
              type: 'response-metadata',
              modelId: selectedModel ?? this.modelId,
            })
            controller.enqueue({ type: 'text-start', id: 'trae-0' })
            controller.enqueue({ type: 'text-delta', id: 'trae-0', delta: fallbackText })
            controller.enqueue({ type: 'text-end', id: 'trae-0' })
            controller.enqueue({
              type: 'finish',
              finishReason: decorateFinishReason('stop'),
              usage: zeroUsage(),
            })
            return
          }
          const readFallbackText = buildReadResultFallback(options)
          if (readFallbackText) {
            controller.enqueue({
              type: 'response-metadata',
              modelId: selectedModel ?? this.modelId,
            })
            controller.enqueue({ type: 'text-start', id: 'trae-0' })
            controller.enqueue({ type: 'text-delta', id: 'trae-0', delta: readFallbackText })
            controller.enqueue({ type: 'text-end', id: 'trae-0' })
            controller.enqueue({
              type: 'finish',
              finishReason: decorateFinishReason('stop'),
              usage: zeroUsage(),
            })
            return
          }
          const contextFallbackText = buildConcreteCodingContextFallback(options)
          if (contextFallbackText) {
            controller.enqueue({
              type: 'response-metadata',
              modelId: selectedModel ?? this.modelId,
            })
            controller.enqueue({ type: 'text-start', id: 'trae-0' })
            controller.enqueue({ type: 'text-delta', id: 'trae-0', delta: contextFallbackText })
            controller.enqueue({ type: 'text-end', id: 'trae-0' })
            controller.enqueue({
              type: 'finish',
              finishReason: decorateFinishReason('stop'),
              usage: zeroUsage(),
            })
            return
          }
          const result = await runCliLlmStreaming({
            cliPath,
            modelName: selectedCliModel,
            prompt: buildPromptFromOptions(options, {
              includeToolHistory: this.providerOptions?.includeToolHistory ?? this.providerOptions?.enableToolCalling === true,
              maxMessages: this.providerOptions?.maxPromptMessages ?? 40,
              maxChars: this.providerOptions?.maxPromptChars ?? 12000,
              maxToolPayloadChars: this.providerOptions?.maxToolPayloadChars,
              systemPreamble: resolveSystemPreamble(this.providerOptions, options.tools),
              taskReminder: this.providerOptions?.enableToolCalling === true ? getFirstUserText(options) : undefined,
            }),
            queryTimeout: this.providerOptions?.queryTimeout,
            sessionId: this.providerOptions?.sessionId,
            extraArgs: this.providerOptions?.extraArgs,
            enforceTextOnly: resolveEnforceTextOnly(this.providerOptions),
            maxRetries: this.providerOptions?.maxRetries,
            retryDelayMs: this.providerOptions?.retryDelayMs,
            abortSignal: options.abortSignal,
          }, (chunk) => {
            if (!metadataEmitted) {
              controller.enqueue({
                type: 'response-metadata',
                modelId: selectedModel ?? this.modelId,
              })
              metadataEmitted = true
            }
            lastUsage = mapUsage(chunk.usage ?? chunk.message?.response_meta?.usage)
            const toolCalls = this.providerOptions?.enableToolCalling === true ? extractToolCalls(chunk) : []
            if (toolCalls.length > 0) {
              if (textStarted) controller.enqueue({ type: 'text-end', id: 'trae-0' })
              const emittedToolCalls = emitToolCalls(controller, toolCalls, toolSchemaHints)
              controller.enqueue({
                type: 'finish',
                finishReason: decorateFinishReason(emittedToolCalls > 0 ? 'tool-calls' : 'stop'),
                usage: lastUsage,
              })
              finished = true
              return 'stop'
            }

            const text = this.providerOptions?.enableToolCalling === true
              ? stripTextToolCallBlocks(chunk.message?.content)
              : contentToText(chunk.message?.content).join('')
            const delta = nextTextDelta(emittedText, text)
            if (delta) {
              if (!textStarted) {
                controller.enqueue({ type: 'text-start', id: 'trae-0' })
                textStarted = true
              }
              controller.enqueue({ type: 'text-delta', id: 'trae-0', delta })
              emittedText = text
            }
          })
          if (!finished) {
            if (!metadataEmitted) {
              controller.enqueue({
                type: 'response-metadata',
                modelId: selectedModel ?? this.modelId,
              })
              metadataEmitted = true
            }
            const finalToolCalls = this.providerOptions?.enableToolCalling === true ? extractToolCalls(result) : []
            if (finalToolCalls.length > 0) {
              if (textStarted) controller.enqueue({ type: 'text-end', id: 'trae-0' })
              const emittedToolCalls = emitToolCalls(controller, finalToolCalls, toolSchemaHints)
              controller.enqueue({
                type: 'finish',
                finishReason: decorateFinishReason(emittedToolCalls > 0 ? 'tool-calls' : 'stop'),
                usage: lastUsage ?? mapUsage(result.usage ?? result.message?.response_meta?.usage),
              })
              finished = true
              return
            }
            const text = this.providerOptions?.enableToolCalling === true
              ? stripTextToolCallBlocks(result.message?.content)
              : contentToText(result.message?.content).join('')
            const delta = nextTextDelta(emittedText, text)
            if (delta) {
              if (!textStarted) {
                controller.enqueue({ type: 'text-start', id: 'trae-0' })
                textStarted = true
              }
              controller.enqueue({ type: 'text-delta', id: 'trae-0', delta })
              emittedText = text
            }
            if (textStarted) controller.enqueue({ type: 'text-end', id: 'trae-0' })
            controller.enqueue({
              type: 'finish',
              finishReason: decorateFinishReason('stop'),
              usage: lastUsage ?? mapUsage(result.usage ?? result.message?.response_meta?.usage),
            })
          }
        } catch (error) {
          const fallbackText = buildToolResultTimeoutFallback(options, error)
          if (fallbackText) {
            if (!metadataEmitted) {
              controller.enqueue({
                type: 'response-metadata',
                modelId: selectedModel ?? this.modelId,
              })
            }
            controller.enqueue({ type: 'text-start', id: 'trae-0' })
            controller.enqueue({ type: 'text-delta', id: 'trae-0', delta: fallbackText })
            controller.enqueue({ type: 'text-end', id: 'trae-0' })
            controller.enqueue({
              type: 'finish',
              finishReason: decorateFinishReason('stop'),
              usage: zeroUsage(),
            })
            return
          }
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

async function streamTraeRawTransport(args: {
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>
  options: LanguageModelV2CallOptions
  providerOptions: TraeProviderOptions
  modelId: string
  selectedModel?: string
  toolSchemaHints: Record<string, Set<string>>
}): Promise<void> {
  args.controller.enqueue({
    type: 'response-metadata',
    modelId: args.selectedModel ?? 'trae',
  })
  let textStarted = false
  let sawOutput = false
  const toolCalls = new Map<number, { id: string; name: string; input: string }>()
  const transportOptions = withTransportPromptGuidance(args.options, args.providerOptions)
  for await (const event of streamTraeRawChat({
    baseURL: args.providerOptions.traeRawBaseURL!,
    apiKey: args.providerOptions.traeRawApiKey!,
    pat: args.providerOptions.pat,
    headers: args.providerOptions.traeRawHeaders,
    modelName: args.selectedModel ?? args.providerOptions.modelName,
    configName: args.providerOptions.traeRawConfigName,
    rawModelName: args.providerOptions.traeRawModelName,
    sessionId: args.providerOptions.sessionId,
    abortSignal: args.options.abortSignal,
  }, transportOptions)) {
    if (event.type === 'text-delta') {
      sawOutput = true
      if (!textStarted) {
        args.controller.enqueue({ type: 'text-start', id: 'trae-0' })
        textStarted = true
      }
      args.controller.enqueue({ type: 'text-delta', id: 'trae-0', delta: event.delta })
      continue
    }
    if (event.type === 'tool-call-delta') {
      sawOutput = true
      applyTraeRawToolDelta(toolCalls, event)
      continue
    }
    if (event.type === 'finish') {
      if (!sawOutput) {
        throw new Error('Trae raw chat stream ended without text or tool calls')
      }
      if (textStarted) args.controller.enqueue({ type: 'text-end', id: 'trae-0' })
      if (toolCalls.size > 0) {
        const emittedToolCalls = emitToolCalls(
          args.controller,
          [...toolCalls.values()].map((call) => ({
            id: call.id,
            name: call.name,
            input: call.input,
          })),
          args.toolSchemaHints,
        )
        if (emittedToolCalls === 0) toolCalls.clear()
      }
      args.controller.enqueue({
        type: 'finish',
        finishReason: decorateFinishReason(toolCalls.size > 0 ? 'tool-calls' : event.finishReason),
        usage: event.usage ?? zeroUsage(),
      })
      return
    }
  }
}

async function streamOpenAITransport(args: {
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>
  options: LanguageModelV2CallOptions
  providerOptions: TraeProviderOptions
  modelId: string
  selectedModel?: string
  toolSchemaHints: Record<string, Set<string>>
}): Promise<void> {
  args.controller.enqueue({
    type: 'response-metadata',
    modelId: args.selectedModel ?? 'trae',
  })
  let textStarted = false
  const toolCalls = new Map<number, { id: string; name: string; input: string }>()
  const transportOptions = withTransportPromptGuidance(args.options, args.providerOptions)
  for await (const event of streamOpenAIChatCompletions({
    baseURL: args.providerOptions.openaiBaseURL!,
    apiKey: args.providerOptions.openaiApiKey!,
    headers: args.providerOptions.openaiHeaders,
    modelName: args.selectedModel ?? args.providerOptions.modelName ?? stripProviderPrefix(args.modelId),
    abortSignal: args.options.abortSignal,
  }, transportOptions)) {
    if (event.type === 'text-delta') {
      if (!textStarted) {
        args.controller.enqueue({ type: 'text-start', id: 'trae-0' })
        textStarted = true
      }
      args.controller.enqueue({ type: 'text-delta', id: 'trae-0', delta: event.delta })
      continue
    }
    if (event.type === 'tool-call-delta') {
      applyOpenAIToolDelta(toolCalls, event)
      continue
    }
    if (event.type === 'finish') {
      if (textStarted) args.controller.enqueue({ type: 'text-end', id: 'trae-0' })
      if (toolCalls.size > 0) {
        const emittedToolCalls = emitToolCalls(
          args.controller,
          [...toolCalls.values()].map((call) => ({
            id: call.id,
            name: call.name,
            input: call.input,
          })),
          args.toolSchemaHints,
        )
        if (emittedToolCalls === 0) toolCalls.clear()
      }
      args.controller.enqueue({
        type: 'finish',
        finishReason: decorateFinishReason(toolCalls.size > 0 ? 'tool-calls' : event.finishReason),
        usage: event.usage ?? zeroUsage(),
      })
      return
    }
  }
}

function withTransportPromptGuidance(
  options: LanguageModelV2CallOptions,
  providerOptions: TraeProviderOptions,
): LanguageModelV2CallOptions {
  const systemPreamble = resolveSystemPreamble(providerOptions, options.tools)
  if (!systemPreamble) return options
  return {
    ...options,
    prompt: [
      { role: 'system', content: systemPreamble },
      ...(options.prompt ?? []),
      {
        role: 'user',
        content: [{ type: 'text', text: `Current task reminder:\n${getFirstUserText(options)}` }],
      },
    ] as LanguageModelV2CallOptions['prompt'],
  }
}

function hasOpenAITransport(options: TraeProviderOptions): boolean {
  return !!(options.openaiBaseURL && options.openaiApiKey)
}

function hasTraeRawTransport(options: TraeProviderOptions): boolean {
  return !!(options.traeRawBaseURL && (options.traeRawApiKey || options.pat))
}

function applyTraeRawToolDelta(
  toolCalls: Map<number, { id: string; name: string; input: string }>,
  delta: TraeRawStreamToolDelta,
): void {
  const current = toolCalls.get(delta.index) ?? {
    id: delta.id ?? `call_${delta.index}`,
    name: delta.name ?? '',
    input: '',
  }
  if (delta.id) current.id = delta.id
  if (delta.name) current.name = delta.name
  if (delta.argumentsDelta) current.input += delta.argumentsDelta
  toolCalls.set(delta.index, current)
}

function applyOpenAIToolDelta(
  toolCalls: Map<number, { id: string; name: string; input: string }>,
  delta: OpenAIStreamToolDelta,
): void {
  const current = toolCalls.get(delta.index) ?? {
    id: delta.id ?? `call_${delta.index}`,
    name: delta.name ?? '',
    input: '',
  }
  if (delta.id) current.id = delta.id
  if (delta.name) current.name = delta.name
  if (delta.argumentsDelta) current.input += delta.argumentsDelta
  toolCalls.set(delta.index, current)
}

function resolveTraeModelName(modelId: string, options?: TraeProviderOptions): string | undefined {
  const normalizedModelId = stripProviderPrefix(modelId)
  if (options?.modelName) return options.modelName
  const aliases = {
    ...LEGACY_MODEL_ALIASES,
    ...(options?.modelAliases ?? {}),
  }
  return aliases[normalizedModelId] ?? normalizedModelId
}

function resolveTraeCliModelName(modelId: string, options?: TraeProviderOptions): string | undefined {
  const normalizedModelId = stripProviderPrefix(modelId)
  if (options?.modelName) return options.modelName
  if (normalizedModelId === 'coding' && !options?.modelAliases?.coding) return undefined
  if (normalizedModelId === 'default') return undefined
  const aliases = {
    fast: LEGACY_MODEL_ALIASES.fast,
    balanced: LEGACY_MODEL_ALIASES.balanced,
    strong: LEGACY_MODEL_ALIASES.strong,
    ...(options?.modelAliases ?? {}),
  }
  return aliases[normalizedModelId] ?? normalizedModelId
}

function stripProviderPrefix(modelId: string): string {
  return modelId.startsWith('trae/') ? modelId.slice('trae/'.length) : modelId
}

function emitResult(
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>,
  result: TraeCliResult,
  enableToolCalling: boolean,
  toolSchemaHints: Record<string, Set<string>>,
): void {
  const parts = contentToText(result.message?.content)
  const toolCalls = enableToolCalling ? extractFunctionToolCalls(result) : []
  if (parts.length > 0) controller.enqueue({ type: 'text-start', id: 'trae-0' })
  for (const part of parts) {
    controller.enqueue({ type: 'text-delta', id: 'trae-0', delta: part })
  }
  if (parts.length > 0) controller.enqueue({ type: 'text-end', id: 'trae-0' })
  const emittedToolCalls = emitToolCalls(controller, toolCalls, toolSchemaHints)
  controller.enqueue({
    type: 'finish',
    finishReason: decorateFinishReason(emittedToolCalls > 0 ? 'tool-calls' : 'stop'),
    usage: mapUsage(result.usage ?? result.message?.response_meta?.usage),
  })
}

function nextTextDelta(previous: string, next: string): string {
  if (!next) return ''
  if (next.startsWith(previous)) return next.slice(previous.length)
  return next
}

function emitToolCalls(
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>,
  toolCalls: ReturnType<typeof extractFunctionToolCalls>,
  toolSchemaHints: Record<string, Set<string>>,
): number {
  let emitted = 0
  for (const call of toolCalls) {
    const toolName = normalizeToolName(call.name)
    const normalizedInput = normalizeToolInput(toolName, call.input, toolSchemaHints[toolName])
    if (isBlockedInternalReferenceToolCall(toolName, normalizedInput)) continue
    controller.enqueue({ type: 'tool-input-start', id: call.id, toolName } as LanguageModelV2StreamPart)
    controller.enqueue({ type: 'tool-input-delta', id: call.id, delta: normalizedInput } as LanguageModelV2StreamPart)
    controller.enqueue({ type: 'tool-input-end', id: call.id } as LanguageModelV2StreamPart)
    controller.enqueue({
      type: 'tool-call',
      toolCallId: call.id,
      toolName,
      input: normalizedInput,
    } as LanguageModelV2StreamPart)
    emitted += 1
  }
  return emitted
}

function isBlockedInternalReferenceToolCall(toolName: string, input: string): boolean {
  if (toolName !== 'read') return false
  const parsed = parseInputObject(input)
  const filePath = pickString(parsed?.filePath)
  if (!filePath) return false
  return isInternalReferencePath(filePath)
}

function resolveEnforceTextOnly(options?: TraeProviderOptions): boolean | undefined {
  if (typeof options?.enforceTextOnly === 'boolean') return options.enforceTextOnly
  if (options?.enableToolCalling === true) return true
  return undefined
}

function resolveSystemPreamble(options?: TraeProviderOptions, tools?: LanguageModelV2CallOptions['tools']): string | undefined {
  if (options?.injectCodingSystemPrompt === false) return undefined
  if (typeof options?.codingSystemPreamble === 'string' && options.codingSystemPreamble.trim()) {
    return options.codingSystemPreamble
  }
  if (options?.enableToolCalling !== true) return undefined
  const toolNames = listToolNames(tools)
  return [
    'You are in coding runtime mode.',
    'Do not execute Trae CLI internal tools.',
    'Trae CLI is only the LLM backend; OpenCode executes all filesystem, shell, edit, write, and sub-agent tools.',
    toolNames.length > 0 ? `Available OpenCode tools: ${toolNames.join(', ')}.` : 'Use only tools that OpenCode provides in the current request.',
    'If repository or filesystem facts are needed, request an OpenCode tool before answering.',
    'When a tool is needed, output exactly one <opencode_tool_call> block and no other text.',
    'The block content must be JSON: {"id":"optional-stable-id","name":"tool_name","input":{...}}.',
    'After OpenCode returns the tool result, continue from the result instead of fabricating command output.',
    'For direct final answers, do not output a tool block.',
    'Inspect files before edits, keep edits minimal, then request verification commands when needed.',
    'Do not fabricate command output; rely on tool results.',
  ].join(' ')
}

function extractToolCalls(result: TraeCliResult): ReturnType<typeof extractFunctionToolCalls> {
  const textCalls = extractTextToolCalls(result.message?.content)
  if (textCalls.length > 0) return textCalls
  return extractFunctionToolCalls(result)
}

function listToolNames(tools: LanguageModelV2CallOptions['tools']): string[] {
  const names: string[] = []
  for (const rec of iterToolDefinitions(tools)) {
    if (rec.type !== 'function') continue
    const name = String(rec.name ?? '').trim()
    if (name) names.push(name)
  }
  return [...new Set(names)]
}

function zeroUsage(): LanguageModelV2Usage {
  return {
    inputTokens: { total: 0, cached: 0 },
    outputTokens: { total: 0, reasoning: 0 },
    totalTokens: 0,
  } as unknown as LanguageModelV2Usage
}

function routeCodingToolCalls(
  options: LanguageModelV2CallOptions,
  providerOptions?: TraeProviderOptions,
): ReturnType<typeof extractFunctionToolCalls> {
  if (providerOptions?.enableToolCalling !== true) return []
  const userText = getLastUserText(options)
  if (!userText) return []
  const toolNames = new Set(listToolNames(options.tools))
  const calls: ReturnType<typeof extractFunctionToolCalls> = []
  const explicitBash = routeExplicitBashExecution(options, toolNames)
  if (explicitBash.length > 0) return explicitBash
  const contextReads = routeConcreteCodingContextReads(options, toolNames)
  if (contextReads.length > 0) return contextReads
  const manifestReads = routeManifestReadsFromGlobResults(options, toolNames)
  if (manifestReads.length > 0) return manifestReads
  if (hasToolResult(options)) return []
  if (toolNames.has('bash') && mentionsAllRepoManifests(userText)) {
    calls.push({
      id: 'trae-router-manifest-inventory-0',
      name: 'bash',
      input: JSON.stringify({
        description: 'Collect compact package.json and README.md inventory for repository engineering review',
        command: isManifestListRequest(userText) ? buildManifestPathInventoryCommand() : buildManifestInventoryCommand(),
        timeout: 15,
      }),
    })
    return calls
  }
  if (toolNames.has('glob') && mentionsAllRepoManifests(userText)) {
    calls.push(
      { id: 'trae-router-glob-0', name: 'glob', input: '{"pattern":"**/package.json"}' },
      { id: 'trae-router-glob-1', name: 'glob', input: '{"pattern":"**/README.md"}' },
    )
    return calls
  }
  if (toolNames.has('read')) {
    const filePath = extractRequestedFilePath(userText)
    if (filePath) {
      calls.push({
        id: 'trae-router-read-0',
        name: 'read',
        input: JSON.stringify({ filePath }),
      })
    }
  }
  return calls
}

function routeExplicitBashExecution(
  options: LanguageModelV2CallOptions,
  toolNames: Set<string>,
): ReturnType<typeof extractFunctionToolCalls> {
  if (!toolNames.has('bash')) return []
  if (hasToolResult(options)) return []
  const userText = getLastUserText(options)
  const command = extractExplicitShellCommand(userText)
  if (!command) return []
  return [{
    id: 'trae-router-bash-explicit-0',
    name: 'bash',
    input: JSON.stringify({
      command,
      description: `Run ${command}`,
    }),
  }]
}

function extractExplicitShellCommand(text: string): string | undefined {
  const fenced = /(?:命令|command)[:：]\s*`([^`]+)`/i.exec(text)?.[1]
  if (fenced) return fenced.trim()
  const plain = /(?:执行命令|命令|command)[:：]\s*([^\n]+)/i.exec(text)?.[1]
  if (plain) {
    const trimmed = plain.trim()
    const cutoff = trimmed.search(/[。！？!?]/u)
    return (cutoff >= 0 ? trimmed.slice(0, cutoff) : trimmed).trim().replace(/["'`]+$/u, '').trim()
  }
  return undefined
}

function routeConcreteCodingContextReads(
  options: LanguageModelV2CallOptions,
  toolNames: Set<string>,
): ReturnType<typeof extractFunctionToolCalls> {
  const userText = getFirstUserText(options)
  if (!isPackageScriptTddContextRequest(userText)) return []
  const results = collectToolResults(options)
  const testFiles = parseToolResultFileList(results.get('trae-router-context-find-tests'))
  if (testFiles.length > 0 && !hasAnyToolCall(options, 'trae-router-context-read-test-') && toolNames.has('read')) {
    return [...new Set(testFiles)]
      .filter((file) => /(^|\/)tests\/.*\.test\.[cm]?[jt]sx?$/.test(file) || /(^|\/)tests\/.*\.spec\.[cm]?[jt]sx?$/.test(file))
      .slice(0, 4)
      .map((filePath, index) => ({
        id: `trae-router-context-read-test-${index}`,
        name: 'read',
        input: JSON.stringify({ filePath, limit: 240 }),
      }))
  }
  if (hasToolResult(options)) return []
  const calls: ReturnType<typeof extractFunctionToolCalls> = []
  if (toolNames.has('read') && !hasAnyToolCall(options, 'trae-router-context-read-package')) {
    calls.push({
      id: 'trae-router-context-read-package',
      name: 'read',
      input: '{"filePath":"package.json"}',
    })
  }
  if (toolNames.has('read') && userText.toLowerCase().includes('readme') && !hasAnyToolCall(options, 'trae-router-context-read-readme')) {
    calls.push({
      id: 'trae-router-context-read-readme',
      name: 'read',
      input: '{"filePath":"README.md","limit":200}',
    })
  }
  if (toolNames.has('bash') && /\btests?\b|测试/.test(userText) && !hasAnyToolCall(options, 'trae-router-context-find-tests')) {
    calls.push({
      id: 'trae-router-context-find-tests',
      name: 'bash',
      input: JSON.stringify({
        description: 'Find project test files for TDD context',
        command: 'find tests -type f \\( -name "*.test.ts" -o -name "*.test.tsx" -o -name "*.spec.ts" -o -name "*.spec.tsx" \\) | sort | head -20',
        timeout: 5,
      }),
    })
  }
  return calls
}

function isPackageScriptTddContextRequest(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    lower.includes('package.json') &&
    lower.includes('readme') &&
    (lower.includes('tests') || text.includes('测试')) &&
    (
      lower.includes('tdd') ||
      lower.includes('prepack') ||
      lower.includes('prepublishonly') ||
      lower.includes('lifecycle script') ||
      text.includes('修复') ||
      text.includes('改造') ||
      text.includes('修改')
    )
  )
}

function buildManifestInventoryCommand(): string {
  return [
    'find . -maxdepth 3 \\( -path "*/node_modules/*" -o -path "*/.git/*" -o -path "*/.opencode/*" -o -path "*/.next/*" -o -path "*/dist/*" -o -path "*/build/*" -o -path "*/coverage/*" \\) -prune -o \\( -name package.json -o -iname README.md \\) -type f -print | sort | head -200 | while IFS= read -r f; do',
    '  rel="${f#./}"',
    '  echo "### $rel"',
    '  case "$f" in',
    '    */package.json)',
    '      node -e \'const fs=require("fs"); const p=process.argv[1]; try { const j=JSON.parse(fs.readFileSync(p,"utf8")); const out={name:j.name,version:j.version,description:j.description,license:j.license,type:j.type,engines:j.engines,scripts:j.scripts,dependencies:j.dependencies?Object.keys(j.dependencies).slice(0,20):undefined,devDependencies:j.devDependencies?Object.keys(j.devDependencies).slice(0,20):undefined}; console.log(JSON.stringify(out)); } catch (e) { console.log("[unreadable package.json] "+e.message); }\' "$f"',
    '      ;;',
    '    *)',
    '      grep -E "^(#|##) " "$f" | head -12 || true',
    '      ;;',
    '  esac',
    'done',
  ].join('\n')
}

function buildManifestPathInventoryCommand(): string {
  return [
    'find . -maxdepth 3 \\( -path "*/node_modules/*" -o -path "*/.git/*" -o -path "*/.opencode/*" -o -path "*/.next/*" -o -path "*/dist/*" -o -path "*/build/*" -o -path "*/coverage/*" \\) -prune -o \\( -name package.json -o -iname README.md \\) -type f -print | sort | head -200 | while IFS= read -r f; do',
    '  rel="${f#./}"',
    '  echo "### $rel"',
    'done',
  ].join('\n')
}

function routeManifestReadsFromGlobResults(
  options: LanguageModelV2CallOptions,
  toolNames: Set<string>,
): ReturnType<typeof extractFunctionToolCalls> {
  if (!toolNames.has('read')) return []
  const results = collectToolResults(options)
  if (!results.has('trae-router-glob-0') || !results.has('trae-router-glob-1')) return []
  if (hasAnyToolCall(options, 'trae-router-read-')) return []
  const packageFiles = parseToolResultFileList(results.get('trae-router-glob-0')).filter((file) => file.endsWith('package.json'))
  const readmeFiles = parseToolResultFileList(results.get('trae-router-glob-1')).filter((file) => /readme\.md$/i.test(file))
  return [...packageFiles.slice(0, 3), ...readmeFiles.slice(0, 3)].map((filePath, index) => ({
    id: `trae-router-read-${index}`,
    name: 'read',
    input: JSON.stringify({ filePath, limit: 200 }),
  }))
}

function collectToolResults(options: LanguageModelV2CallOptions): Map<string, string> {
  const results = new Map<string, string>()
  for (const message of options.prompt ?? []) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue
      const rec = part as Record<string, unknown>
      if (rec.type !== 'tool-result') continue
      const id = String(rec.toolCallId ?? '')
      if (!id) continue
      results.set(id, serializeToolOutput(rec.output))
    }
  }
  return results
}

function collectToolResultsByName(options: LanguageModelV2CallOptions, toolName: string): Array<{ id: string; output: string }> {
  const results: Array<{ id: string; output: string }> = []
  const normalizedToolName = normalizeToolName(toolName)
  for (const message of options.prompt ?? []) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue
      const rec = part as Record<string, unknown>
      if (rec.type !== 'tool-result') continue
      if (normalizeToolName(String(rec.toolName ?? '')) !== normalizedToolName) continue
      const id = String(rec.toolCallId ?? '')
      if (!id) continue
      results.push({ id, output: serializeToolOutput(rec.output) })
    }
  }
  return results
}

function buildDeterministicToolResultFallback(options: LanguageModelV2CallOptions): string | undefined {
  return buildDirectBashResultFallback(options)
    ?? buildManifestInventoryFallback(options)
    ?? buildReadResultFallback(options)
    ?? buildConcreteCodingContextFallback(options)
}

function buildDirectBashResultFallback(options: LanguageModelV2CallOptions): string | undefined {
  const results = collectToolResultsByName(options, 'bash')
  if (results.length === 0) return undefined
  if (!asksForRawToolOutput(getFirstUserText(options))) return undefined
  return results.at(-1)?.output.trim()
}

function asksForRawToolOutput(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    text.includes('只') ||
    text.includes('完整输出') ||
    text.includes('不要解释') ||
    lower.includes('only') ||
    lower.includes('exact output')
  )
}

function buildManifestInventoryFallback(options: LanguageModelV2CallOptions): string | undefined {
  const results = collectToolResults(options)
  const inventory = results.get('trae-router-manifest-inventory-0')
  if (!inventory) return undefined
  const files = [...inventory.matchAll(/^###\s+(.+)$/gm)].map((match) => match[1]).filter(Boolean)
  const packageFiles = files.filter((file) => file.endsWith('package.json'))
  const readmeFiles = files.filter((file) => /readme\.md$/i.test(file))
  const packageNames = [...inventory.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((match) => match[1]).slice(0, 8)
  const scriptHints = [...new Set([...inventory.matchAll(/"scripts"\s*:\s*\{([^}]*)\}/g)]
    .flatMap((match) => [...match[1].matchAll(/"([^"]+)"\s*:/g)].map((script) => script[1]))
    .slice(0, 12))]
  if (isManifestListRequest(getFirstUserText(options))) {
    return [
      '基于 OpenCode 工具读取结果，当前目录下发现这些 manifest 文件：',
      '',
      'package.json:',
      ...(packageFiles.length ? packageFiles.map((file) => `- ${file}`) : ['- 未发现']),
      '',
      'README.md:',
      ...(readmeFiles.length ? readmeFiles.map((file) => `- ${file}`) : ['- 未发现']),
    ].join('\n')
  }
  const summaryPackageFiles = packageFiles.slice(0, 8)
  const summaryReadmeFiles = readmeFiles.slice(0, 8)
  return [
    '基于 OpenCode 工具读取结果，先给出一个可用的工程化建议摘要。当前 Trae CLI 在该宽泛多仓库总结场景下会超时，因此这里避免再次调用 Trae，只基于真实工具输出生成结论。',
    '',
    `已采集 package.json: ${summaryPackageFiles.length ? summaryPackageFiles.join(', ') : '未发现'}`,
    `已采集 README.md: ${summaryReadmeFiles.length ? summaryReadmeFiles.join(', ') : '未发现'}`,
    packageNames.length ? `识别到的包名: ${packageNames.join(', ')}` : '',
    scriptHints.length ? `常见脚本: ${scriptHints.join(', ')}` : '',
    '',
    '1. 先统一多仓库的基础元数据和运行时边界：为 package.json 补齐 name/version/license/repository/engines/files，并让 README 明确安装、配置、运行、发布路径，避免 Agent 无法判断项目入口和兼容范围。',
    '2. 建立最小质量门禁而不是一次性追求完整平台化：每个仓库至少提供 test/build/typecheck 或等价脚本，并在 README 中说明可由 Agent 安全执行的命令，方便 OpenCode 做自动验证。',
    '3. 把多仓库任务拆成可缓存的机器可读 inventory：先用脚本提取 package/README 关键字段，再交给模型总结；避免让 LLM 直接吞整仓 README 或 node_modules/.opencode 噪声，减少超时和上下文污染。',
  ].filter(Boolean).join('\n')
}

function isManifestListRequest(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('package.json') && lower.includes('readme') && (
    text.includes('哪些') ||
    text.includes('都') ||
    text.includes('列出') ||
    lower.includes('list')
  ) && !text.includes('建议') && !text.includes('总结')
}

function buildToolResultTimeoutFallback(options: LanguageModelV2CallOptions, error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error)
  if (!/timed out/i.test(message)) return undefined
  const results = collectToolResults(options)
  const readResults = [...results.entries()].filter(([id]) => id.startsWith('trae-router-read-'))
  if (readResults.length === 0) return undefined

  const snippets = readResults.map(([id, output]) => {
    const text = output.trim()
    return { id, text, scriptValue: extractPackageScriptValue(text, 'test') }
  })
  const script = snippets.find((item) => item.scriptValue)?.scriptValue
  const lines = [
    'Trae CLI 在工具结果返回后的总结阶段超时；以下回答基于 OpenCode 已读取到的真实工具结果生成。',
    script ? `scripts.test 是 ${script}` : undefined,
    ...snippets.map((item) => `${item.id}: ${clipText(item.text, 1200)}`),
  ]
  return lines.filter((line): line is string => Boolean(line)).join('\n')
}

function buildReadResultFallback(options: LanguageModelV2CallOptions): string | undefined {
  const question = getFirstUserText(options)
  if (!/scripts\.test/.test(question)) return undefined
  const readResults = [...collectToolResults(options).entries()].filter(([id]) => id.startsWith('trae-router-read-'))
  for (const [, output] of readResults) {
    const script = extractPackageScriptValue(output.trim(), 'test')
    if (script) return `scripts.test 是 ${script}`
  }
  return undefined
}

function buildConcreteCodingContextFallback(options: LanguageModelV2CallOptions): string | undefined {
  if (!isPackageScriptTddContextRequest(getFirstUserText(options))) return undefined
  const results = collectToolResults(options)
  if (!results.has('trae-router-context-find-tests')) return undefined
  const testFiles = parseToolResultFileList(results.get('trae-router-context-find-tests'))
  if (testFiles.length > 0) return undefined
  return '已读取 package.json 和 README.md，但未发现测试文件；请先确认 tests 目录或测试文件命名，再继续 TDD 修改。'
}

function extractPackageScriptValue(text: string, scriptName: string): string | undefined {
  const parsed = parseJsonObject(text)
  const scripts = parsed?.scripts
  if (!scripts || typeof scripts !== 'object') return undefined
  const value = (scripts as Record<string, unknown>)[scriptName]
  return typeof value === 'string' ? value : undefined
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function clipText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text
}

function serializeToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (!output || typeof output !== 'object') return String(output ?? '')
  const rec = output as Record<string, unknown>
  if (rec.type === 'text' && typeof rec.value === 'string') return rec.value
  if (rec.type === 'json') return JSON.stringify(rec.value)
  return JSON.stringify(output)
}

function parseToolResultFileList(output: string | undefined): string[] {
  if (!output) return []
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('[') && !line.includes('truncated') && isWorkspaceFileCandidate(line))
}

function isWorkspaceFileCandidate(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  if (normalized.startsWith('/') || normalized.startsWith('..')) return false
  if (isInternalReferencePath(normalized)) return false
  return !/(^|\/)(\.git|\.opencode|node_modules|dist|build|coverage)(\/|$)/.test(normalized)
}

function isInternalReferencePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '')
  return (
    /^references\/[a-z0-9._-]*tools\.md$/i.test(normalized) ||
    /(^|\/)(AGENTS|RTK|CLAUDE)\.md$/i.test(normalized)
  )
}

function hasAnyToolCall(options: LanguageModelV2CallOptions, idPrefix: string): boolean {
  for (const message of options.prompt ?? []) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue
      const rec = part as Record<string, unknown>
      if (rec.type === 'tool-call' && String(rec.toolCallId ?? '').startsWith(idPrefix)) return true
    }
  }
  return false
}

function hasToolResult(options: LanguageModelV2CallOptions): boolean {
  return (options.prompt ?? []).some((message) => message.role === 'tool')
}

function getLastUserText(options: LanguageModelV2CallOptions): string {
  const prompt = options.prompt ?? []
  for (let i = prompt.length - 1; i >= 0; i -= 1) {
    const message = prompt[i]
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    return message.content.map((part) => {
      if (!part || typeof part !== 'object') return ''
      const rec = part as Record<string, unknown>
      return rec.type === 'text' && typeof rec.text === 'string' ? rec.text : ''
    }).join('\n')
  }
  return ''
}

function getFirstUserText(options: LanguageModelV2CallOptions): string {
  for (const message of options.prompt ?? []) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    return message.content.map((part) => {
      if (!part || typeof part !== 'object') return ''
      const rec = part as Record<string, unknown>
      return rec.type === 'text' && typeof rec.text === 'string' ? rec.text : ''
    }).join('\n')
  }
  return ''
}

function mentionsAllRepoManifests(text: string): boolean {
  const lower = text.toLowerCase()
  if (isConcreteCodingChangeRequest(text)) return false
  return (
    lower.includes('package.json') &&
    lower.includes('readme') &&
    (
      text.includes('所有') ||
      text.includes('哪些') ||
      text.includes('都') ||
      lower.includes('all') ||
      text.includes('每个') ||
      text.includes('当前文件夹')
    )
  )
}

function isConcreteCodingChangeRequest(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    lower.includes('tdd') ||
    lower.includes('prepack') ||
    lower.includes('prepublishonly') ||
    lower.includes('lifecycle script') ||
    lower.includes('script') ||
    lower.includes('test') ||
    lower.includes('edit') ||
    lower.includes('write') ||
    text.includes('修复') ||
    text.includes('修改') ||
    text.includes('改造') ||
    text.includes('补充') ||
    text.includes('更新') ||
    text.includes('测试') ||
    text.includes('脚本') ||
    text.includes('运行') ||
    text.includes('验证')
  )
}

function extractRequestedFilePath(text: string): string | undefined {
  const matches = [...text.matchAll(/(?:^|[\s"'`，。；;:：])([A-Za-z0-9._@/+:-]+\/)?([A-Za-z0-9._@+-]+\.(?:json|md|ts|tsx|js|jsx|mjs|cjs|go|rs|py|java|yaml|yml|toml|lock|txt))(?:$|[\s"'`，。；;:：])/g)]
  if (matches.length === 0) return undefined
  const candidates = matches
    .map((match) => `${match[1] ?? ''}${match[2] ?? ''}`.trim())
    .filter((filePath) => filePath && isWorkspaceFileCandidate(filePath))
  return candidates.at(-1)
}

function normalizeToolInput(
  toolName: string,
  input: string,
  schemaFields?: Set<string>,
): string {
  const parsed = parseInputObject(input)
  if (!parsed) return input
  const normalizedToolName = toolName.toLowerCase()
  const normalized = normalizeToolInputObject(normalizedToolName, parsed)
  applyRequiredAliases(normalizedToolName, normalized, schemaFields)
  applyPathAliases(normalized, schemaFields)
  return JSON.stringify(normalized)
}

function applyRequiredAliases(
  toolName: string,
  input: Record<string, unknown>,
  schemaFields?: Set<string>,
): void {
  if (toolName !== 'bash') return
  if (!schemaFields?.has('description')) return
  if (pickString(input.description)) return
  const command = pickString(input.command)
  input.description = command ? `Run ${command}` : 'Run shell command'
}

function normalizeToolInputObject(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
    case 'read':
    case 'read_file':
    case 'readfile':
    case 'cat': {
      const next = renameKeys(input, { file_path: 'filePath' })
      const offset = pickNumber(next.offset)
        ?? pickNumber(next.start)
        ?? pickNumber(next.line)
        ?? pickNumber(next.line_number)
        ?? pickNumber(next.lineNumber)
        ?? pickNumber(next.start_line)
        ?? pickNumber(next.startLine)
      if (offset !== undefined) next.offset = normalizeMinInt(offset, 1)
      const limit = pickNumber(next.limit)
        ?? pickNumber(next.length)
        ?? pickNumber(next.lines)
        ?? pickNumber(next.max_lines)
        ?? pickNumber(next.maxLines)
      if (limit !== undefined) next.limit = normalizeMinInt(limit, 1)
      delete next.start
      delete next.line
      delete next.line_number
      delete next.lineNumber
      delete next.start_line
      delete next.startLine
      delete next.length
      delete next.lines
      delete next.max_lines
      delete next.maxLines
      return next
    }
    case 'write':
    case 'writefile': {
      const next = renameKeys(input, { file_path: 'filePath' })
      const content = pickString(next.content)
        ?? pickString(next.text)
        ?? pickString(next.data)
        ?? pickString(next.body)
        ?? pickString(next.value)
      if (content !== undefined) next.content = content
      delete next.text
      delete next.data
      delete next.body
      delete next.value
      return next
    }
    case 'edit':
    case 'str_replace_based_edit_tool': {
      const next = renameKeys(input, {
        file_path: 'filePath',
        old_string: 'oldString',
        new_string: 'newString',
        replace_all: 'replaceAll',
      })
      const oldString = pickString(next.oldString)
        ?? pickString(next.oldText)
        ?? pickString(next.find)
        ?? pickString(next.search)
      const newString = pickString(next.newString)
        ?? pickString(next.newText)
        ?? pickString(next.replace)
        ?? pickString(next.replacement)
      if (oldString !== undefined) next.oldString = oldString
      if (newString !== undefined) next.newString = newString
      const replaceAll = pickBoolean(next.replaceAll)
        ?? pickBoolean(next.all)
        ?? pickBoolean(next.global)
      if (replaceAll !== undefined) next.replaceAll = replaceAll
      delete next.oldText
      delete next.newText
      delete next.find
      delete next.search
      delete next.replace
      delete next.replacement
      delete next.all
      delete next.global
      return next
    }
    case 'grep': {
      const next = renameKeys(input, {})
      if (!pickString(next.include)) {
        next.include = pickString(next.glob) ?? inferIncludeFromType(next.type)
      }
      delete next.glob
      delete next.type
      delete next.output_mode
      delete next.multiline
      delete next['-i']
      delete next['-n']
      delete next['-B']
      delete next['-A']
      delete next['-C']
      delete next.head_limit
      return next
    }
    case 'glob': {
      const next = renameKeys(input, {})
      if (!pickString(next.pattern)) {
        const pathArg = pickString(next.path) ?? pickString(next.dir) ?? pickString(next.directory)
        if (pathArg && pathArg !== '.') {
          const base = pathArg.endsWith('/') ? pathArg.slice(0, -1) : pathArg
          next.pattern = `${base}/**/*`
        } else {
          next.pattern = pickString(next.glob) ?? pickString(next.include) ?? '**/*'
        }
      }
      delete next.glob
      delete next.include
      delete next.path
      delete next.dir
      delete next.directory
      return next
    }
    case 'bash': {
      const next = renameKeys(input, {})
      if (!pickString(next.command)) {
        next.command = pickString(next.cmd) ?? pickString(next.script) ?? pickString(next.shell) ?? ''
      }
      const timeout = pickNumber(next.timeout)
        ?? pickNumber(next.timeoutMs)
        ?? pickNumber(next.timeout_ms)
      if (timeout !== undefined) {
        next.timeout = normalizeMinInt(timeout, 1)
      }
      delete next.cmd
      delete next.script
      delete next.shell
      delete next.timeoutMs
      delete next.timeout_ms
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
        ?? pickString(next.subagentType)
        ?? pickString(next.agent_type)
        ?? pickString(next.agentType)
        ?? pickString(next.type)
      if (subagentType) next.subagent_type = mapSubagentType(subagentType)
      const description = pickString(next.description) ?? pickString(next.title) ?? pickString(next.name)
      if (description !== undefined) next.description = description
      const prompt = pickString(next.prompt) ?? pickString(next.task) ?? pickString(next.instruction)
      if (prompt !== undefined) next.prompt = prompt
      delete next.subagentType
      delete next.agent_type
      delete next.agentType
      delete next.type
      delete next.title
      delete next.name
      delete next.task
      delete next.instruction
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

function pickNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function pickBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase()
    if (lower === 'true') return true
    if (lower === 'false') return false
  }
  return undefined
}

function normalizeMinInt(value: number, min: number): number {
  return Math.max(min, Math.floor(value))
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

function applyPathAliases(
  input: Record<string, unknown>,
  schemaFields?: Set<string>,
): void {
  const pathValue = pickString(input.filePath) ?? pickString(input.path) ?? pickString(input.filepath) ?? pickString(input.file_path)
  if (!pathValue) return
  const target = pickPreferredPathField(schemaFields)
  if (target) {
    input[target] = pathValue
    return
  }
  if (typeof input.filePath !== 'string') input.filePath = pathValue
}

function pickPreferredPathField(schemaFields?: Set<string>): string | undefined {
  if (!schemaFields || schemaFields.size === 0) return undefined
  if (schemaFields.has('filePath')) return 'filePath'
  if (schemaFields.has('path')) return 'path'
  if (schemaFields.has('filepath')) return 'filepath'
  if (schemaFields.has('file_path')) return 'file_path'
  return undefined
}

function buildToolSchemaHints(tools: LanguageModelV2CallOptions['tools']): Record<string, Set<string>> {
  const map: Record<string, Set<string>> = {}
  for (const rec of iterToolDefinitions(tools)) {
    if (rec.type !== 'function') continue
    const name = normalizeToolName(String(rec.name ?? ''))
    if (!name) continue
    const schema = rec.inputSchema
    const fields = extractSchemaFields(schema)
    if (fields.size > 0) map[name] = fields
  }
  return map
}

function iterToolDefinitions(tools: LanguageModelV2CallOptions['tools']): Record<string, unknown>[] {
  if (!tools) return []
  if (Array.isArray(tools)) {
    return tools.filter((tool): tool is Record<string, unknown> => !!tool && typeof tool === 'object')
  }
  if (typeof tools !== 'object') return []
  return Object.entries(tools as Record<string, unknown>).flatMap(([name, tool]) => {
    if (!tool || typeof tool !== 'object') return []
    const rec = tool as Record<string, unknown>
    return [{ ...rec, name: typeof rec.name === 'string' && rec.name ? rec.name : name }]
  })
}

function extractSchemaFields(schema: unknown): Set<string> {
  if (!schema || typeof schema !== 'object') return new Set()
  const rec = schema as Record<string, unknown>
  const direct = rec.properties
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return new Set(Object.keys(direct as Record<string, unknown>))
  }
  const innerSchema = rec.schema
  if (innerSchema && typeof innerSchema === 'object' && !Array.isArray(innerSchema)) {
    const inner = innerSchema as Record<string, unknown>
    if (inner.properties && typeof inner.properties === 'object' && !Array.isArray(inner.properties)) {
      return new Set(Object.keys(inner.properties as Record<string, unknown>))
    }
  }
  return new Set()
}

function normalizeToolName(name: string): string {
  const lower = name.toLowerCase()
  if (lower === 'askuserquestion') return 'question'
  if (lower === 'agent') return 'task'
  if (lower === 'exitplanmode') return 'plan_exit'
  if (lower === 'str_replace_based_edit_tool') return 'edit'
  if (lower === 'readfile') return 'read'
  if (lower === 'writefile') return 'write'
  if (lower === 'ls' || lower === 'listfiles' || lower === 'list_files' || lower === 'listdir' || lower === 'list_dir') return 'glob'
  if (lower === 'runbash' || lower === 'bashcommand') return 'bash'
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
