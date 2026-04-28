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
import type { TraeCliResult } from './cli/json-output.js'
import { contentToText } from './cli/text-content.js'
import { mapUsage } from './cli/usage.js'
import { runCliLlm } from './cli/cli-runner.js'

export type TraeProviderOptions = {
  cliPath?: string
  modelName?: string
  queryTimeout?: number
  extraArgs?: string[]
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
          const result = await runCliLlm({
            cliPath,
            modelName: this.providerOptions?.modelName ?? (this.modelId === 'default' ? undefined : this.modelId),
            prompt: buildPromptFromOptions(options),
            queryTimeout: this.providerOptions?.queryTimeout,
            extraArgs: this.providerOptions?.extraArgs,
            abortSignal: options.abortSignal,
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
