import type { LanguageModelV2Usage } from '@ai-sdk/provider'

export function mapUsage(usage: Record<string, unknown> | undefined): LanguageModelV2Usage {
  const inputTokens = pickNumber(usage?.input_tokens ?? usage?.inputTokens ?? usage?.prompt_tokens)
  const outputTokens = pickNumber(usage?.output_tokens ?? usage?.outputTokens ?? usage?.completion_tokens)
  const totalTokens = pickNumber(usage?.total_tokens ?? usage?.totalTokens) ??
    (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined)
  return { inputTokens, outputTokens, totalTokens }
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
