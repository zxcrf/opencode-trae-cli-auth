import type { LanguageModelV2CallOptions } from '@ai-sdk/provider'

export function listToolNames(tools: LanguageModelV2CallOptions['tools']): string[] {
  const names: string[] = []
  for (const rec of iterToolDefinitions(tools)) {
    if (rec.type !== 'function') continue
    const name = String(rec.name ?? '').trim()
    if (name) names.push(name)
  }
  return [...new Set(names)]
}

export function getFirstUserText(options: LanguageModelV2CallOptions): string {
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

export function collectRecentToolResults(options: LanguageModelV2CallOptions): Array<{ id: string; toolName: string; output: string }> {
  const results: Array<{ id: string; toolName: string; output: string }> = []
  for (const message of options.prompt ?? []) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue
      const rec = part as Record<string, unknown>
      if (rec.type !== 'tool-result') continue
      const id = String(rec.toolCallId ?? '')
      if (!id) continue
      results.push({
        id,
        toolName: normalizeToolName(String(rec.toolName ?? '')),
        output: serializeToolOutput(rec.output),
      })
    }
  }
  return results
}

export function parseJsonObjectLenient(text: string): Record<string, unknown> | undefined {
  const direct = parseJsonObject(text.trim())
  if (direct) return direct
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]
  if (fenced) {
    const parsed = parseJsonObject(fenced.trim())
    if (parsed) return parsed
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return parseJsonObject(text.slice(start, end + 1).trim())
  }
  return undefined
}

export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

export function clipText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text
}

export function serializeToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (!output || typeof output !== 'object') return String(output ?? '')
  const rec = output as Record<string, unknown>
  if (rec.type === 'text' && typeof rec.value === 'string') return rec.value
  if (rec.type === 'json') return JSON.stringify(rec.value)
  return JSON.stringify(output)
}

export function normalizeToolName(name: string): string {
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

export function iterToolDefinitions(tools: LanguageModelV2CallOptions['tools']): Record<string, unknown>[] {
  if (!tools) return []
  if (Array.isArray(tools)) {
    return tools.filter((tool): tool is Record<string, unknown> => !!tool && typeof tool === 'object')
  }
  if (typeof tools !== 'object') return []
  return Object.entries(tools as Record<string, unknown>).flatMap(([name, tool]) => {
    if (!tool || typeof tool !== 'object') return []
    const rec = tool as Record<string, unknown>
    return [{ ...rec, name: rec.name ?? name }]
  })
}
