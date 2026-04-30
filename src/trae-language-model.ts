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
import { runCliLlmStreaming } from './cli/cli-runner.js'
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
  maxToolPayloadChars?: number
  codingSystemPreamble?: string
  injectCodingSystemPrompt?: boolean
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
    const toolSchemaHints = buildToolSchemaHints(options.tools)
    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start: async (controller) => {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        let textStarted = false
        let emittedText = ''
        let finished = false
        let metadataEmitted = false
        let lastUsage: LanguageModelV2Usage | undefined
        try {
          const selectedModel = resolveTraeModelName(this.modelId, this.providerOptions)
          const result = await runCliLlmStreaming({
            cliPath,
            modelName: selectedModel,
            prompt: buildPromptFromOptions(options, {
              includeToolHistory: this.providerOptions?.includeToolHistory ?? this.providerOptions?.enableToolCalling === true,
              maxMessages: this.providerOptions?.maxPromptMessages ?? 40,
              maxChars: this.providerOptions?.maxPromptChars ?? 12000,
              maxToolPayloadChars: this.providerOptions?.maxToolPayloadChars,
              systemPreamble: resolveSystemPreamble(this.providerOptions),
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
            const toolCalls = this.providerOptions?.enableToolCalling === true ? extractFunctionToolCalls(chunk) : []
            if (toolCalls.length > 0) {
              if (textStarted) controller.enqueue({ type: 'text-end', id: 'trae-0' })
              emitToolCalls(controller, toolCalls, toolSchemaHints)
              controller.enqueue({
                type: 'finish',
                finishReason: decorateFinishReason('tool-calls'),
                usage: lastUsage,
              })
              finished = true
              return 'stop'
            }

            const text = contentToText(chunk.message?.content).join('')
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
            const text = contentToText(result.message?.content).join('')
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
  const normalizedModelId = stripProviderPrefix(modelId)
  if (options?.enableToolCalling !== true && normalizedModelId === 'coding') return undefined
  if (options?.modelName) return options.modelName
  if (normalizedModelId === 'default') return undefined
  const aliases = {
    ...TRAE_MODEL_PROFILES,
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
  emitToolCalls(controller, toolCalls, toolSchemaHints)
  controller.enqueue({
    type: 'finish',
    finishReason: decorateFinishReason(toolCalls.length > 0 ? 'tool-calls' : 'stop'),
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
): void {
  for (const call of toolCalls) {
    const toolName = normalizeToolName(call.name)
    const normalizedInput = normalizeToolInput(toolName, call.input, toolSchemaHints[toolName])
    controller.enqueue({ type: 'tool-input-start', id: call.id, toolName, providerExecuted: false } as LanguageModelV2StreamPart)
    controller.enqueue({ type: 'tool-input-delta', id: call.id, delta: normalizedInput } as LanguageModelV2StreamPart)
    controller.enqueue({ type: 'tool-input-end', id: call.id } as LanguageModelV2StreamPart)
    controller.enqueue({
      type: 'tool-call',
      toolCallId: call.id,
      toolName,
      input: normalizedInput,
      providerExecuted: false,
    } as LanguageModelV2StreamPart)
  }
}

function resolveEnforceTextOnly(options?: TraeProviderOptions): boolean | undefined {
  if (typeof options?.enforceTextOnly === 'boolean') return options.enforceTextOnly
  if (options?.enableToolCalling === true) return false
  return undefined
}

function resolveSystemPreamble(options?: TraeProviderOptions): string | undefined {
  if (options?.injectCodingSystemPrompt === false) return undefined
  if (typeof options?.codingSystemPreamble === 'string' && options.codingSystemPreamble.trim()) {
    return options.codingSystemPreamble
  }
  if (options?.enableToolCalling !== true) return undefined
  return [
    'You are in coding runtime mode.',
    'Use tools deliberately: inspect files before edits, keep edits minimal, then run verification commands.',
    'If a tool call fails due to schema or permissions, correct arguments and retry with a safer fallback.',
    'Do not fabricate command output; rely on tool results.',
  ].join(' ')
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
  applyPathAliases(normalized, schemaFields)
  return JSON.stringify(normalized)
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
  for (const tool of tools ?? []) {
    if (!tool || typeof tool !== 'object') continue
    const rec = tool as Record<string, unknown>
    if (rec.type !== 'function') continue
    const name = normalizeToolName(String(rec.name ?? ''))
    if (!name) continue
    const schema = rec.inputSchema
    const fields = extractSchemaFields(schema)
    if (fields.size > 0) map[name] = fields
  }
  return map
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
