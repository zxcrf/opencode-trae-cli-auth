export function contentToText(content: unknown): string[] {
  if (typeof content === 'string') return [stripThinkTags(content)].filter(Boolean)
  if (!Array.isArray(content)) return []
  const chunks: string[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      const cleaned = stripThinkTags(item)
      if (cleaned) chunks.push(cleaned)
      continue
    }
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      const cleaned = stripThinkTags(record.text)
      if (cleaned) chunks.push(cleaned)
    }
    if (record.type === 'output_text' && typeof record.text === 'string') {
      const cleaned = stripThinkTags(record.text)
      if (cleaned) chunks.push(cleaned)
    }
  }
  return chunks
}

function stripThinkTags(text: string): string {
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think\b[^>]*>/gi, '')
}
