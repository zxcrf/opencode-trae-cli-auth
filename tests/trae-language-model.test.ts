import { describe, expect, it, vi, beforeEach } from 'vitest'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

const spawnMock = vi.fn()
const closeChild = (child: EventEmitter, code = 0) => setImmediate(() => child.emit('close', code))

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

describe('TraeLanguageModel', () => {
  beforeEach(() => {
    vi.resetModules()
    spawnMock.mockReset()
  })

  it('parses noisy json output into text deltas and usage', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('custom-model', { cliPath: '/usr/bin/traecli', queryTimeout: 55, extraArgs: ['--foo'], sessionId: 'test-session' })
    const streamPromise = model.doStream({ inputFormat: 'prompt', mode: { type: 'regular' }, prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] } as any)
    setImmediate(() => {
      stdout.write('warning: using fallback\n')
      stdout.write('{"message":{"content":[{"type":"text","text":"hello"},{"type":"text","text":" world"}]},"usage":{"input_tokens":3,"output_tokens":4}}')
      stderr.write('2026/04/24 WARN tenantsecurity: initial refresh failed\n')
      stderr.end()
      stdout.end()
      closeChild(child)
    })
    const { stream } = await streamPromise

    const parts: any[] = []
    for await (const part of stream as any) parts.push(part)

    const deltas = parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('')
    expect(deltas).toBe('hello world')
    const finish = parts.find((p) => p.type === 'finish')
    expect(finish.usage).toMatchObject({ inputTokens: 3, outputTokens: 4, totalTokens: 7 })
    const [, args] = spawnMock.mock.calls[0]
    expect(args).toEqual([
      '<user>\nping\n</user>',
      '-p',
      '--json',
      '--query-timeout',
      '55s',
      '--disallowed-tool',
      'Read',
      '--disallowed-tool',
      'Bash',
      '--disallowed-tool',
      'Edit',
      '--disallowed-tool',
      'Replace',
      '--disallowed-tool',
      'Write',
      '--disallowed-tool',
      'Glob',
      '--disallowed-tool',
      'Grep',
      '--disallowed-tool',
      'Task',
      '--config',
      'model.name=custom-model',
      '--foo',
    ])
  })

  it('maps Trae nested response_meta usage', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', { cliPath: '/usr/bin/traecli' })
    const streamPromise = model.doStream({ inputFormat: 'prompt', mode: { type: 'regular' }, prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] } as any)
    setImmediate(() => {
      stdout.write('{"message":{"content":"ok","response_meta":{"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}}}')
      stderr.end()
      stdout.end()
      closeChild(child)
    })
    const parts: any[] = []
    for await (const part of (await streamPromise).stream as any) parts.push(part)

    expect(parts.find((p) => p.type === 'finish').usage).toMatchObject({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })
  })

  it('doGenerate delegates to doStream', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', { cliPath: '/usr/bin/traecli' })
    const resultPromise = model.doGenerate({ inputFormat: 'prompt', mode: { type: 'regular' }, prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] } as any)
    setImmediate(() => {
      stdout.write('{"message":{"content":"done"},"usage":{}}')
      stderr.end()
      stdout.end()
      closeChild(child)
    })
    const result = await resultPromise

    expect(result.content[0]).toMatchObject({ type: 'text', text: 'done' })
    expect(result.finishReason).toBe('stop')
  })

  it('emits a complete OpenCode stream sequence for text output', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', { cliPath: '/usr/bin/traecli' })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)

    setImmediate(() => {
      stdout.end('{"message":{"content":"pong"},"usage":{"input_tokens":1,"output_tokens":1}}')
      stderr.end('')
      closeChild(child)
    })

    const parts: any[] = []
    for await (const part of (await streamPromise).stream as any) parts.push(part)

    expect(parts.map((p) => p.type)).toEqual([
      'stream-start',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ])
    expect(parts.at(-1).finishReason).toBe('stop')
  })

  it('emits error and finish without throwing from the stream producer', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', { cliPath: undefined })
    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)).stream as any) parts.push(part)

    expect(parts.map((p) => p.type)).toEqual(['stream-start', 'error', 'finish'])
    expect(parts.at(-1).finishReason).toBe('error')
  })
})
