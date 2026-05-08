import { describe, expect, it } from 'vitest'
import type { LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { buildCompletionJudgePrompt, parseCompletionJudgeDecision, shouldRetryStoppedActionTurn } from '../src/agent-loop/completion-judge.js'
import { applyToolDelta } from '../src/agent-loop/tool-delta.js'
import { emitToolCalls } from '../src/integrations/opencode/stream-events.js'

describe('agent loop primitives', () => {
  it('builds a completion judge prompt from user goal and recent tool results', () => {
    const prompt = buildCompletionJudgePrompt({
      options: {
        tools: [{ type: 'function', name: 'bash', inputSchema: { type: 'object' } }],
        prompt: [
          { role: 'user', content: [{ type: 'text', text: '升级插件' }] },
          {
            role: 'tool',
            content: [{
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'bash',
              output: 'installed version 0.9.12, latest 1.0.7',
            }],
          },
        ],
      } as LanguageModelV2CallOptions,
      assistantText: '先确认当前版本。',
    })

    const judgeInput = prompt.prompt?.at(1)
    expect(prompt.tools).toBeUndefined()
    expect(JSON.stringify(judgeInput)).toContain('升级插件')
    expect(JSON.stringify(judgeInput)).toContain('bash[call-1]')
    expect(JSON.stringify(judgeInput)).toContain('先确认当前版本')
  })

  it('parses completion judge JSON from fenced model output', () => {
    expect(parseCompletionJudgeDecision('```json\n{"status":"incomplete","next_expectation":"tool_call"}\n```')).toEqual({
      status: 'incomplete',
      nextExpectation: 'tool_call',
    })
  })

  it('retries stopped incomplete turns but not completed turns', () => {
    const options = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: '修复 bug' }] }],
    } as LanguageModelV2CallOptions

    expect(shouldRetryStoppedActionTurn({
      options,
      text: '我将检查文件。',
      finishReason: 'stop',
      sawOutput: true,
      toolCalls: 0,
      judgeDecision: { status: 'incomplete' },
    }).shouldRetry).toBe(true)

    expect(shouldRetryStoppedActionTurn({
      options,
      text: '已经修复并验证。',
      finishReason: 'stop',
      sawOutput: true,
      toolCalls: 0,
      judgeDecision: { status: 'complete' },
    }).shouldRetry).toBe(false)
  })

  it('accumulates streaming tool-call deltas', () => {
    const calls = new Map<number, { id: string; name: string; input: string }>()
    applyToolDelta(calls, { index: 0, id: 'call-1', name: 'bash', argumentsDelta: '{"command":' })
    applyToolDelta(calls, { index: 0, argumentsDelta: '"ls"}' })

    expect(calls.get(0)).toEqual({
      id: 'call-1',
      name: 'bash',
      input: '{"command":"ls"}',
    })
  })

  it('emits OpenCode tool-call stream parts with normalized inputs', () => {
    const parts: LanguageModelV2StreamPart[] = []
    const controller = {
      enqueue: (part: LanguageModelV2StreamPart) => parts.push(part),
    } as ReadableStreamDefaultController<LanguageModelV2StreamPart>

    const emitted = emitToolCalls(
      controller,
      [{ id: 'call-1', name: 'runbash', input: '{"cmd":"ls"}' }],
      (_toolName, input) => input.replace('"cmd"', '"command"'),
    )

    expect(emitted).toBe(1)
    expect(parts.map((part) => part.type)).toEqual(['tool-input-start', 'tool-input-delta', 'tool-input-end', 'tool-call'])
    expect(parts.at(-1)).toMatchObject({
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'bash',
      input: '{"command":"ls"}',
    })
  })
})
