import { describe, expect, it } from 'vitest'
import { extractFunctionToolCalls, parseLastJsonValue } from '../src/cli/json-output.js'

describe('parseLastJsonValue', () => {
  it('parses the last response object from noisy output', () => {
    const parsed = parseLastJsonValue('warn\n{"ignored":true}\n{"message":{"content":"ok"}}\nnoise')
    expect(parsed).toEqual({ message: { content: 'ok' } })
  })

  it('throws a short diagnostic when no json response exists', () => {
    expect(() => parseLastJsonValue('warning only')).toThrow(/Unable to parse traecli JSON output/)
  })

  it('extracts assistant function tool calls from agent_states', () => {
    const parsed = parseLastJsonValue(JSON.stringify({
      agent_states: [
        {
          messages: [
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'read', arguments: '{"path":"README.md"}' },
                },
              ],
            },
          ],
        },
      ],
      message: { content: '' },
    }))

    expect(extractFunctionToolCalls(parsed)).toEqual([
      { id: 'call-1', name: 'read', input: '{"path":"README.md"}' },
    ])
  })

  it('does not replay stale tool calls when final assistant turn is plain text', () => {
    const parsed = parseLastJsonValue(JSON.stringify({
      agent_states: [
        {
          messages: [
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'read', arguments: '{"path":"README.md"}' },
                },
              ],
            },
            {
              role: 'assistant',
              content: 'final answer',
            },
          ],
        },
      ],
      message: { content: 'final answer' },
    }))

    expect(extractFunctionToolCalls(parsed)).toEqual([])
  })

  it('does not replay agent_state tool calls when top-level message is final text', () => {
    const parsed = parseLastJsonValue(JSON.stringify({
      agent_states: [
        {
          messages: [
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'read', arguments: '{"path":"README.md"}' },
                },
              ],
            },
          ],
        },
      ],
      message: {
        role: 'assistant',
        content: 'final answer',
        response_meta: { finish_reason: 'stop' },
      },
    }))

    expect(extractFunctionToolCalls(parsed)).toEqual([])
  })

  it('uses only the last assistant tool-call turn', () => {
    const parsed = parseLastJsonValue(JSON.stringify({
      agent_states: [
        {
          messages: [
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call-old',
                  type: 'function',
                  function: { name: 'read', arguments: '{"path":"README.md"}' },
                },
              ],
            },
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call-new',
                  type: 'function',
                  function: { name: 'glob', arguments: '{"pattern":"src/**/*"}' },
                },
              ],
            },
          ],
        },
      ],
      message: { content: '' },
    }))

    expect(extractFunctionToolCalls(parsed)).toEqual([
      { id: 'call-new', name: 'glob', input: '{"pattern":"src/**/*"}' },
    ])
  })
})
