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
    vi.unstubAllGlobals()
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
    const model = new TraeLanguageModel('custom-model', { allowCliFallback: true, cliPath: '/usr/bin/traecli', queryTimeout: 55, extraArgs: ['--foo'], sessionId: 'test-session' })
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

  it('uses OpenAI-compatible streaming transport when baseURL and apiKey are configured', async () => {
    const fetchMock = vi.fn(async (_url, _init) => new Response(
      [
        'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('fast', {
allowCliFallback: true,
cliPath: '/usr/bin/traecli',
      openaiBaseURL: 'https://example.test/v1',
      openaiApiKey: 'test-key',
    } as any)

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer test-key',
      }),
    }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: 'MiniMax-M2.7',
      stream: true,
    })
    expect(parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('')).toBe('hello')
    expect(parts.find((p) => p.type === 'finish').usage).toMatchObject({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
    })
  })

  it('converts OpenAI-compatible streamed tool calls into OpenCode tool-call parts', async () => {
    const fetchMock = vi.fn(async () => new Response(
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"file_path\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"package.json\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', {
      openaiBaseURL: 'https://example.test/v1',
      openaiApiKey: 'test-key',
      enableToolCalling: true,
      modelName: 'GLM-5.1',
    } as any)

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      tools: [{ type: 'function', name: 'read', inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } } }],
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'inspect the repository config file' }] }],
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tools).toMatchObject([
      { type: 'function', function: { name: 'read' } },
    ])
    expect(parts.filter((p) => p.type === 'tool-input-delta').map((p) => p.delta).join('')).toBe('{"filePath":"package.json"}')
    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolCallId: 'call_1',
      toolName: 'read',
      input: '{"filePath":"package.json"}',
    })
    expect(parts.find((p) => p.type === 'finish').finishReason).toBe('tool-calls')
  })

  it('sends OpenCode tool results back through OpenAI-compatible messages', async () => {
    const fetchMock = vi.fn(async () => new Response(
      [
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', {
      openaiBaseURL: 'https://example.test/v1',
      openaiApiKey: 'test-key',
      enableToolCalling: true,
      modelName: 'GLM-5.1',
    } as any)

    for await (const _part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'use ls result to answer' }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-bash', toolName: 'bash', input: { command: 'ls' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-bash', toolName: 'bash', output: { type: 'text', value: 'README.md\nsrc/\n' } }] },
      ],
    } as any)).stream as any) {
      // drain stream
    }

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages).toEqual(expect.arrayContaining([
      { role: 'user', content: expect.stringContaining('Tool result [call-bash] bash:\nREADME.md\nsrc/') },
    ]))
    expect(JSON.stringify(body.messages)).not.toContain('Hello')
  })

  it('uses Trae raw chat SSE transport when configured', async () => {
    const fetchMock = vi.fn(async () => new Response(
      [
        'event: metadata\n',
        'data: {"model":"glm-5.1-ark","session_id":"trace-1"}\n\n',
        'event: output\n',
        'data: {"response":"hel","tool_calls":null}\n\n',
        'event: output\n',
        'data: {"response":"hello","tool_calls":null}\n\n',
        'event: token_usage\n',
        'data: {"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}\n\n',
      ].join(''),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', {
      traeRawBaseURL: 'https://console.enterprise.trae.cn',
      traeRawApiKey: 'test-key',
      modelName: 'GLM-5.1',
      enableToolCalling: true,
    } as any)

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith('https://console.enterprise.trae.cn/api/ide/v2/llm_raw_chat', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Cloud-IDE-JWT test-key',
        'Content-Type': 'application/json',
        'X-Ide-Function': 'chat',
      }),
    }))
    const headers = fetchMock.mock.calls[0][1].headers
    expect(JSON.parse(headers.Extra)).toMatchObject({
      api_host: 'https://console.enterprise.trae.cn',
      base_url: 'https://console.enterprise.trae.cn/trae-cli/api/v1/llm/proxy',
      config_name: 'glm-5.1',
      model_name: 'glm-5__v2',
    })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      config_name: 'glm-5.1',
      model_name: 'glm-5__v2',
      session_id: expect.any(String),
      messages: [{ role: 'user' }],
    })
    expect(parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('')).toBe('hello')
    expect(parts.find((p) => p.type === 'finish').usage).toMatchObject({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
    })
  })

  it('sends OpenCode tool results back to Trae raw chat instead of an empty fallback prompt', async () => {
    const fetchMock = vi.fn(async () => new Response(
      'event: output\ndata: {"response":"基于目录输出，可以继续做临时目录清理和项目识别。","tool_calls":null}\n\n',
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('GLM-5.1', {
      traeRawBaseURL: 'https://console.enterprise.trae.cn',
      traeRawApiKey: 'test-key',
      enableToolCalling: true,
    } as any)

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        { role: 'user', content: [{ type: 'text', text: '当前目录下都有什么，请你评估一下适合做什么' }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-bash', toolName: 'bash', input: { command: 'rtk ls -la /private/tmp/' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-bash', toolName: 'bash', output: { type: 'text', value: 'opencode/\ntrae-mitm/\npackage.json\n' } }] },
      ],
    } as any)).stream as any) parts.push(part)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages).toEqual(expect.arrayContaining([
      { role: 'user', content: [{ type: 'text', text: '当前目录下都有什么，请你评估一下适合做什么' }] },
      {
        role: 'user',
        content: [{
          type: 'text',
          text: expect.stringContaining('Tool result [call-bash] bash:\nopencode/\ntrae-mitm/\npackage.json'),
        }],
      },
    ]))
    expect(JSON.stringify(body.messages)).not.toContain('Hello')
    expect(parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('')).toContain('基于目录输出')
  })

  it('maps Kimi-K2.6 to the raw Trae model identifiers', async () => {
    const fetchMock = vi.fn(async () => new Response(
      'event: output\ndata: {"response":"ok","tool_calls":null}\n\n',
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('Kimi-K2.6', {
      traeRawBaseURL: 'https://api.enterprise.trae.cn',
      traeRawApiKey: 'test-key',
    } as any)

    for await (const _part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)).stream as any) {
      // drain stream
    }

    const headers = fetchMock.mock.calls[0][1].headers
    expect(JSON.parse(headers.Extra)).toMatchObject({
      config_name: 'kimi-k2.6',
      display_name: 'Kimi-K2.6',
      model_name: 'kimi-k2.6__v2',
    })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      config_name: 'kimi-k2.6',
      model_name: 'kimi-k2.6__v2',
    })
  })

  it('maps DeepSeek-V4-Pro to the raw Trae model identifiers', async () => {
    const fetchMock = vi.fn(async () => new Response(
      'event: output\ndata: {"response":"ok","tool_calls":null}\n\n',
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('DeepSeek-V4-Pro', {
      traeRawBaseURL: 'https://api.enterprise.trae.cn',
      traeRawApiKey: 'test-key',
      enableToolCalling: true,
    } as any)

    for await (const _part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)).stream as any) {
      // drain stream
    }

    const headers = fetchMock.mock.calls[0][1].headers
    expect(JSON.parse(headers.Extra)).toMatchObject({
      config_name: 'deepseek-V4-Pro',
      display_name: 'DeepSeek-V4-Pro',
      model_name: 'deepseek-V4-Pro__v2',
    })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      config_name: 'deepseek-V4-Pro',
      model_name: 'deepseek-V4-Pro__v2',
    })
  })

  it('exchanges an explicit Trae PAT before calling raw chat', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/cloudide/api/v3/trae/oauth/ExchangeToken')) {
        return new Response(JSON.stringify({
          code: 0,
          Data: {
            Token: 'jwt-token',
            TokenExpireAt: Date.now() + 60_000,
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        [
          'event: output\n',
          'data: {"response":"ok","tool_calls":null}\n\n',
        ].join(''),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', {
      pat: 'pat-token',
      traeRawBaseURL: 'https://api.enterprise.trae.cn',
    } as any)

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)).stream as any) parts.push(part)

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.enterprise.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        'X-Cloudide-Token': '',
      }),
      body: JSON.stringify({ RefreshToken: 'pat-token' }),
    })
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.enterprise.trae.cn/api/ide/v2/llm_raw_chat')
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      Authorization: 'Cloud-IDE-JWT jwt-token',
    })
    expect(JSON.parse(fetchMock.mock.calls[1][1].headers.Extra).api_key).toBe('jwt-token')
    expect(parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('')).toBe('ok')
  })

  it('does not pass the OpenCode coding alias as Trae raw display name', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/cloudide/api/v3/trae/oauth/ExchangeToken')) {
        return new Response(JSON.stringify({
          code: 0,
          Data: {
            Token: 'jwt-token',
            TokenExpireAt: Date.now() + 60_000,
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('event: output\ndata: {"response":"ok","tool_calls":null}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', {
      pat: 'pat-token',
      traeRawBaseURL: 'https://api.enterprise.trae.cn',
    } as any)

    for await (const _part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)).stream as any) {
      // drain stream
    }

    expect(JSON.parse(fetchMock.mock.calls[1][1].headers.Extra)).toMatchObject({
      config_name: 'glm-5.1',
      display_name: 'GLM-5.1',
      model_name: 'glm-5__v2',
    })
  })

  it('converts streamed Trae XML tool_use text into OpenCode tool calls', async () => {
    const fetchMock = vi.fn(async () => new Response(
      [
        'event: output\n',
        'data: {"response":"<tool_use>\\n<server_name>bash</server_name>\\n","tool_calls":null}\n\n',
        'event: output\n',
        'data: {"response":"<tool_use>\\n<server_name>bash</server_name>\\n<tool_name>bash</tool_name>\\n<input>\\n{\\"command\\": \\"ls -la /private/tmp\\"}\\n</input>\\n</tool_use>","tool_calls":null}\n\n',
      ].join(''),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', {
      traeRawBaseURL: 'https://console.enterprise.trae.cn',
      traeRawApiKey: 'test-key',
      enableToolCalling: true,
    } as any)

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      tools: [{ type: 'function', name: 'bash', inputSchema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } } } }],
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'list tmp' }] }],
    } as any)).stream as any) parts.push(part)

    expect(parts.some((p) => p.type === 'text-delta')).toBe(false)
    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolName: 'bash',
      input: '{"command":"ls -la /private/tmp","description":"Run ls -la /private/tmp"}',
    })
    expect(parts.find((p) => p.type === 'tool-call')).not.toHaveProperty('providerExecuted')
    expect(parts.find((p) => p.type === 'finish')).toMatchObject({ finishReason: 'tool-calls' })
  })

  it('stops the raw stream turn after a text tool_use so OpenCode executes the tool', async () => {
    const fetchMock = vi.fn(async () => new Response(
      [
        'event: output\n',
        'data: {"response":"<tool_use>\\n<server_name>bash</server_name>\\n<tool_name>bash</tool_name>\\n<input>\\n{\\"command\\": \\"pwd\\"}\\n</input>\\n</tool_use>","tool_calls":null}\n\n',
        'event: output\n',
        'data: {"response":"<tool_use>\\n<server_name>bash</server_name>\\n<tool_name>bash</tool_name>\\n<input>\\n{\\"command\\": \\"pwd\\"}\\n</input>\\n</tool_use>\\n\\n<tool_result>/tmp</tool_result>\\nfinal answer","tool_calls":null}\n\n',
      ].join(''),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', {
      traeRawBaseURL: 'https://console.enterprise.trae.cn',
      traeRawApiKey: 'test-key',
      enableToolCalling: true,
    } as any)

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      tools: [{ type: 'function', name: 'bash', inputSchema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } } } }],
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'pwd' }] }],
    } as any)).stream as any) parts.push(part)

    expect(parts.filter((p) => p.type === 'tool-call')).toHaveLength(1)
    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolName: 'bash',
      input: '{"command":"pwd","description":"Run pwd"}',
    })
    expect(parts.some((p) => p.type === 'text-delta' && String(p.delta).includes('<tool_result>'))).toBe(false)
    expect(parts.some((p) => p.type === 'text-delta' && String(p.delta).includes('final answer'))).toBe(false)
    expect(parts.find((p) => p.type === 'finish')).toMatchObject({ finishReason: 'tool-calls' })
  })

  it('buffers split Trae XML tool_use tags instead of leaking partial text', async () => {
    const chunks = [
      '<',
      'tool',
      '_use>\\n<server_name>bash</server_name>\\n',
      '<tool_name>bash</tool_name>\\n<input>\\n',
      '{\\"command\\": \\"pwd\\"}',
      '\\n</input>\\n</tool_use>',
    ]
    const fetchMock = vi.fn(async () => new Response(
      chunks.map((chunk) => `event: output\ndata: {"response":"${chunk}","tool_calls":null}\n\n`).join(''),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', {
      traeRawBaseURL: 'https://console.enterprise.trae.cn',
      traeRawApiKey: 'test-key',
      enableToolCalling: true,
    } as any)

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      tools: [{ type: 'function', name: 'bash', inputSchema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } } } }],
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'pwd' }] }],
    } as any)).stream as any) parts.push(part)

    expect(parts.some((p) => p.type === 'text-delta')).toBe(false)
    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolName: 'bash',
      input: '{"command":"pwd","description":"Run pwd"}',
    })
    expect(parts.find((p) => p.type === 'finish')).toMatchObject({ finishReason: 'tool-calls' })
  })

  it('converts Kimi tool + parameter text into OpenCode tool calls', async () => {
    const fetchMock = vi.fn(async () => new Response(
      [
        'event: output\n',
        'data: {"response":"I\\u0027ll run that command for you.\\n\\n<tool>bash","tool_calls":null}\n\n',
        'event: output\n',
        'data: {"response":"</tool>\\n<parameter>{\\"command\\": \\"date +%s%N\\"}</parameter>\\n\\n","tool_calls":null}\n\n',
      ].join(''),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('Kimi-K2.6', {
      traeRawBaseURL: 'https://api.enterprise.trae.cn',
      traeRawApiKey: 'test-key',
      enableToolCalling: true,
    } as any)

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      tools: [{ type: 'function', name: 'bash', inputSchema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } } } }],
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'run date' }] }],
    } as any)).stream as any) parts.push(part)

    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolName: 'bash',
      input: '{"command":"date +%s%N","description":"Run date +%s%N"}',
    })
    expect(parts.find((p) => p.type === 'finish')).toMatchObject({ finishReason: 'tool-calls' })
  })

  it('converts streamed Trae compact tool_call text into OpenCode tool calls', async () => {
    const fetchMock = vi.fn(async () => new Response(
      [
        'event: output\n',
        'data: {"response":"<tool_call>bash</arg_key>command:rtk ls -la\\n---","tool_calls":null}\n\n',
      ].join(''),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', {
      traeRawBaseURL: 'https://console.enterprise.trae.cn',
      traeRawApiKey: 'test-key',
      enableToolCalling: true,
    } as any)

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      tools: [{ type: 'function', name: 'bash', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } }],
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'list files' }] }],
    } as any)).stream as any) parts.push(part)

    expect(parts.some((p) => p.type === 'text-delta')).toBe(false)
    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolName: 'bash',
      input: '{"command":"rtk ls -la"}',
    })
    expect(parts.find((p) => p.type === 'tool-call')).not.toHaveProperty('providerExecuted')
    expect(parts.find((p) => p.type === 'finish')).toMatchObject({ finishReason: 'tool-calls' })
  })

  it('ignores non-JSON Trae progress_notice SSE frames', async () => {
    const fetchMock = vi.fn(async () => new Response(
      [
        'event: progress_notice\n',
        'data: ;Processing_1778051530000_demo\n\n',
        'event: output\n',
        'data: {"response":"ok","tool_calls":null}\n\n',
      ].join(''),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', {
      traeRawBaseURL: 'https://console.enterprise.trae.cn',
      traeRawApiKey: 'test-key',
    } as any)

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)).stream as any) parts.push(part)

    expect(parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('')).toBe('ok')
    expect(parts.find((p) => p.type === 'error')).toBeUndefined()
  })

  it('returns raw text tool calls from doGenerate content', async () => {
    const fetchMock = vi.fn(async () => new Response(
      [
        'event: output\n',
        'data: {"response":"<tool_use>\\n<server_name>bash</server_name>\\n<tool_name>bash</tool_name>\\n<input>\\n{\\"command\\": \\"pwd\\"}\\n</input>\\n</tool_use>","tool_calls":null}\n\n',
      ].join(''),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', {
      traeRawBaseURL: 'https://console.enterprise.trae.cn',
      traeRawApiKey: 'test-key',
      enableToolCalling: true,
    } as any)

    const result = await model.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      tools: [{ type: 'function', name: 'bash', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } }],
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'pwd' }] }],
    } as any)

    expect(result.content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'trae-text-tool-0',
        toolName: 'bash',
        input: '{"command":"pwd"}',
      },
    ])
    expect(result.finishReason).toBe('tool-calls')
  })

  it('emits an error when Trae raw chat SSE finishes without text or tool calls', async () => {
    const fetchMock = vi.fn(async () => new Response(
      [
        'event: metadata\n',
        'data: {"model":"glm-5.1-ark","session_id":"trace-1"}\n\n',
        'event: token_usage\n',
        'data: {"prompt_tokens":3,"completion_tokens":0,"total_tokens":3}\n\n',
      ].join(''),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', {
      traeRawBaseURL: 'https://console.enterprise.trae.cn',
      traeRawApiKey: 'test-key',
    } as any)

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)).stream as any) parts.push(part)

    expect(parts.find((p) => p.type === 'error')?.error.message).toContain('Trae raw chat stream ended without text or tool calls')
    expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: 'error' })
  })

  it('emits Trae raw chat SSE error events as OpenCode errors', async () => {
    const fetchMock = vi.fn(async () => new Response(
      [
        'event: error\n',
        'data: {"code":"ErrNoAuth","message":"unsupported token type"}\n\n',
      ].join(''),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', {
      traeRawBaseURL: 'https://console.enterprise.trae.cn',
      traeRawApiKey: 'test-key',
    } as any)

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)).stream as any) parts.push(part)

    expect(parts.find((p) => p.type === 'error')?.error.message).toContain('ErrNoAuth')
    expect(parts.find((p) => p.type === 'error')?.error.message).toContain('unsupported token type')
    expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: 'error' })
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
    const model = new TraeLanguageModel('default', { allowCliFallback: true, cliPath: '/usr/bin/traecli' })
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
    const model = new TraeLanguageModel('fast', { allowCliFallback: true, cliPath: '/usr/bin/traecli' })
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
    const model = new TraeLanguageModel('coding', { allowCliFallback: true, cliPath: '/usr/bin/traecli', enableToolCalling: false, enforceTextOnly: true })
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
    const model = new TraeLanguageModel('trae/coding', { allowCliFallback: true, cliPath: '/usr/bin/traecli', enableToolCalling: false, enforceTextOnly: true })
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

  it('keeps Trae CLI tools disabled when trae/coding exposes OpenCode tool calling', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('trae/coding', { allowCliFallback: true, cliPath: '/usr/bin/traecli', enableToolCalling: true, enforceTextOnly: true })
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
    expect(args).toContain('--disallowed-tool')
    expect(args).toContain('Read')
    expect(args).toContain('Bash')
    expect(args).toContain('Write')
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
    const model = new TraeLanguageModel('default', { allowCliFallback: true, cliPath: '/usr/bin/traecli' })
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
allowCliFallback: true,
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
    expect(args[0]).toContain('Do not execute Trae CLI internal tools')
    expect(args[0]).toContain('If repository or filesystem facts are needed')
    expect(args[0]).toContain('<opencode_tool_call>')
    expect(args[0]).toContain('User:\nping')
  })

  it('lists available OpenCode tools in the coding preamble', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', {
allowCliFallback: true,
cliPath: '/usr/bin/traecli',
      enableToolCalling: true,
      enforceTextOnly: true,
    })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      tools: [
        {
          type: 'function',
          name: 'read',
          description: 'Read file contents',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
        },
        {
          type: 'function',
          name: 'bash',
          description: 'Run shell command',
          inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
    } as any)

    setImmediate(() => {
      stdout.end('{"message":{"content":"ok"}}')
      stderr.end('')
      closeChild(child)
    })
    for await (const _ of (await streamPromise).stream as any) {}

    const [, args] = spawnMock.mock.calls[0]
    expect(args[0]).toContain('Available OpenCode tools: read, bash')
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
allowCliFallback: true,
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
    const model = new TraeLanguageModel('default', { allowCliFallback: true, cliPath: '/usr/bin/traecli' })
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
    const model = new TraeLanguageModel('default', { allowCliFallback: true, cliPath: '/usr/bin/traecli' })
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

  it('does not spawn legacy traecli unless fallback is explicitly enabled', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', { cliPath: '/usr/bin/traecli' })
    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(parts.map((p) => p.type)).toEqual(['stream-start', 'error', 'finish'])
    expect(String(parts.find((p) => p.type === 'error').error.message)).toContain('Legacy traecli fallback is disabled by default')
  })

  it('emits tool-call events while keeping Trae internal tools disabled by default', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('default', { allowCliFallback: true, cliPath: '/usr/bin/traecli', enableToolCalling: true })
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
    expect(args).toContain('--disallowed-tool')
  })

  it('emits OpenCode tool calls from the structured text protocol', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('trae/coding', {
allowCliFallback: true,
cliPath: '/usr/bin/traecli',
      enableToolCalling: true,
      enforceTextOnly: true,
    })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'inspect package json' }] }],
      tools: [
        {
          type: 'function',
          name: 'read',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
        },
      ],
    } as any)

    setImmediate(() => {
      stdout.end(JSON.stringify({
        message: {
          content: [
            {
              type: 'text',
              text: [
                '<opencode_tool_call>',
                '{"id":"call-text-read","name":"read","input":{"path":"package.json"}}',
                '</opencode_tool_call>',
              ].join('\n'),
            },
          ],
        },
      }))
      stderr.end('')
      closeChild(child)
    })

    const parts: any[] = []
    for await (const part of (await streamPromise).stream as any) parts.push(part)

    expect(parts.map((p) => p.type)).toEqual([
      'stream-start',
      'response-metadata',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-end',
      'tool-call',
      'finish',
    ])
    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolCallId: 'call-text-read',
      toolName: 'read',
      input: '{"path":"package.json","filePath":"package.json"}',
    })
    expect(parts.at(-1).finishReason).toBe('tool-calls')
    const [, args] = spawnMock.mock.calls[0]
    expect(args).toContain('--disallowed-tool')
  })

  it('routes explicit file reads to OpenCode before spawning Trae CLI', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('trae/coding', {
allowCliFallback: true,
cliPath: '/usr/bin/traecli',
      enableToolCalling: true,
      enforceTextOnly: true,
    })

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: '请读取 package.json 并告诉我 scripts.test 的值' }] }],
      tools: [
        {
          type: 'function',
          name: 'read',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
        },
      ],
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(parts.map((p) => p.type)).toEqual([
      'stream-start',
      'response-metadata',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-end',
      'tool-call',
      'finish',
    ])
    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolCallId: 'trae-router-read-0',
      toolName: 'read',
      input: '{"filePath":"package.json"}',
    })
    expect(parts.at(-1).usage).toEqual({
      inputTokens: { total: 0, cached: 0 },
      outputTokens: { total: 0, reasoning: 0 },
      totalTokens: 0,
    })
    expect(parts.at(-1).finishReason).toBe('tool-calls')
  })

  it('routes explicit nested file reads when OpenCode passes tools as a map', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('trae/coding', {
allowCliFallback: true,
cliPath: '/usr/bin/traecli',
      enableToolCalling: true,
      enforceTextOnly: true,
    })

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: '请读取 opencode-trae-cli-auth/package.json，并告诉我 scripts.test 是什么' }] }],
      tools: {
        read: {
          type: 'function',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
        },
      },
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolCallId: 'trae-router-read-0',
      toolName: 'read',
      input: '{"filePath":"opencode-trae-cli-auth/package.json"}',
    })
    expect(parts.at(-1).finishReason).toBe('tool-calls')
  })

  it('routes coding model file reads even when provider options are not forwarded', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', { allowCliFallback: true, cliPath: '/usr/bin/traecli' })

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: '请读取 opencode-trae-cli-auth/package.json，并告诉我 scripts.test 是什么' }] }],
      tools: {
        read: {
          type: 'function',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
        },
      },
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolCallId: 'trae-router-read-0',
      toolName: 'read',
      input: '{"filePath":"opencode-trae-cli-auth/package.json"}',
    })
    expect(parts.at(-1).finishReason).toBe('tool-calls')
  })

  it('routes fast model repository manifest requests even when provider options are not forwarded', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('fast', { allowCliFallback: true, cliPath: '/usr/bin/traecli' })

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: '都有哪些package.json和readme' }] }],
      tools: {
        bash: {
          type: 'function',
          description: 'Run shell command',
          inputSchema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } } },
        },
        read: {
          type: 'function',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
        },
      },
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    const call = parts.find((p) => p.type === 'tool-call')
    expect(call).toMatchObject({ toolName: 'bash' })
    expect(JSON.parse(call.input).command).toContain('package.json')
    expect(JSON.parse(call.input).command).toContain('README')
    expect(parts.at(-1).finishReason).toBe('tool-calls')
  })

  it('routes explicit bash command requests before relying on model-native tool syntax', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('DeepSeek-V4-Pro', {
      traeRawBaseURL: 'https://api.enterprise.trae.cn',
      traeRawApiKey: 'test-key',
      enableToolCalling: true,
    } as any)

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: '请必须使用 bash 工具执行命令：date +%s%N。不要猜测，不要解释，只在工具执行后返回完整输出。' }] }],
      tools: {
        bash: {
          type: 'function',
          description: 'Run shell command',
          inputSchema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } } },
        },
      },
    } as any)).stream as any) parts.push(part)

    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolName: 'bash',
      input: '{"command":"date +%s%N","description":"Run date +%s%N"}',
    })
    expect(parts.at(-1).finishReason).toBe('tool-calls')
  })

  it('uses a path-only inventory command for direct package/readme listing requests', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('fast', { allowCliFallback: true, cliPath: '/usr/bin/traecli' })

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: '都有哪些package.json和readme' }] }],
      tools: {
        bash: {
          type: 'function',
          description: 'Run shell command',
          inputSchema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } } },
        },
      },
    } as any)).stream as any) parts.push(part)

    const call = parts.find((p) => p.type === 'tool-call')
    const input = JSON.parse(call.input)
    expect(input.command).toContain('echo "### $rel"')
    expect(input.command).not.toContain('node -e')
    expect(input.command).not.toContain('grep -E')
  })

  it('routes concrete TDD package script fixes to explicit context reads, not repository inventory fallback', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', { allowCliFallback: true, cliPath: '/usr/bin/traecli' })

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{
        role: 'user',
        content: [{
          type: 'text',
          text: [
            '请以 TDD 方式修复一个真实工程问题：',
            '当前 provider 的 package.json 里仍然有 npm lifecycle script。',
            '请先阅读 package.json、README.md、tests 目录，确认现有约定。',
            '将 prepack/prepublishOnly 改为 bun 入口，并补充测试。',
          ].join('\n'),
        }],
      }],
      tools: {
        bash: {
          type: 'function',
          description: 'Run shell command',
          inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
        },
        read: {
          type: 'function',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
        },
        edit: {
          type: 'function',
          description: 'Edit file',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
        },
        glob: {
          type: 'function',
          description: 'Find files',
          inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } },
        },
      },
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(parts.filter((p) => p.type === 'tool-call').map((p) => [p.toolName, p.input])).toEqual([
      ['read', '{"filePath":"package.json"}'],
      ['read', '{"filePath":"README.md","limit":200}'],
      ['bash', '{"description":"Find project test files for TDD context","command":"find tests -type f \\\\( -name \\"*.test.ts\\" -o -name \\"*.test.tsx\\" -o -name \\"*.spec.ts\\" -o -name \\"*.spec.tsx\\" \\\\) | sort | head -20","timeout":5}'],
    ])
    const text = parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('')
    expect(text).not.toContain('工程化建议摘要')
  })

  it('routes TDD package script fixes from test file inventory to bounded test file reads', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', { allowCliFallback: true, cliPath: '/usr/bin/traecli', includeToolHistory: true })

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        {
          role: 'user',
          content: [{
            type: 'text',
            text: [
              '请以 TDD 方式修复一个真实工程问题：',
              '当前 provider 的 package.json 里仍然有 npm lifecycle script。',
              '请先阅读 package.json、README.md、tests 目录，确认现有约定。',
              '将 prepack/prepublishOnly 改为 bun 入口，并补充测试。',
            ].join('\n'),
          }],
        },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'trae-router-context-find-tests', toolName: 'bash', input: { command: 'find tests' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'trae-router-context-find-tests', toolName: 'bash', output: { type: 'text', value: 'tests/plugin.test.ts\ntests/trae-language-model.test.ts\ntests/prompt-builder.test.ts' } }] },
      ],
      tools: {
        read: {
          type: 'function',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, limit: { type: 'number' } } },
        },
      },
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(parts.filter((p) => p.type === 'tool-call').map((p) => JSON.parse(p.input))).toEqual([
      { filePath: 'tests/plugin.test.ts', limit: 240 },
      { filePath: 'tests/trae-language-model.test.ts', limit: 240 },
      { filePath: 'tests/prompt-builder.test.ts', limit: 240 },
    ])
  })

  it('does not call Trae again when test file inventory is empty', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', { allowCliFallback: true, cliPath: '/usr/bin/traecli', includeToolHistory: true })

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        {
          role: 'user',
          content: [{
            type: 'text',
            text: [
              '请以 TDD 方式修复一个真实工程问题：',
              '当前 provider 的 package.json 里仍然有 npm lifecycle script。',
              '请先阅读 package.json、README.md、tests 目录，确认现有约定。',
              '将 prepack/prepublishOnly 改为 bun 入口，并补充测试。',
            ].join('\n'),
          }],
        },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'trae-router-context-find-tests', toolName: 'bash', input: { command: 'find tests' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'trae-router-context-find-tests', toolName: 'bash', output: { type: 'text', value: '' } }] },
      ],
      tools: {
        read: {
          type: 'function',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, limit: { type: 'number' } } },
        },
      },
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(parts.filter((p) => p.type === 'tool-call')).toHaveLength(0)
    expect(parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('')).toContain('未发现测试文件')
  })

  it('prefers the actual user-requested file over injected instruction file paths', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', { allowCliFallback: true, cliPath: '/usr/bin/traecli' })

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{
        role: 'user',
        content: [{
          type: 'text',
          text: 'Read /Users/qqz/.agents/AGENTS.md first.\nUser request: 请读取 opencode-trae-cli-auth/package.json，并告诉我 scripts.test 是什么',
        }],
      }],
      tools: {
        read: {
          type: 'function',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
        },
      },
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolCallId: 'trae-router-read-0',
      toolName: 'read',
      input: '{"filePath":"opencode-trae-cli-auth/package.json"}',
    })
  })

  it('routes broad repository manifest reviews to OpenCode glob calls first', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('trae/coding', {
allowCliFallback: true,
cliPath: '/usr/bin/traecli',
      enableToolCalling: true,
      enforceTextOnly: true,
    })

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: '帮我阅读当前文件夹下所有仓库的 package.json 与 README.md，给出3条建议' }] }],
      tools: [
        {
          type: 'function',
          name: 'glob',
          description: 'Find files',
          inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } },
        },
      ],
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(parts.filter((p) => p.type === 'tool-call')).toHaveLength(2)
    expect(parts.filter((p) => p.type === 'tool-call').map((p) => p.input)).toEqual([
      '{"pattern":"**/package.json"}',
      '{"pattern":"**/README.md"}',
    ])
    expect(parts.at(-1).finishReason).toBe('tool-calls')
  })

  it('routes broad repository manifest reviews when OpenCode passes tools as a map', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('trae/coding', {
allowCliFallback: true,
cliPath: '/usr/bin/traecli',
      enableToolCalling: true,
      enforceTextOnly: true,
    })

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: '帮我阅读当前文件夹下所有仓库的 package.json 与 README.md，给出3条建议' }] }],
      tools: {
        glob: {
          type: 'function',
          description: 'Find files',
          inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } },
        },
        read: {
          type: 'function',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
        },
      },
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(parts.filter((p) => p.type === 'tool-call').map((p) => p.input)).toEqual([
      '{"pattern":"**/package.json"}',
      '{"pattern":"**/README.md"}',
    ])
    expect(parts.at(-1).finishReason).toBe('tool-calls')
  })

  it('prefers a compact OpenCode bash inventory for broad repository manifest reviews', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('trae/coding', {
allowCliFallback: true,
cliPath: '/usr/bin/traecli',
      enableToolCalling: true,
      enforceTextOnly: true,
    })

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: '帮我阅读当前文件夹下所有仓库的 package.json 与 README.md，给出3条建议' }] }],
      tools: {
        bash: {
          type: 'function',
          description: 'Run shell command',
          inputSchema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } } },
        },
        glob: {
          type: 'function',
          description: 'Find files',
          inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } },
        },
        read: {
          type: 'function',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
        },
      },
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    const call = parts.find((p) => p.type === 'tool-call')
    expect(call).toMatchObject({ toolName: 'bash' })
    const input = JSON.parse(call.input)
    expect(input.description).toContain('package.json')
    expect(input.command).toContain('package.json')
    expect(input.command).toContain('README')
    expect(input.command).toContain('node_modules')
    expect(input.command).toContain('.next')
    expect(input.command).not.toContain('sed -n "1,80p"')
    expect(input.command).toContain('Object.keys(j.dependencies).slice(0,20)')
    expect(input.command).toContain('grep -E "^(#|##) "')
    expect(input.timeout).toBeLessThanOrEqual(15)
    expect(parts.at(-1).finishReason).toBe('tool-calls')
  })

  it('does not deterministic-route after OpenCode has returned tool results', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('trae/coding', {
allowCliFallback: true,
cliPath: '/usr/bin/traecli',
      enableToolCalling: true,
      enforceTextOnly: true,
      includeToolHistory: true,
    })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        { role: 'user', content: [{ type: 'text', text: '请读取 package.json 并告诉我 scripts.test 的值' }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'trae-router-read-0', toolName: 'read', input: { filePath: 'package.json' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'trae-router-read-0', toolName: 'read', output: { type: 'text', value: '{"scripts":{"test":"vitest run"}}' } }] },
      ],
    } as any)

    const parts: any[] = []
    for await (const part of (await streamPromise).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(parts.filter((p) => p.type === 'tool-call')).toHaveLength(0)
    expect(parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('')).toBe('scripts.test 是 vitest run')
  })

  it('falls back to real tool output when Trae times out after a read result', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', {
allowCliFallback: true,
cliPath: '/usr/bin/traecli',
      queryTimeout: 1,
      includeToolHistory: true,
    })

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        { role: 'user', content: [{ type: 'text', text: '请读取 opencode-trae-cli-auth/package.json，并总结这个 package 的脚本配置' }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'trae-router-read-0', toolName: 'read', input: { filePath: 'opencode-trae-cli-auth/package.json' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'trae-router-read-0', toolName: 'read', output: { type: 'text', value: '{"scripts":{"test":"vitest run"}}' } }] },
      ],
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalled()
    expect(parts.filter((p) => p.type === 'error')).toHaveLength(0)
    const text = parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('')
    expect(text).toContain('Trae CLI')
    expect(text).toContain('vitest run')
    expect(parts.at(-1).finishReason).toBe('stop')
  })

  it('returns a bounded fallback summary after manifest inventory results instead of calling Trae again', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('trae/coding', {
allowCliFallback: true,
cliPath: '/usr/bin/traecli',
      enableToolCalling: true,
      enforceTextOnly: true,
      includeToolHistory: true,
    })

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        { role: 'user', content: [{ type: 'text', text: '帮我阅读当前文件夹下所有仓库的 package.json 与 README.md，给出3条建议' }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'trae-router-manifest-inventory-0', toolName: 'bash', input: { command: 'inventory' } }] },
        {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'trae-router-manifest-inventory-0',
            toolName: 'bash',
            output: { type: 'text', value: '### a/package.json\n{"name":"a","scripts":{"test":"vitest run"}}\n### a/README.md\n# A\n### b/package.json\n{"name":"b","scripts":{"build":"tsc"}}' },
          }],
        },
      ],
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    const text = parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('')
    expect(text).toContain('基于 OpenCode 工具读取结果')
    expect(text).toContain('1.')
    expect(text).toContain('2.')
    expect(text).toContain('3.')
    expect(text).toContain('a/package.json')
    expect(parts.at(-1).finishReason).toBe('stop')
  })

  it('returns manifest file lists for direct package/readme listing requests', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('fast', {
allowCliFallback: true,
cliPath: '/usr/bin/traecli',
      includeToolHistory: true,
    })

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        { role: 'user', content: [{ type: 'text', text: '都有哪些package.json和readme' }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'trae-router-manifest-inventory-0', toolName: 'bash', input: { command: 'inventory' } }] },
        {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'trae-router-manifest-inventory-0',
            toolName: 'bash',
            output: { type: 'text', value: '### a/package.json\n{"name":"a"}\n### a/README.md\n# A\n### b/package.json\n{"name":"b"}' },
          }],
        },
      ],
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    const text = parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('')
    expect(text).toContain('package.json:')
    expect(text).toContain('a/package.json')
    expect(text).toContain('b/package.json')
    expect(text).toContain('README.md:')
    expect(text).toContain('a/README.md')
    expect(text).not.toContain('工程化建议')
    expect(text).not.toContain('1. 先统一')
  })

  it('does not truncate direct package/readme listing requests to summary limits', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('fast', {
allowCliFallback: true,
cliPath: '/usr/bin/traecli',
      includeToolHistory: true,
    })
    const inventory = Array.from({ length: 10 }, (_, index) => [
      `### repo-${index}/package.json`,
      `{"name":"repo-${index}"}`,
      `### repo-${index}/README.md`,
      `# Repo ${index}`,
    ].join('\n')).join('\n')

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        { role: 'user', content: [{ type: 'text', text: '都有哪些package.json和readme' }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'trae-router-manifest-inventory-0', toolName: 'bash', input: { command: 'inventory' } }] },
        {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'trae-router-manifest-inventory-0',
            toolName: 'bash',
            output: { type: 'text', value: inventory },
          }],
        },
      ],
    } as any)).stream as any) parts.push(part)

    const text = parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('')
    expect(text).toContain('repo-0/package.json')
    expect(text).toContain('repo-9/package.json')
    expect(text).toContain('repo-0/README.md')
    expect(text).toContain('repo-9/README.md')
  })

  it('routes manifest glob results to bounded read calls before asking Trae to summarize', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('trae/coding', {
allowCliFallback: true,
cliPath: '/usr/bin/traecli',
      enableToolCalling: true,
      enforceTextOnly: true,
      includeToolHistory: true,
    })

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        { role: 'user', content: [{ type: 'text', text: '帮我阅读当前文件夹下所有仓库的 package.json 与 README.md，给出3条建议' }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'trae-router-glob-0', toolName: 'glob', input: { pattern: '**/package.json' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'trae-router-glob-0', toolName: 'glob', output: { type: 'text', value: 'a/package.json\nsub2api/.opencode/package.json\nsub2api/.opencode/node_modules/which/package.json\nb/package.json\nc/package.json\nd/package.json\ne/package.json\nf/package.json' } }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'trae-router-glob-1', toolName: 'glob', input: { pattern: '**/README.md' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'trae-router-glob-1', toolName: 'glob', output: { type: 'text', value: 'a/README.md\nb/README.md\nc/README.md' } }] },
      ],
      tools: [
        {
          type: 'function',
          name: 'read',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, limit: { type: 'number' } } },
        },
      ],
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(parts.filter((p) => p.type === 'tool-call')).toHaveLength(6)
    expect(parts.filter((p) => p.type === 'tool-call').map((p) => JSON.parse(p.input))).toEqual([
      { filePath: 'a/package.json', limit: 200 },
      { filePath: 'b/package.json', limit: 200 },
      { filePath: 'c/package.json', limit: 200 },
      { filePath: 'a/README.md', limit: 200 },
      { filePath: 'b/README.md', limit: 200 },
      { filePath: 'c/README.md', limit: 200 },
    ])
  })

  it('keeps the original coding task visible after router tool results', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('trae/coding', {
allowCliFallback: true,
cliPath: '/usr/bin/traecli',
      enableToolCalling: true,
      enforceTextOnly: true,
      includeToolHistory: true,
    })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        { role: 'user', content: [{ type: 'text', text: '帮我阅读当前文件夹下所有仓库的 package.json 与 README.md，给出3条建议' }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'trae-router-read-0', toolName: 'read', input: { filePath: 'a/package.json' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'trae-router-read-0', toolName: 'read', output: { type: 'text', value: '{"name":"a"}' } }] },
      ],
    } as any)

    setImmediate(() => {
      stdout.end('{"message":{"content":"ok"}}')
      stderr.end('')
      closeChild(child)
    })
    for await (const _ of (await streamPromise).stream as any) {}

    const [, args] = spawnMock.mock.calls[0]
    expect(args[0]).toContain('Current task reminder:')
    expect(args[0]).toContain('给出3条建议')
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
    const model = new TraeLanguageModel('default', { allowCliFallback: true, cliPath: '/usr/bin/traecli', enableToolCalling: true })
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
    const model = new TraeLanguageModel('default', { allowCliFallback: true, cliPath: '/usr/bin/traecli', enableToolCalling: true })
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
    const model = new TraeLanguageModel('default', { allowCliFallback: true, cliPath: '/usr/bin/traecli', enableToolCalling: true })
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

  it('drops internal reference read tool calls that users do not have', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', {
allowCliFallback: true,
cliPath: '/usr/bin/traecli',
      enableToolCalling: true,
    })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'read codex tool reference' }] }],
      tools: [{
        type: 'function',
        name: 'read',
        inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
      }],
    } as any)

    setImmediate(() => {
      stdout.write(JSON.stringify({
        agent_states: [
          {
            messages: [
              {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call-superpowers-reference',
                    type: 'function',
                    function: {
                      name: 'read',
                      arguments: '{"filePath":"references/codex-tools.md"}',
                    },
                  },
                ],
              },
            ],
          },
        ],
        message: {
          content: '',
        },
      }))
      stderr.end()
      stdout.end()
      closeChild(child)
    })

    const parts: any[] = []
    for await (const part of (await streamPromise).stream as any) parts.push(part)

    expect(parts.find((p) => p.type === 'tool-call')).toBeUndefined()
    expect(parts.find((p) => p.type === 'tool-input-start')).toBeUndefined()
    expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' })
  })

  it('drops other internal tool reference read calls', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', {
      allowCliFallback: true,
      cliPath: '/usr/bin/traecli',
      enableToolCalling: true,
    })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: '当前目录下都有什么，请你评估一下适合做什么' }] }],
      tools: [{
        type: 'function',
        name: 'read',
        inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
      }],
    } as any)

    setImmediate(() => {
      stdout.write(JSON.stringify({
        agent_states: [
          {
            messages: [
              {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call-copilot-reference',
                    type: 'function',
                    function: {
                      name: 'read',
                      arguments: '{"filePath":"references/copilot-tools.md"}',
                    },
                  },
                ],
              },
            ],
          },
        ],
        message: { content: '' },
      }))
      stderr.end()
      stdout.end()
      closeChild(child)
    })

    const parts: any[] = []
    for await (const part of (await streamPromise).stream as any) parts.push(part)

    expect(parts.find((p) => p.type === 'tool-call')).toBeUndefined()
    expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' })
  })

  it('drops injected agent instruction file reads', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = stdout as any
    child.stderr = stderr as any
    child.kill = vi.fn() as any
    spawnMock.mockReturnValue(child)

    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('coding', {
      allowCliFallback: true,
      cliPath: '/usr/bin/traecli',
      enableToolCalling: true,
    })
    const streamPromise = model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: '当前目录下都有什么，请你评估一下适合做什么' }] }],
      tools: [{
        type: 'function',
        name: 'read',
        inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
      }],
    } as any)

    setImmediate(() => {
      stdout.write(JSON.stringify({
        agent_states: [
          {
            messages: [
              {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call-agents-md',
                    type: 'function',
                    function: {
                      name: 'read',
                      arguments: '{"filePath":"AGENTS.md"}',
                    },
                  },
                ],
              },
            ],
          },
        ],
        message: { content: '' },
      }))
      stderr.end()
      stdout.end()
      closeChild(child)
    })

    const parts: any[] = []
    for await (const part of (await streamPromise).stream as any) parts.push(part)

    expect(parts.find((p) => p.type === 'tool-call')).toBeUndefined()
    expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' })
  })

  it('does not deterministic-route broad current directory questions', async () => {
    const { TraeLanguageModel } = await import('../src/trae-language-model.js')
    const model = new TraeLanguageModel('Kimi-K2.6', {
      traeRawBaseURL: 'https://api.enterprise.trae.cn',
      traeRawApiKey: 'test-key',
      enableToolCalling: true,
    } as any)

    const parts: any[] = []
    for await (const part of (await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: '当前目录下都有什么，请你评估一下适合做什么' }] }],
      tools: {
        bash: {
          type: 'function',
          description: 'Run shell command',
          inputSchema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } } },
        },
        read: {
          type: 'function',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
        },
      },
    } as any)).stream as any) parts.push(part)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(parts.find((p) => p.type === 'tool-call')).toBeUndefined()
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
    const model = new TraeLanguageModel('default', { allowCliFallback: true, cliPath: '/usr/bin/traecli', enableToolCalling: true })
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
    const model = new TraeLanguageModel('default', { allowCliFallback: true, cliPath: '/usr/bin/traecli', enableToolCalling: true })
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
    const model = new TraeLanguageModel('default', { allowCliFallback: true, cliPath: '/usr/bin/traecli', enableToolCalling: true })
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
    const model = new TraeLanguageModel('default', { allowCliFallback: true, cliPath: '/usr/bin/traecli', enableToolCalling: true })
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
    const model = new TraeLanguageModel('default', { allowCliFallback: true, cliPath: '/usr/bin/traecli', enableToolCalling: true })
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
    const model = new TraeLanguageModel('default', { allowCliFallback: true, cliPath: '/usr/bin/traecli', enableToolCalling: true })
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
