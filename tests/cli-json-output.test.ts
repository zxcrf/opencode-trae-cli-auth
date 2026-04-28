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
      message: { content: 'ok' },
    }))

    expect(extractFunctionToolCalls(parsed)).toEqual([
      { id: 'call-1', name: 'read', input: '{"path":"README.md"}' },
    ])
  })
})
