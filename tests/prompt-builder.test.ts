import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../src/prompt-builder.js'

describe('prompt builder', () => {
  it('serializes multi-turn text history as plain transcript blocks', () => {
    const prompt = buildPrompt([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ] as any)

    expect(prompt).toContain('System:\nBe concise.')
    expect(prompt).toContain('User:\nhello')
    expect(prompt).toContain('Assistant:\nhi')
    expect(prompt).toContain('User:\ncontinue')
  })

  it('prepends system preamble when provided', () => {
    const prompt = buildPrompt([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ] as any, { systemPreamble: 'Coding runtime policy' })

    expect(prompt.startsWith('System:\nCoding runtime policy')).toBe(true)
    expect(prompt).toContain('User:\nhello')
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

    expect(prompt).not.toContain('Tool call [call-1] read:')
    expect(prompt).not.toContain('Tool result [call-1] read:')
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

    expect(prompt).toContain('Tool call [call-1] read:')
    expect(prompt).toContain('"filePath":"README.md"')
    expect(prompt).toContain('Tool result [call-1] read:')
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

  it('keeps task reminder at the prompt tail after oversized tool history', () => {
    const prompt = buildPrompt([
      { role: 'user', content: [{ type: 'text', text: 'read manifests and summarize risks' }] },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'read',
            output: { type: 'text', value: 'x'.repeat(1000) },
          },
        ],
      },
    ] as any, {
      includeToolHistory: true,
      maxChars: 300,
      taskReminder: 'read manifests and summarize risks',
    })

    expect(prompt).toContain('[Prompt truncated:')
    expect(prompt).toContain('Current task reminder:')
    expect(prompt).toContain('read manifests and summarize risks')
  })

  it('keeps only recent non-system messages when maxMessages is set', () => {
    const prompt = buildPrompt([
      { role: 'system', content: 'Always concise.' },
      { role: 'user', content: [{ type: 'text', text: 'u1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'u2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
    ] as any, { maxMessages: 2 })

    expect(prompt).toContain('System:\nAlways concise.')
    expect(prompt).not.toContain('User:\nu1')
    expect(prompt).not.toContain('Assistant:\na1')
    expect(prompt).toContain('User:\nu2')
    expect(prompt).toContain('Assistant:\na2')
  })
})
