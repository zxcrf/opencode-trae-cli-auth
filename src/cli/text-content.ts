export function contentToText(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const chunks: string[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      chunks.push(item)
      continue
    }
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') chunks.push(record.text)
    if (record.type === 'output_text' && typeof record.text === 'string') chunks.push(record.text)
  }
  return chunks
}
