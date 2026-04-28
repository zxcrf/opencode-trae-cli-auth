import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../src/prompt-builder.js'

describe('prompt builder', () => {
  it('serializes multi-turn text history with role tags', () => {
    const prompt = buildPrompt([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ] as any)

    expect(prompt).toContain('<system>\nBe concise.\n</system>')
    expect(prompt).toContain('<user>\nhello\n</user>')
    expect(prompt).toContain('<assistant>\nhi\n</assistant>')
    expect(prompt).toContain('<user>\ncontinue\n</user>')
  })

  it('omits prior tool calls and tool results by default', () => {
    const prompt = buildPrompt([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'read',
            input: { filePath: 'README.md' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'read',
            output: { type: 'text', value: 'contents' },
          },
        ],
      },
    ] as any)

    expect(prompt).not.toContain('<tool_call id="call-1" name="read">')
    expect(prompt).not.toContain('<tool_result id="call-1" name="read">')
  })

  it('can preserve prior tool calls and tool results when enabled', () => {
    const prompt = buildPrompt([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'read',
            input: { filePath: 'README.md' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'read',
            output: { type: 'text', value: 'contents' },
          },
        ],
      },
    ] as any, { includeToolHistory: true })

    expect(prompt).toContain('<tool_call id="call-1" name="read">')
    expect(prompt).toContain('"filePath":"README.md"')
    expect(prompt).toContain('<tool_result id="call-1" name="read">')
    expect(prompt).toContain('contents')
  })

  it('truncates oversized tool payloads when maxToolPayloadChars is set', () => {
    const prompt = buildPrompt([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'read',
            input: { filePath: 'README.md', payload: 'x'.repeat(1200) },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'read',
            output: { type: 'text', value: 'y'.repeat(1200) },
          },
        ],
      },
    ] as any, { includeToolHistory: true, maxToolPayloadChars: 200 })

    expect(prompt).toContain('[tool_call input truncated:')
    expect(prompt).toContain('[tool_result output truncated:')
  })

  it('represents unsupported media without throwing', () => {
    const prompt = buildPrompt([
      {
        role: 'user',
        content: [{ type: 'file', mediaType: 'image/png', data: 'abc' }],
      },
    ] as any)

    expect(prompt).toContain('[Unsupported file input omitted: image/png]')
  })

  it('truncates oversized prompt and keeps tail content', () => {
    const prompt = buildPrompt([
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(1000) + 'TAIL' }] },
    ] as any, { maxChars: 300 })

    expect(prompt).toContain('[Prompt truncated:')
    expect(prompt).toContain('TAIL')
  })

  it('keeps only recent non-system messages when maxMessages is set', () => {
    const prompt = buildPrompt([
      { role: 'system', content: 'Always concise.' },
      { role: 'user', content: [{ type: 'text', text: 'u1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'u2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
    ] as any, { maxMessages: 2 })

    expect(prompt).toContain('<system>\nAlways concise.\n</system>')
    expect(prompt).not.toContain('<user>\nu1\n</user>')
    expect(prompt).not.toContain('<assistant>\na1\n</assistant>')
    expect(prompt).toContain('<user>\nu2\n</user>')
    expect(prompt).toContain('<assistant>\na2\n</assistant>')
  })
})
