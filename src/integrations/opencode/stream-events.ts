import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { normalizeToolName } from '../../agent-loop/prompt-utils.js'

export type FunctionToolCall = {
  id: string
  name: string
  input: string
}

export function emitTextDeltas(
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>,
  id: string,
  deltas: string[],
): boolean {
  if (deltas.length === 0) return false
  controller.enqueue({ type: 'text-start', id })
  for (const delta of deltas) {
    controller.enqueue({ type: 'text-delta', id, delta })
  }
  controller.enqueue({ type: 'text-end', id })
  return true
}

export function emitToolCalls(
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>,
  toolCalls: FunctionToolCall[],
  normalizeInput: (toolName: string, input: string) => string,
  shouldBlock?: (toolName: string, input: string) => boolean,
): number {
  let emitted = 0
  for (const call of toolCalls) {
    const toolName = normalizeToolName(call.name)
    const normalizedInput = normalizeInput(toolName, call.input)
    if (shouldBlock?.(toolName, normalizedInput)) continue
    controller.enqueue({ type: 'tool-input-start', id: call.id, toolName } as LanguageModelV2StreamPart)
    controller.enqueue({ type: 'tool-input-delta', id: call.id, delta: normalizedInput } as LanguageModelV2StreamPart)
    controller.enqueue({ type: 'tool-input-end', id: call.id } as LanguageModelV2StreamPart)
    controller.enqueue({
      type: 'tool-call',
      toolCallId: call.id,
      toolName,
      input: normalizedInput,
    } as LanguageModelV2StreamPart)
    emitted += 1
  }
  return emitted
}
