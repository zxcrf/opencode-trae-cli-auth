import type { LanguageModelV2CallOptions, LanguageModelV2Message, LanguageModelV2Prompt } from '@ai-sdk/provider'

export function buildPromptFromOptions(options: LanguageModelV2CallOptions): string {
  return buildPrompt(options.prompt)
}

export function buildPrompt(prompt: LanguageModelV2Prompt): string {
  const lines: string[] = []
  for (const message of prompt) {
    lines.push(serializeMessage(message))
  }
  return lines.filter(Boolean).join('\n\n') || 'Hello'
}

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

function serializePart(part: unknown): string {
  if (!part || typeof part !== 'object') return ''
  const record = part as Record<string, unknown>
  if (record.type === 'text' && typeof record.text === 'string') return record.text
  if (record.type === 'tool-call') {
    const input = typeof record.input === 'string' ? record.input : JSON.stringify(record.input ?? {})
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

function serializeToolResultPart(part: unknown): string {
  if (!part || typeof part !== 'object') return ''
  const record = part as Record<string, unknown>
  if (record.type !== 'tool-result') return ''
  return `<tool_result id="${String(record.toolCallId)}" name="${String(record.toolName)}">\n${serializeToolResultOutput(record.output)}\n</tool_result>`
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
