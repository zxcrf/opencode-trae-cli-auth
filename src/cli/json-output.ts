export type TraeCliResult = {
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
