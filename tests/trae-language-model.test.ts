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
    expect(parts.find((p) => p.type === 'response-metadata')).toMatchObject({ modelId: 'custom-model' })
    const finish = parts.find((p) => p.type === 'finish')
    expect(finish.usage).toMatchObject({ inputTokens: 3, outputTokens: 4, totalTokens: 7 })
    const [, args] = spawnMock.mock.calls[0]
    expect(args).toEqual([
      'User:\nping',
      '-p',
      '--json',
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
      '--session-id',
      'test-session',
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

  it('maps profile alias model ids to real Trae model names', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('fast', { cliPath: '/usr/bin/traecli' })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)

    setImmediate(() => {
      stdout.end('{"message":{"content":"ok"}}')
      stderr.end('')
      closeChild(child)
    })
    for await (const _ of (await streamPromise).stream as any) {}

    const [, args] = spawnMock.mock.calls[0]
    expect(args).toContain('--config')
    expect(args).toContain('model.name=MiniMax-M2.7')
  })

  it('does not force model.name for coding alias in text-first mode', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', { cliPath: '/usr/bin/traecli', enableToolCalling: false, enforceTextOnly: true })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)

    setImmediate(() => {
      stdout.end('{"message":{"content":"ok"}}')
      stderr.end('')
      closeChild(child)
    })
    for await (const _ of (await streamPromise).stream as any) {}

    const [, args] = spawnMock.mock.calls[0]
    expect(args).not.toContain('--config')
    expect(args).not.toContain('model.name=GLM-5.1')
  })

  it('does not force model.name for trae/coding in text-first mode', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('trae/coding', { cliPath: '/usr/bin/traecli', enableToolCalling: false, enforceTextOnly: true })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)

    setImmediate(() => {
      stdout.end('{"message":{"content":"ok"}}')
      stderr.end('')
      closeChild(child)
    })
    for await (const _ of (await streamPromise).stream as any) {}

    const [, args] = spawnMock.mock.calls[0]
    expect(args).not.toContain('--config')
    expect(args).not.toContain('model.name=GLM-5.1')
  })

  it('omits tool history from prompt by default', async () => {
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
      prompt: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: '1', toolName: 'read', input: { path: 'a' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: '1', toolName: 'read', output: { type: 'text', value: 'ok' } }] },
        { role: 'user', content: [{ type: 'text', text: 'ping' }] },
      ],
    } as any)

    setImmediate(() => {
      stdout.end('{"message":{"content":"ok"}}')
      stderr.end('')
      closeChild(child)
    })
    for await (const _ of (await streamPromise).stream as any) {}

    const [, args] = spawnMock.mock.calls[0]
    expect(args[0]).not.toContain('<tool_call')
    expect(args[0]).not.toContain('<tool_result')
  })

  it('injects coding system preamble when tool calling is enabled', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', {
      cliPath: '/usr/bin/traecli',
      enableToolCalling: true,
      enforceTextOnly: false,
    })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)

    setImmediate(() => {
      stdout.end('{"message":{"content":"ok"}}')
      stderr.end('')
      closeChild(child)
    })
    for await (const _ of (await streamPromise).stream as any) {}

    const [, args] = spawnMock.mock.calls[0]
    expect(args[0]).toContain('System:')
    expect(args[0]).toContain('coding runtime mode')
    expect(args[0]).toContain('User:\nping')
  })

  it('supports disabling coding system preamble explicitly', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', {
      cliPath: '/usr/bin/traecli',
      enableToolCalling: true,
      enforceTextOnly: false,
      injectCodingSystemPrompt: false,
    })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)

    setImmediate(() => {
      stdout.end('{"message":{"content":"ok"}}')
      stderr.end('')
      closeChild(child)
    })
    for await (const _ of (await streamPromise).stream as any) {}

    const [, args] = spawnMock.mock.calls[0]
    expect(args[0]).not.toContain('coding runtime mode')
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
      'response-metadata',
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

  it('emits tool-call events when experimental tool calling is enabled', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', { cliPath: '/usr/bin/traecli', enableToolCalling: true })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)

    setImmediate(() => {
      stdout.end(JSON.stringify({
        agent_states: [
          {
            messages: [
              {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'Read', arguments: '{"path":"README.md"}' },
                  },
                ],
              },
            ],
          },
        ],
        message: { content: '' },
      }))
      stderr.end('')
      closeChild(child)
    })

    const parts: any[] = []
    for await (const part of (await streamPromise).stream as any) parts.push(part)

    expect(parts.map((p) => p.type)).toContain('tool-call')
    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'read',
      input: '{"path":"README.md","filePath":"README.md"}',
    })
    expect(parts.at(-1).finishReason).toBe('tool-calls')
    const [, args] = spawnMock.mock.calls[0]
    expect(args).not.toContain('--disallowed-tool')
  })

  it('emits tool-call finish before the Trae process closes', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', { cliPath: '/usr/bin/traecli', enableToolCalling: true })
    const { stream } = await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'read file' }] }],
    } as any)
    const reader = stream.getReader()

    const first = await reader.read()
    expect(first.value?.type).toBe('stream-start')

    stdout.write(JSON.stringify({
      agent_states: [
        {
          messages: [
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call-stream-1',
                  type: 'function',
                  function: { name: 'Read', arguments: '{"path":"README.md"}' },
                },
              ],
            },
          ],
        },
      ],
      message: { content: '' },
    }))
    await new Promise((resolve) => setImmediate(resolve))

    const parts: any[] = []
    while (parts.at(-1)?.type !== 'finish') {
      const next = await reader.read()
      expect(next.done).toBe(false)
      parts.push(next.value)
    }

    expect(parts.map((p) => p.type)).toContain('tool-call')
    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({ providerExecuted: false })
    expect(parts.find((p) => p.type === 'tool-input-start')).toMatchObject({ providerExecuted: false })
    expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: 'tool-calls' })
    expect(child.kill).toHaveBeenCalled()
  })

  it('normalizes edit tool name and snake_case args for tool-call payloads', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', { cliPath: '/usr/bin/traecli', enableToolCalling: true })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'patch file' }] }],
    } as any)

    setImmediate(() => {
      stdout.end(JSON.stringify({
        agent_states: [
          {
            messages: [
              {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call-edit-1',
                    type: 'function',
                    function: {
                      name: 'str_replace_based_edit_tool',
                      arguments: '{"file_path":"README.md","old_string":"old","new_string":"new","replace_all":true}',
                    },
                  },
                ],
              },
            ],
          },
        ],
        message: { content: '' },
      }))
      stderr.end('')
      closeChild(child)
    })

    const parts: any[] = []
    for await (const part of (await streamPromise).stream as any) parts.push(part)

    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolCallId: 'call-edit-1',
      toolName: 'edit',
      input: '{"filePath":"README.md","oldString":"old","newString":"new","replaceAll":true}',
    })
  })

  it('normalizes read offset and limit into valid positive integers', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', { cliPath: '/usr/bin/traecli', enableToolCalling: true })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'read file' }] }],
      tools: [
        {
          type: 'function',
          name: 'read',
          description: 'Read file',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
              offset: { type: 'number' },
              limit: { type: 'number' },
            },
          },
        },
      ],
    } as any)

    setImmediate(() => {
      stdout.end(JSON.stringify({
        agent_states: [
          {
            messages: [
              {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call-read-2',
                    type: 'function',
                    function: {
                      name: 'Read',
                      arguments: '{"file_path":"README.md","offset":0,"limit":"0"}',
                    },
                  },
                ],
              },
            ],
          },
        ],
        message: { content: '' },
      }))
      stderr.end('')
      closeChild(child)
    })

    const parts: any[] = []
    for await (const part of (await streamPromise).stream as any) parts.push(part)

    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolCallId: 'call-read-2',
      toolName: 'read',
      input: '{"filePath":"README.md","offset":1,"limit":1}',
    })
  })

  it('maps ls tool calls to glob with a safe pattern', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', { cliPath: '/usr/bin/traecli', enableToolCalling: true })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'list files' }] }],
      tools: [
        {
          type: 'function',
          name: 'glob',
          description: 'List files',
          inputSchema: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
            },
          },
        },
      ],
    } as any)

    setImmediate(() => {
      stdout.end(JSON.stringify({
        agent_states: [
          {
            messages: [
              {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call-ls-1',
                    type: 'function',
                    function: {
                      name: 'ls',
                      arguments: '{"path":"src"}',
                    },
                  },
                ],
              },
            ],
          },
        ],
        message: { content: '' },
      }))
      stderr.end('')
      closeChild(child)
    })

    const parts: any[] = []
    for await (const part of (await streamPromise).stream as any) parts.push(part)

    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolCallId: 'call-ls-1',
      toolName: 'glob',
      input: '{"pattern":"src/**/*"}',
    })
  })

  it('normalizes grep input by converting include and dropping unsupported flags', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', { cliPath: '/usr/bin/traecli', enableToolCalling: true })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'find keyword' }] }],
      tools: [
        {
          type: 'function',
          name: 'grep',
          description: 'Search text',
          inputSchema: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
              include: { type: 'string' },
            },
          },
        },
      ],
    } as any)

    setImmediate(() => {
      stdout.end(JSON.stringify({
        agent_states: [
          {
            messages: [
              {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call-grep-1',
                    type: 'function',
                    function: {
                      name: 'grep',
                      arguments: '{"pattern":"TODO","glob":"*.ts","-n":true,"head_limit":20}',
                    },
                  },
                ],
              },
            ],
          },
        ],
        message: { content: '' },
      }))
      stderr.end('')
      closeChild(child)
    })

    const parts: any[] = []
    for await (const part of (await streamPromise).stream as any) parts.push(part)

    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolCallId: 'call-grep-1',
      toolName: 'grep',
      input: '{"pattern":"TODO","include":"*.ts"}',
    })
  })

  it('normalizes write input aliases into filePath+content', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', { cliPath: '/usr/bin/traecli', enableToolCalling: true })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'write file' }] }],
      tools: [
        {
          type: 'function',
          name: 'write',
          description: 'Write file',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } } },
        },
      ],
    } as any)

    setImmediate(() => {
      stdout.end(JSON.stringify({
        agent_states: [
          {
            messages: [
              {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call-write-1',
                    type: 'function',
                    function: { name: 'write', arguments: '{"path":"README.md","text":"hello"}' },
                  },
                ],
              },
            ],
          },
        ],
        message: { content: '' },
      }))
      stderr.end('')
      closeChild(child)
    })

    const parts: any[] = []
    for await (const part of (await streamPromise).stream as any) parts.push(part)

    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolCallId: 'call-write-1',
      toolName: 'write',
      input: '{"path":"README.md","content":"hello","filePath":"README.md"}',
    })
  })

  it('normalizes edit alias fields into oldString/newString/replaceAll', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', { cliPath: '/usr/bin/traecli', enableToolCalling: true })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'edit file' }] }],
      tools: [
        {
          type: 'function',
          name: 'edit',
          description: 'Edit file',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
              oldString: { type: 'string' },
              newString: { type: 'string' },
              replaceAll: { type: 'boolean' },
            },
          },
        },
      ],
    } as any)

    setImmediate(() => {
      stdout.end(JSON.stringify({
        agent_states: [
          {
            messages: [
              {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call-edit-2',
                    type: 'function',
                    function: {
                      name: 'edit',
                      arguments: '{"file_path":"README.md","find":"foo","replace":"bar","all":"true"}',
                    },
                  },
                ],
              },
            ],
          },
        ],
        message: { content: '' },
      }))
      stderr.end('')
      closeChild(child)
    })

    const parts: any[] = []
    for await (const part of (await streamPromise).stream as any) parts.push(part)

    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolCallId: 'call-edit-2',
      toolName: 'edit',
      input: '{"filePath":"README.md","oldString":"foo","newString":"bar","replaceAll":true}',
    })
  })

  it('normalizes bash aliases into command+timeout', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', { cliPath: '/usr/bin/traecli', enableToolCalling: true })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'run command' }] }],
      tools: [
        {
          type: 'function',
          name: 'bash',
          description: 'Run command',
          inputSchema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } } },
        },
      ],
    } as any)

    setImmediate(() => {
      stdout.end(JSON.stringify({
        agent_states: [
          {
            messages: [
              {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call-bash-1',
                    type: 'function',
                    function: { name: 'bash', arguments: '{"shell":"pwd","timeout_ms":"0"}' },
                  },
                ],
              },
            ],
          },
        ],
        message: { content: '' },
      }))
      stderr.end('')
      closeChild(child)
    })

    const parts: any[] = []
    for await (const part of (await streamPromise).stream as any) parts.push(part)

    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolCallId: 'call-bash-1',
      toolName: 'bash',
      input: '{"command":"pwd","timeout":1}',
    })
  })

  it('normalizes task aliases into description/prompt/subagent_type', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', { cliPath: '/usr/bin/traecli', enableToolCalling: true })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'delegate task' }] }],
      tools: [
        {
          type: 'function',
          name: 'task',
          description: 'Delegate work',
          inputSchema: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              prompt: { type: 'string' },
              subagent_type: { type: 'string' },
            },
          },
        },
      ],
    } as any)

    setImmediate(() => {
      stdout.end(JSON.stringify({
        agent_states: [
          {
            messages: [
              {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call-task-1',
                    type: 'function',
                    function: {
                      name: 'Task',
                      arguments: '{"title":"Explore auth","instruction":"Inspect scheduler","agentType":"explore"}',
                    },
                  },
                ],
              },
            ],
          },
        ],
        message: { content: '' },
      }))
      stderr.end('')
      closeChild(child)
    })

    const parts: any[] = []
    for await (const part of (await streamPromise).stream as any) parts.push(part)

    const toolCall = parts.find((p) => p.type === 'tool-call')
    expect(toolCall).toMatchObject({
      toolCallId: 'call-task-1',
      toolName: 'task',
    })
    expect(JSON.parse((toolCall as any).input)).toEqual({
      subagent_type: 'explorer',
      description: 'Explore auth',
      prompt: 'Inspect scheduler',
    })
  })
})
