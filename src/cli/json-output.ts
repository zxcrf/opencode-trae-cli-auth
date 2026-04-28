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
    content?: unknown
    response_meta?: {
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

export type TraeFunctionToolCall = {
  id: string
  name: string
  input: string
}

export function extractFunctionToolCalls(result: TraeCliResult): TraeFunctionToolCall[] {
  const allMessages = (result.agent_states ?? []).flatMap((state) => state.messages ?? [])
  const calls: TraeFunctionToolCall[] = []
  for (const msg of allMessages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue
    for (const call of msg.tool_calls) {
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
  }

  const deduped = new Map<string, TraeFunctionToolCall>()
  for (const call of calls) deduped.set(call.id, call)
  return [...deduped.values()]
}

function normalizeJsonText(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value
  return '{}'
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
