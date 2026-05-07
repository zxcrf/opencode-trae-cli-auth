import type { LanguageModelV2CallOptions, LanguageModelV2Usage } from '@ai-sdk/provider'
import { randomUUID } from 'node:crypto'

import { buildPromptFromOptions, buildToolHistoryPrompt } from './prompt-builder.js'
import { contentToText } from './cli/text-content.js'
import { mapUsage } from './cli/usage.js'
import { resolveTraeAuthToken } from './trae-auth.js'
import { extractTextToolCalls, stripTextToolCallBlocks } from './cli/json-output.js'

export type TraeRawTransportOptions = {
  baseURL: string
  apiKey?: string
  pat?: string
  modelName?: string
  configName?: string
  rawModelName?: string
  displayName?: string
  headers?: Record<string, string>
  sessionId?: string
  abortSignal?: AbortSignal
}

export type TraeRawStreamTextDelta = {
  type: 'text-delta'
  delta: string
}

export type TraeRawStreamToolDelta = {
  type: 'tool-call-delta'
  index: number
  id?: string
  name?: string
  argumentsDelta?: string
}

export type TraeRawStreamFinish = {
  type: 'finish'
  finishReason: 'stop' | 'tool-calls' | 'error'
  usage?: LanguageModelV2Usage
}

export type TraeRawStreamEvent = TraeRawStreamTextDelta | TraeRawStreamToolDelta | TraeRawStreamFinish

