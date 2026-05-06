import type { LanguageModelV2CallOptions, LanguageModelV2Usage } from '@ai-sdk/provider'

import { buildPromptFromOptions } from './prompt-builder.js'
import { contentToText } from './cli/text-content.js'
import { mapUsage } from './cli/usage.js'

export type OpenAITransportOptions = {
  baseURL: string
  apiKey: string
  modelName?: string
  headers?: Record<string, string>
  abortSignal?: AbortSignal
}

export type OpenAIStreamTextDelta = {
  type: 'text-delta'
  delta: string
}

export type OpenAIStreamToolDelta = {
  type: 'tool-call-delta'
  index: number
  id?: string
  name?: string
  argumentsDelta?: string
}

export type OpenAIStreamFinish = {
  type: 'finish'
  finishReason: 'stop' | 'tool-calls' | 'error'
  usage?: LanguageModelV2Usage
}

export type OpenAIStreamEvent = OpenAIStreamTextDelta | OpenAIStreamToolDelta | OpenAIStreamFinish

export async function* streamOpenAIChatCompletions(
  options: OpenAITransportOptions,
  callOptions: LanguageModelV2CallOptions,
): AsyncIterable<OpenAIStreamEvent> {
  const response = await fetch(joinBaseURL(options.baseURL, '/chat/completions'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(options.headers ?? {}),
    },
    body: JSON.stringify({
      model: options.modelName,
      stream: true,
      messages: buildOpenAIMessages(callOptions),
      ...buildOpenAITools(callOptions),
    }),
    signal: options.abortSignal,
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`OpenAI-compatible request failed with ${response.status}${body ? `: ${body}` : ''}`)
  }

  if (!response.body) throw new Error('OpenAI-compatible response did not include a body')

  let finalFinishReason: OpenAIStreamFinish['finishReason'] = 'stop'
  let finalUsage: LanguageModelV2Usage | undefined
  for await (const value of parseSseJson(response.body)) {
    const usage = mapOpenAIUsage(value)
    if (usage) finalUsage = usage

    const choices = Array.isArray(value.choices) ? value.choices : []
    for (const choice of choices) {
      if (!isRecord(choice)) continue
      const delta = isRecord(choice.delta) ? choice.delta : {}
      const content = typeof delta.content === 'string' ? delta.content : ''
      if (content) yield { type: 'text-delta', delta: content }

      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
      for (const rawToolCall of toolCalls) {
        if (!isRecord(rawToolCall)) continue
        const fn = isRecord(rawToolCall.function) ? rawToolCall.function : {}
        yield {
          type: 'tool-call-delta',
          index: typeof rawToolCall.index === 'number' ? rawToolCall.index : 0,
          id: typeof rawToolCall.id === 'string' ? rawToolCall.id : undefined,
          name: typeof fn.name === 'string' ? fn.name : undefined,
          argumentsDelta: typeof fn.arguments === 'string' ? fn.arguments : undefined,
        }
      }

      const reason = typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined
      if (reason === 'tool_calls' || reason === 'function_call') finalFinishReason = 'tool-calls'
      else if (reason === 'stop') finalFinishReason = 'stop'
      else if (reason === 'error') finalFinishReason = 'error'
    }
  }

  yield { type: 'finish', finishReason: finalFinishReason, usage: finalUsage }
}

function buildOpenAIMessages(options: LanguageModelV2CallOptions): Array<{ role: string; content: string }> {
  const prompt = options.prompt ?? []
  const messages: Array<{ role: string; content: string }> = []
  for (const message of prompt) {
    if (message.role === 'system') {
      if (typeof message.content === 'string' && message.content.trim()) {
        messages.push({ role: 'system', content: message.content })
      }
      continue
    }
    if (message.role === 'user') {
      const content = contentToText(message.content).join('')
      if (content) messages.push({ role: 'user', content })
      continue
    }
    if (message.role === 'assistant') {
      const content = contentToText(message.content).join('')
      if (content) messages.push({ role: 'assistant', content })
      continue
    }
    if (message.role === 'tool') {
      const content = buildPromptFromOptions({ ...options, prompt: [message] })
      if (content) messages.push({ role: 'user', content })
    }
  }
  if (messages.length === 0) {
    messages.push({ role: 'user', content: buildPromptFromOptions(options) })
  }
  return messages
}

function buildOpenAITools(options: LanguageModelV2CallOptions): { tools?: unknown[]; tool_choice?: 'auto' } {
  const tools = iterToolDefinitions(options.tools)
    .filter((tool) => tool.type === 'function')
    .map((tool) => ({
      type: 'function',
      function: {
        name: String(tool.name),
        description: typeof tool.description === 'string' ? tool.description : undefined,
        parameters: normalizeInputSchema(tool.inputSchema),
      },
    }))
  return tools.length > 0 ? { tools, tool_choice: 'auto' } : {}
}

function normalizeInputSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} }
  const rec = schema as Record<string, unknown>
  if (rec.schema && typeof rec.schema === 'object') return rec.schema
  return schema
}

async function* parseSseJson(body: ReadableStream<Uint8Array>): AsyncIterable<Record<string, unknown>> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const parsed = parseSseFrame(frame)
      if (parsed) yield parsed
    }
  }
  buffer += decoder.decode()
  const parsed = parseSseFrame(buffer)
  if (parsed) yield parsed
}

function parseSseFrame(frame: string): Record<string, unknown> | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n')
    .trim()
  if (!data || data === '[DONE]') return undefined
  const parsed = JSON.parse(data)
  return isRecord(parsed) ? parsed : undefined
}

function mapOpenAIUsage(value: Record<string, unknown>): LanguageModelV2Usage | undefined {
  if (!isRecord(value.usage)) return undefined
  return mapUsage(value.usage as Record<string, unknown>)
}

function joinBaseURL(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, '')}${path}`
}

function iterToolDefinitions(tools: LanguageModelV2CallOptions['tools']): Record<string, unknown>[] {
  if (!tools) return []
  if (Array.isArray(tools)) {
    return tools.filter((tool): tool is Record<string, unknown> => !!tool && typeof tool === 'object')
  }
  if (typeof tools !== 'object') return []
  return Object.entries(tools as Record<string, unknown>).flatMap(([name, tool]) => {
    if (!tool || typeof tool !== 'object') return []
    const rec = tool as Record<string, unknown>
    return [{ ...rec, name: typeof rec.name === 'string' && rec.name ? rec.name : name }]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
