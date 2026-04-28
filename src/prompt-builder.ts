import type { LanguageModelV2CallOptions, LanguageModelV2Message, LanguageModelV2Prompt } from '@ai-sdk/provider'

type PromptBuildOptions = {
  includeToolHistory?: boolean
  maxChars?: number
  maxMessages?: number
  maxToolPayloadChars?: number
  systemPreamble?: string
}

export function buildPromptFromOptions(options: LanguageModelV2CallOptions, buildOptions?: PromptBuildOptions): string {
  return buildPrompt(options.prompt, buildOptions)
}

export function buildPrompt(prompt: LanguageModelV2Prompt, buildOptions?: PromptBuildOptions): string {
  const selectedPrompt = trimMessages(prompt, buildOptions?.maxMessages)
  const lines: string[] = []
  const preamble = pickString(buildOptions?.systemPreamble)
  if (preamble) lines.push(wrap('system', preamble))
  const includeToolHistory = buildOptions?.includeToolHistory === true
  for (const message of selectedPrompt) {
    lines.push(serializeMessage(message, includeToolHistory, buildOptions?.maxToolPayloadChars))
  }
  const text = lines.filter(Boolean).join('\n\n') || 'Hello'
  return trimPrompt(text, buildOptions?.maxChars)
}

function serializeMessage(
  message: LanguageModelV2Message,
  includeToolHistory: boolean,
  maxToolPayloadChars?: number,
): string {
  switch (message.role) {
    case 'system':
      return typeof message.content === 'string' ? wrap('system', message.content) : ''
    case 'user':
      return Array.isArray(message.content)
        ? wrap('user', message.content.map((part) => serializePart(part, includeToolHistory, maxToolPayloadChars)).filter(Boolean).join('\n'))
        : ''
    case 'assistant':
      return Array.isArray(message.content)
        ? wrap('assistant', message.content.map((part) => serializePart(part, includeToolHistory, maxToolPayloadChars)).filter(Boolean).join('\n'))
        : ''
    case 'tool':
      return includeToolHistory && Array.isArray(message.content)
        ? message.content.map((part) => serializeToolResultPart(part, maxToolPayloadChars)).filter(Boolean).join('\n')
        : ''
    default:
      return ''
  }
}

function wrap(tag: string, value: string): string {
  return value.trim() ? `<${tag}>\n${value}\n</${tag}>` : ''
}

function serializePart(part: unknown, includeToolHistory: boolean, maxToolPayloadChars?: number): string {
  if (!part || typeof part !== 'object') return ''
  const record = part as Record<string, unknown>
  if (record.type === 'text' && typeof record.text === 'string') return record.text
  if (includeToolHistory && record.type === 'tool-call') {
    const inputRaw = typeof record.input === 'string' ? record.input : JSON.stringify(record.input ?? {})
    const input = trimToolPayload(inputRaw, maxToolPayloadChars, 'tool_call input')
    return `<tool_call id="${String(record.toolCallId)}" name="${String(record.toolName)}">\n${input}\n</tool_call>`
  }
  if (record.type === 'file') {
    return `[Unsupported file input omitted: ${String(record.mediaType ?? 'unknown')}]`
  }
  if (record.type === 'image') {
    return `[Unsupported image input omitted: ${String(record.mimeType ?? record.mediaType ?? 'unknown')}]`
  }
  return ''
}

function serializeToolResultPart(part: unknown, maxToolPayloadChars?: number): string {
  if (!part || typeof part !== 'object') return ''
  const record = part as Record<string, unknown>
  if (record.type !== 'tool-result') return ''
  const output = trimToolPayload(serializeToolResultOutput(record.output), maxToolPayloadChars, 'tool_result output')
  return `<tool_result id="${String(record.toolCallId)}" name="${String(record.toolName)}">\n${output}\n</tool_result>`
}

function serializeToolResultOutput(output: unknown): string {
  if (!output || typeof output !== 'object') return String(output ?? '')
  const record = output as Record<string, unknown>
  if (record.type === 'text' && typeof record.value === 'string') return record.value
  if (record.type === 'json') return JSON.stringify(record.value)
  if (record.type === 'error-text' && typeof record.value === 'string') return `[Error] ${record.value}`
  if (record.type === 'error-json') return `[Error] ${JSON.stringify(record.value)}`
  return JSON.stringify(output)
}

function trimPrompt(prompt: string, maxChars?: number): string {
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars)) return prompt
  const limit = Math.max(256, Math.floor(maxChars))
  if (prompt.length <= limit) return prompt
  const suffix = prompt.slice(prompt.length - limit)
  const truncated = prompt.length - suffix.length
  return `[Prompt truncated: ${truncated} chars omitted]\n${suffix}`
}

function trimToolPayload(text: string, maxChars: number | undefined, label: string): string {
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars)) return text
  const limit = Math.max(128, Math.floor(maxChars))
  if (text.length <= limit) return text
  const suffix = text.slice(text.length - limit)
  const truncated = text.length - suffix.length
  return `[${label} truncated: ${truncated} chars omitted]\n${suffix}`
}

function trimMessages(prompt: LanguageModelV2Prompt, maxMessages?: number): LanguageModelV2Prompt {
  if (typeof maxMessages !== 'number' || !Number.isFinite(maxMessages)) return prompt
  const limit = Math.max(1, Math.floor(maxMessages))
  const nonSystemIndexes: number[] = []
  for (let i = 0; i < prompt.length; i += 1) {
    if (prompt[i].role !== 'system') nonSystemIndexes.push(i)
  }
  if (nonSystemIndexes.length <= limit) return prompt

  const keepNonSystem = new Set(nonSystemIndexes.slice(nonSystemIndexes.length - limit))
  const out: LanguageModelV2Message[] = []
  for (let i = 0; i < prompt.length; i += 1) {
    const message = prompt[i]
    if (message.role === 'system' || keepNonSystem.has(i)) out.push(message)
  }
  return out
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