export async function* streamTraeRawChat(
  options: TraeRawTransportOptions,
  callOptions: LanguageModelV2CallOptions,
): AsyncIterable<TraeRawStreamEvent> {
  const baseURL = stripTrailingSlash(options.baseURL)
  const model = resolveTraeRawModel(options)
  const sessionId = options.sessionId ?? randomUUID()
  const auth = await resolveTraeAuthToken({
    baseURL,
    pat: options.pat,
    rawApiKey: options.apiKey,
    abortSignal: options.abortSignal,
  })
  const response = await fetch(`${baseURL}/api/ide/v2/llm_raw_chat`, {
    method: 'POST',
    headers: {
      Authorization: auth.authorization,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-App-Id': '7b3f9dc2-8a4e-5c6d-2f1b-9e4a3c5b7df0',
      'X-Ide-Version-Code': '20260206',
      'X-Ide-Function': 'chat',
      Extra: JSON.stringify({
        agent_loop_id: sessionId,
        api_host: baseURL,
        api_key: auth.token,
        base_url: `${baseURL}/trae-cli/api/v1/llm/proxy`,
        config_name: model.configName,
        config_source: 1,
        display_name: model.displayName,
        model_name: model.rawModelName,
        real_api_key: '',
        real_base_url: '',
        session_id: sessionId,
        user_prompt_submit_id: sessionId,
      }),
      ...(options.headers ?? {}),
    },
    body: JSON.stringify({
      config_name: model.configName,
      conversation_id: sessionId,
      messages: buildTraeRawMessages(callOptions),
      model_name: model.rawModelName,
      session_id: sessionId,
      stream: true,
    }),
    signal: options.abortSignal,
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Trae raw chat request failed with ${response.status}${body ? `: ${body}` : ''}`)
  }

  if (!response.body) throw new Error('Trae raw chat response did not include a body')

  let emittedText = ''
  let finalUsage: LanguageModelV2Usage | undefined
  let finishReason: TraeRawStreamFinish['finishReason'] = 'stop'
  let pendingToolText = ''
  let emittedExternalToolCall = false
  const mapTextToolCall = (toolCall: { id: string; name: string; input: string }): TraeRawStreamToolDelta => {
    finishReason = 'tool-calls'
    return {
      type: 'tool-call-delta',
      index: 0,
      id: toolCall.id,
      name: toolCall.name,
      argumentsDelta: toolCall.input,
    }
  }

  for await (const frame of parseSseFrames(response.body)) {
    if (frame.event === 'error') {
      throw new Error(formatTraeRawError(frame.data))
    }
    if (frame.event === 'token_usage' && frame.data) {
      finalUsage = mapUsage(frame.data)
      continue
    }
    if (frame.event !== 'output' || !frame.data) continue
    if (emittedExternalToolCall) continue

    const responseText = typeof frame.data.response === 'string' ? frame.data.response : ''
    const delta = nextTextDelta(emittedText, responseText)
    if (delta) {
      const textDelta = consumeTextDeltaForToolCalls(delta, mapTextToolCall)
      pendingToolText = textDelta.pendingToolText
      for (const toolDelta of textDelta.toolDeltas) yield toolDelta
      if (textDelta.toolDeltas.length > 0) emittedExternalToolCall = true
      if (textDelta.text) yield { type: 'text-delta', delta: textDelta.text }
      emittedText = responseText
    }

    if (emittedExternalToolCall) continue

    const toolCalls = Array.isArray(frame.data.tool_calls) ? frame.data.tool_calls : []
    for (const toolCall of toolCalls) {
      const delta = normalizeTraeRawToolCallDelta(toolCall)
      if (delta) {
        finishReason = 'tool-calls'
        yield delta
      }
    }
  }

  if (!emittedExternalToolCall && pendingToolText) {
    const textDelta = consumeTextDeltaForToolCalls('', mapTextToolCall)
    pendingToolText = textDelta.pendingToolText
    for (const toolDelta of textDelta.toolDeltas) yield toolDelta
    if (textDelta.toolDeltas.length > 0) emittedExternalToolCall = true
    if (textDelta.text) yield { type: 'text-delta', delta: textDelta.text }
  }

  yield { type: 'finish', finishReason, usage: finalUsage }

  function consumeTextDeltaForToolCalls(
    delta: string,
    mapToolCall: (toolCall: { id: string; name: string; input: string }) => TraeRawStreamToolDelta,
  ): { text: string; pendingToolText: string; toolDeltas: TraeRawStreamToolDelta[] } {
    const combined = pendingToolText + delta
    const toolStart = findToolBlockStart(combined)
    if (toolStart < 0) {
      const partialStart = findPartialToolBlockStart(combined)
      if (partialStart >= 0) {
        return {
          text: combined.slice(0, partialStart),
          pendingToolText: combined.slice(partialStart),
          toolDeltas: [],
        }
      }
      return { text: combined, pendingToolText: '', toolDeltas: [] }
    }

    const toolEnd = findToolBlockEnd(combined, toolStart)
    if (toolEnd < 0) {
      return {
        text: toolStart > 0 ? combined.slice(0, toolStart) : '',
        pendingToolText: combined.slice(toolStart),
        toolDeltas: [],
      }
    }

    const complete = combined.slice(toolStart, toolEnd)
    const toolDeltas = extractTextToolCalls(complete).map(mapToolCall)
    const before = combined.slice(0, toolStart)
    const after = combined.slice(toolEnd)
    const visibleText = `${before}${stripTextToolCallBlocks(after)}`
    return {
      text: visibleText,
      pendingToolText: '',
      toolDeltas,
    }
  }
}

function findPartialToolBlockStart(text: string): number {
  const tags = ['<opencode_tool_call>', '<tool_use>', '<tool_call>', '<tool_call ', '<tool>', '<tool_cell', '<invoke>', '</invoke>']
  const maxTagLength = Math.max(...tags.map((tag) => tag.length))
  for (let start = Math.max(0, text.length - maxTagLength + 1); start < text.length; start += 1) {
    const suffix = text.slice(start)
    if (tags.some((tag) => tag.startsWith(suffix))) return start
  }
  return -1
}

function findToolBlockStart(text: string): number {
  const xmlStart = text.indexOf('<tool_use>')
  const opencodeStart = text.indexOf('<opencode_tool_call>')
  const compactStart = text.indexOf('<tool_call>')
  const namedStart = text.indexOf('<tool_call ')
  const kimiStart = text.indexOf('<tool>')
  const toolCellStart = text.indexOf('<tool_cell')
  const invokeStart = text.indexOf('<invoke>')
  const brokenInvokeStart = text.indexOf('</invoke>')
  return minFound(opencodeStart, xmlStart, compactStart, namedStart, kimiStart, toolCellStart, invokeStart, brokenInvokeStart)
}

function findToolBlockEnd(text: string, start: number): number {
  if (text.startsWith('<opencode_tool_call>', start)) {
    const end = text.indexOf('</opencode_tool_call>', start)
    return end < 0 ? -1 : end + '</opencode_tool_call>'.length
  }
  if (text.startsWith('</invoke>', start)) {
    const end = text.indexOf('</invoke>', start + '</invoke>'.length)
    return end < 0 ? -1 : end + '</invoke>'.length
  }
  if (text.startsWith('<invoke>', start)) {
    const end = text.indexOf('</invoke>', start)
    return end < 0 ? -1 : end + '</invoke>'.length
  }
  if (text.startsWith('<tool_call ', start)) {
    const end = text.indexOf('</tool_call>', start)
    return end < 0 ? -1 : end + '</tool_call>'.length
  }
  if (text.startsWith('<tool_use>', start)) {
    const end = text.indexOf('</tool_use>', start)
    return end < 0 ? -1 : end + '</tool_use>'.length
  }
  if (text.startsWith('<tool>', start)) {
    const end = text.indexOf('</parameter>', start)
    return end < 0 ? -1 : end + '</parameter>'.length
  }
  if (text.startsWith('<tool_cell', start)) {
    const end = text.indexOf('</tool_cell>', start)
    return end < 0 ? -1 : end + '</tool_cell>'.length
  }
  const separator = text.indexOf('\n---', start)
  if (separator >= 0) return separator + '\n---'.length
  const nextTool = text.indexOf('\n<tool_call>', start + '<tool_call>'.length)
  if (nextTool >= 0) return nextTool
  return text.length
}

function minFound(...values: number[]): number {
  const found = values.filter((value) => value >= 0)
  return found.length ? Math.min(...found) : -1
}

function formatTraeRawError(data: Record<string, unknown> | undefined): string {
  if (!data) return 'Trae raw chat stream returned an error event'
  const message = typeof data.message === 'string' ? data.message : undefined
  const error = typeof data.error === 'string' ? data.error : undefined
  const code = typeof data.code === 'string' || typeof data.code === 'number' ? String(data.code) : undefined
  return [
    'Trae raw chat stream returned an error event',
    code ? `code=${code}` : undefined,
    message ?? error,
  ].filter(Boolean).join(': ')
}

function buildTraeRawMessages(options: LanguageModelV2CallOptions): Array<{ role: string; content: Array<{ type: 'text'; text: string }> }> {
  const messages = (options.prompt ?? []).flatMap((message) => {
    if (message.role === 'system') {
      return typeof message.content === 'string' && message.content.trim()
        ? [{ role: 'system', content: [{ type: 'text' as const, text: message.content }] }]
        : []
    }
    if (message.role === 'user' || message.role === 'assistant') {
      const text = contentToText(message.content).join('')
      return text ? [{ role: message.role, content: [{ type: 'text' as const, text }] }] : []
    }
    if (message.role === 'tool') {
      const text = buildToolHistoryPrompt({ ...options, prompt: [message] })
      return text ? [{ role: 'user', content: [{ type: 'text' as const, text }] }] : []
    }
    return []
  })
  if (messages.length > 0) return messages
  return [{ role: 'user', content: [{ type: 'text', text: buildPromptFromOptions(options) }] }]
}

function normalizeTraeRawToolCallDelta(value: unknown): TraeRawStreamToolDelta | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const fn = record.function && typeof record.function === 'object' && !Array.isArray(record.function)
    ? record.function as Record<string, unknown>
    : record
  const name = typeof fn.name === 'string' ? fn.name : typeof record.name === 'string' ? record.name : undefined
  const args = typeof fn.arguments === 'string'
    ? fn.arguments
    : typeof record.arguments === 'string'
      ? record.arguments
      : typeof record.input === 'string'
        ? record.input
        : undefined
  if (!name && !args) return undefined
  return {
    type: 'tool-call-delta',
    index: typeof record.index === 'number' ? record.index : 0,
    id: typeof record.id === 'string' ? record.id : typeof record.tool_call_id === 'string' ? record.tool_call_id : undefined,
    name,
    argumentsDelta: args,
  }
}

async function* parseSseFrames(body: ReadableStream<Uint8Array>): AsyncIterable<{ event?: string; data?: Record<string, unknown> }> {
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

function parseSseFrame(frame: string): { event?: string; data?: Record<string, unknown> } | undefined {
  let event: string | undefined
  const data = frame
    .split(/\r?\n/)
    .flatMap((line) => {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim()
        return []
      }
      return line.startsWith('data:') ? [line.slice('data:'.length).trimStart()] : []
    })
    .join('\n')
    .trim()
  if (!data || data === '[DONE]') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? { event, data: parsed as Record<string, unknown> }
    : undefined
}

function resolveTraeRawModel(options: TraeRawTransportOptions): { configName: string; rawModelName: string; displayName: string } {
  const displayName = options.displayName ?? options.modelName ?? 'GLM-5.1'
  const configName = options.configName ?? normalizeConfigName(options.modelName ?? displayName)
  return {
    configName,
    rawModelName: options.rawModelName ?? defaultRawModelName(configName),
    displayName,
  }
}

const KNOWN_RAW_MODEL_CONFIGS: Record<string, { configName: string; rawModelName: string; displayName?: string }> = {
  'coding': { configName: 'glm-5.1', rawModelName: 'glm-5__v2', displayName: 'GLM-5.1' },
  'glm-5.1': { configName: 'glm-5.1', rawModelName: 'glm-5__v2', displayName: 'GLM-5.1' },
  'kimi-k2.6': { configName: 'kimi-k2.6', rawModelName: 'kimi-k2.6__v2', displayName: 'Kimi-K2.6' },
  'deepseek-v4-pro': { configName: 'deepseek-V4-Pro', rawModelName: 'deepseek-V4-Pro__v2', displayName: 'DeepSeek-V4-Pro' },
}

function normalizeConfigName(name: string): string {
  const raw = name.replace(/^trae\//i, '').trim()
  const normalized = raw.toLowerCase()
  const known = KNOWN_RAW_MODEL_CONFIGS[normalized]
  if (known) return known.configName
  return raw || 'GLM-5.1'
}

function defaultRawModelName(configName: string): string {
  if (configName === 'glm-5.1') return 'glm-5__v2'
  if (configName === 'kimi-k2.6') return 'kimi-k2.6__v2'
  if (configName === 'deepseek-V4-Pro') return 'deepseek-V4-Pro__v2'
  return configName
}

function nextTextDelta(previous: string, next: string): string {
  if (!next) return ''
  if (next.startsWith(previous)) return next.slice(previous.length)
  return next
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
