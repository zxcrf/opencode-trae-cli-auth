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
      return typeof message.content === 'string' ? `<system>\n${message.content}\n</system>` : ''
    case 'user':
      return Array.isArray(message.content) ? message.content.map(serializePart).filter(Boolean).join('\n') : ''
    case 'assistant':
      return Array.isArray(message.content)
        ? `<assistant>\n${message.content.map(serializePart).filter(Boolean).join('\n')}\n</assistant>`
        : ''
    case 'tool':
      return Array.isArray(message.content)
        ? message.content
            .map((part) => (part.type === 'tool-result' ? `<tool_result id="${part.toolCallId}" name="${part.toolName}">\n${JSON.stringify(part.output, null, 2)}\n</tool_result>` : ''))
            .filter(Boolean)
            .join('\n')
        : ''
    default:
      return ''
  }
}

function serializePart(part: unknown): string {
  if (!part || typeof part !== 'object') return ''
  const record = part as Record<string, unknown>
  if (record.type === 'text' && typeof record.text === 'string') return record.text
  if (record.type === 'tool-call') {
    const input = typeof record.input === 'string' ? record.input : JSON.stringify(record.input ?? {})
    return `<tool_call id="${String(record.toolCallId)}" name="${String(record.toolName)}">\n${input}\n</tool_call>`
  }
  return ''
}
