import { describe, expect, it } from 'vitest'
import { extractFunctionToolCalls, extractTextToolCalls, parseLastJsonValue, stripTextToolCallBlocks } from '../src/cli/json-output.js'

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

describe('text tool-call protocol', () => {
  it('extracts explicit OpenCode tool calls from final text', () => {
    const content = [
      '<opencode_tool_call>',
      '{"id":"call-read-1","name":"read","input":{"filePath":"package.json"}}',
      '</opencode_tool_call>',
    ].join('\n')

    expect(extractTextToolCalls(content)).toEqual([
      { id: 'call-read-1', name: 'read', input: '{"filePath":"package.json"}' },
    ])
  })

  it('supports tool/arguments aliases and deterministic ids', () => {
    const content = [
      '<opencode_tool_call>',
      '{"tool":"grep","arguments":{"pattern":"TODO","glob":"*.ts"}}',
      '</opencode_tool_call>',
    ].join('\n')

    expect(extractTextToolCalls(content)).toEqual([
      { id: 'trae-text-tool-0', name: 'grep', input: '{"pattern":"TODO","glob":"*.ts"}' },
    ])
  })

  it('extracts Trae XML tool_use blocks', () => {
    const content = [
      '<tool_use>',
      '<server_name>bash</server_name>',
      '<tool_name>bash</tool_name>',
      '<input>',
      '{"command": "ls -la /private/tmp"}',
      '</input>',
      '</tool_use>',
    ].join('\n')

    expect(extractTextToolCalls(content)).toEqual([
      { id: 'trae-text-tool-0', name: 'bash', input: '{"command":"ls -la /private/tmp"}' },
    ])
  })

  it('extracts Trae compact tool_call blocks', () => {
    const content = [
      '<tool_call>bash</arg_key>command:rtk ls -la',
      '---',
    ].join('\n')

    expect(extractTextToolCalls(content)).toEqual([
      { id: 'trae-text-tool-0', name: 'bash', input: '{"command":"rtk ls -la"}' },
    ])
  })

  it('extracts Trae JSON tool_call blocks with a missing opening tag', () => {
    const content = '{"name": "Bash", "arguments": {"command": "date +%s%N"}}\n</tool_call>'

    expect(extractTextToolCalls(content)).toEqual([
      { id: 'trae-text-tool-0', name: 'Bash', input: '{"command":"date +%s%N"}' },
    ])
  })

  it('extracts Trae arguments-only tool_call tails as bash calls', () => {
    const content = '"arguments": {"command": "date +%s%N"}}\n</tool_call>'

    expect(extractTextToolCalls(content)).toEqual([
      { id: 'trae-text-tool-0', name: 'bash', input: '{"command":"date +%s%N"}' },
    ])
  })

  it('strips tool call blocks before emitting assistant text', () => {
    const content = [
      'I need to inspect files.',
      '<opencode_tool_call>',
      '{"name":"glob","input":{"pattern":"**/package.json"}}',
      '</opencode_tool_call>',
    ].join('\n')

    expect(stripTextToolCallBlocks(content)).toBe('I need to inspect files.')
  })

  it('strips Trae XML tool_use blocks before emitting assistant text', () => {
    const content = [
      'I need to inspect files.',
      '<tool_use>',
      '<server_name>bash</server_name>',
      '<tool_name>bash</tool_name>',
      '<input>{"command": "ls -la"}</input>',
      '</tool_use>',
    ].join('\n')

    expect(stripTextToolCallBlocks(content)).toBe('I need to inspect files.')
  })

  it('strips Trae compact tool_call blocks before emitting assistant text', () => {
    const content = [
      'I need to inspect files.',
      '<tool_call>bash</arg_key>command:rtk ls -la',
      '---',
    ].join('\n')

    expect(stripTextToolCallBlocks(content)).toBe('I need to inspect files.')
  })
})
