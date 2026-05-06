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

const TEXT_TOOL_CALL_RE = /<opencode_tool_call>\s*([\s\S]*?)\s*<\/opencode_tool_call>/gi
const TRAE_XML_TOOL_CALL_RE = /<tool_use>\s*([\s\S]*?)\s*<\/tool_use>/gi
const TRAE_COMPACT_TOOL_CALL_RE = /<tool_call>\s*([^\s<]+)\s*<\/arg_key>\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*([\s\S]*?)(?=\n---|\n<tool_call>|$)/gi
const TRAE_JSON_CLOSE_TOOL_CALL_RE = /(\{[\s\S]*?"name"[\s\S]*?"arguments"[\s\S]*?\})\s*<\/tool_call>/gi
const TRAE_JSON_ARGS_CLOSE_TOOL_CALL_RE = /(?<!["A-Za-z0-9_])"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}\s*<\/tool_call>/gi

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

export function extractTextToolCalls(content: unknown): TraeFunctionToolCall[] {
  const text = contentToPlainText(content)
  if (!text) return []
  const calls: TraeFunctionToolCall[] = []
  let match: RegExpExecArray | null
  TEXT_TOOL_CALL_RE.lastIndex = 0
  while ((match = TEXT_TOOL_CALL_RE.exec(text))) {
    const parsed = parseTextToolCall(match[1], calls.length)
    if (parsed) calls.push(parsed)
  }
  TRAE_XML_TOOL_CALL_RE.lastIndex = 0
  while ((match = TRAE_XML_TOOL_CALL_RE.exec(text))) {
    const parsed = parseTraeXmlToolCall(match[1], calls.length)
    if (parsed) calls.push(parsed)
  }
  TRAE_COMPACT_TOOL_CALL_RE.lastIndex = 0
  while ((match = TRAE_COMPACT_TOOL_CALL_RE.exec(text))) {
    const parsed = parseTraeCompactToolCall(match, calls.length)
    if (parsed) calls.push(parsed)
  }
  TRAE_JSON_CLOSE_TOOL_CALL_RE.lastIndex = 0
  while ((match = TRAE_JSON_CLOSE_TOOL_CALL_RE.exec(text))) {
    const parsed = parseTextToolCall(match[1], calls.length)
    if (parsed) calls.push(parsed)
  }
  TRAE_JSON_ARGS_CLOSE_TOOL_CALL_RE.lastIndex = 0
  while ((match = TRAE_JSON_ARGS_CLOSE_TOOL_CALL_RE.exec(text))) {
    const prefix = text.slice(Math.max(0, match.index - 64), match.index)
    if (/"name"\s*:/.test(prefix)) continue
    const parsed = parseTraeArgumentsOnlyToolCall(match[1], calls.length)
    if (parsed) calls.push(parsed)
  }
  return calls
}

export function stripTextToolCallBlocks(content: unknown): string {
  const text = contentToPlainText(content)
  if (!text) return ''
  return text
    .replace(TEXT_TOOL_CALL_RE, '')
    .replace(TRAE_XML_TOOL_CALL_RE, '')
    .replace(TRAE_COMPACT_TOOL_CALL_RE, '')
    .replace(TRAE_JSON_CLOSE_TOOL_CALL_RE, '')
    .replace(TRAE_JSON_ARGS_CLOSE_TOOL_CALL_RE, '')
    .replace(/^\s*---\s*$/gm, '')
    .trim()
}

function parseTextToolCall(raw: string, index: number): TraeFunctionToolCall | undefined {
  try {
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const name = pickNonEmptyString(parsed.name) ?? pickNonEmptyString(parsed.tool)
    if (!name) return undefined
    const id = pickNonEmptyString(parsed.id) ?? `trae-text-tool-${index}`
    const input = parsed.input ?? parsed.arguments ?? {}
    return {
      id,
      name,
      input: stringifyToolInput(input),
    }
  } catch {
    return undefined
  }
}

function parseTraeXmlToolCall(raw: string, index: number): TraeFunctionToolCall | undefined {
  const toolName = extractXmlTag(raw, 'tool_name') ?? extractXmlTag(raw, 'server_name')
  const input = extractXmlTag(raw, 'input')
  if (!toolName) return undefined
  return {
    id: `trae-text-tool-${index}`,
    name: toolName,
    input: normalizeJsonTextInput(input),
  }
}

function parseTraeCompactToolCall(match: RegExpExecArray, index: number): TraeFunctionToolCall | undefined {
  const name = pickNonEmptyString(match[1])
  const key = pickNonEmptyString(match[2])
  const value = pickNonEmptyString(match[3]?.replace(/\n---\s*$/, ''))
  if (!name || !key || !value) return undefined
  return {
    id: `trae-text-tool-${index}`,
    name,
    input: JSON.stringify({ [key]: value }),
  }
}

function parseTraeArgumentsOnlyToolCall(rawArguments: string, index: number): TraeFunctionToolCall | undefined {
  try {
    const parsed = JSON.parse(rawArguments.trim()) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    if (!('command' in parsed) && !('cmd' in parsed) && !('shell' in parsed) && !('script' in parsed)) return undefined
    return {
      id: `trae-text-tool-${index}`,
      name: 'bash',
      input: stringifyToolInput(parsed),
    }
  } catch {
    return undefined
  }
}

function extractXmlTag(text: string, tag: string): string | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`<${escaped}>\\s*([\\s\\S]*?)\\s*<\\/${escaped}>`, 'i').exec(text)
  return pickNonEmptyString(match?.[1])
}

function normalizeJsonTextInput(value: string | undefined): string {
  if (!value) return '{}'
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '{}'
    return JSON.stringify(parsed)
  } catch {
    return value.trim()
  }
}

function stringifyToolInput(input: unknown): string {
  if (typeof input === 'string' && input.trim()) return input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '{}'
  return JSON.stringify(input)
}

function pickNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
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

function contentToPlainText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object') return ''
    const record = part as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') return record.text
    return ''
  }).join('')
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
