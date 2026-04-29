export type TraeCliResult = {
  agent_states?: Array<{
    messages?: Array<{
      role?: string
      tool_calls?: Array<{
        id?: string
        type?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }>
  }>
  message?: {
    role?: string
    content?: unknown
    response_meta?: {
      finish_reason?: string
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

export function parseJsonValues(text: string): { values: TraeCliResult[]; rest: string } {
  const values: TraeCliResult[] = []
  let cursor = 0

  while (cursor < text.length) {
    const start = findNextJsonStart(text, cursor)
    if (start < 0) return { values, rest: '' }
    const candidate = text.slice(start)
    const end = findJsonEnd(candidate)
    if (end < 0) return { values, rest: candidate }

    try {
      const parsed = JSON.parse(candidate.slice(0, end)) as TraeCliResult
      if (parsed && typeof parsed === 'object') values.push(parsed)
      cursor = start + end
    } catch {
      cursor = start + 1
    }
  }

  return { values, rest: '' }
}

export type TraeFunctionToolCall = {
  id: string
  name: string
  input: string
}

export function extractFunctionToolCalls(result: TraeCliResult): TraeFunctionToolCall[] {
  if (hasFinalTopLevelText(result)) return []
  const allMessages = (result.agent_states ?? []).flatMap((state) => state.messages ?? [])
  const lastAssistant = findLastAssistantMessage(allMessages)
  if (!lastAssistant || !Array.isArray(lastAssistant.tool_calls)) return []

  const calls: TraeFunctionToolCall[] = []
  for (const call of lastAssistant.tool_calls) {
    if (call?.type !== 'function') continue
    const id = String(call.id ?? '').trim()
    const name = String(call.function?.name ?? '').trim()
    if (!id || !name) continue
    calls.push({
      id,
      name,
      input: normalizeJsonText(call.function?.arguments),
    })
  }

  const deduped = new Map<string, TraeFunctionToolCall>()
  for (const call of calls) deduped.set(call.id, call)
  return [...deduped.values()]
}

function hasFinalTopLevelText(result: TraeCliResult): boolean {
  const finishReason = result.message?.response_meta?.finish_reason
  if (finishReason && finishReason !== 'stop') return false
  return hasTextContent(result.message?.content)
}

function hasTextContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some((part) => {
    if (typeof part === 'string') return part.trim().length > 0
    if (!part || typeof part !== 'object') return false
    const record = part as Record<string, unknown>
    return record.type === 'text' && typeof record.text === 'string' && record.text.trim().length > 0
  })
}

function findLastAssistantMessage(
  messages: Array<{ role?: string; tool_calls?: unknown }>,
): { role?: string; tool_calls?: unknown } | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === 'assistant') return message
  }
  return undefined
}

function normalizeJsonText(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value
  return '{}'
}

function findNextJsonStart(text: string, offset: number): number {
  const objectStart = text.indexOf('{', offset)
  const arrayStart = text.indexOf('[', offset)
  if (objectStart < 0) return arrayStart
  if (arrayStart < 0) return objectStart
  return Math.min(objectStart, arrayStart)
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
