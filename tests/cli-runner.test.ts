import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

const spawnMock = vi.fn()
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

function makeChild() {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  child.stdout = stdout as any
  child.stderr = stderr as any
  child.kill = vi.fn() as any
  return { child, stdout, stderr }
}

describe('runCliLlm', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    spawnMock.mockReset()
  })

  it('runs trae cli with print json arguments and parses output', async () => {
    const { child, stdout, stderr } = makeChild()
    spawnMock.mockReturnValue(child)
    const { runCliLlm } = await import('../src/cli/cli-runner.js')
    const promise = runCliLlm({
      cliPath: '/usr/bin/traecli',
      prompt: 'hello',
      modelName: 'GLM-5.1',
      sessionId: 'sid-123',
      queryTimeout: 33,
    })

    stdout.end('{"message":{"content":"ok"}}')
    stderr.end('')
    child.emit('close', 0)

    await expect(promise).resolves.toMatchObject({ message: { content: 'ok' } })
    expect(spawnMock.mock.calls[0][1]).toEqual([
      'hello',
      '-p',
      '--json',
      '--query-timeout',
      '33s',
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
      'model.name=GLM-5.1',
      '--session-id',
      'sid-123',
    ])
  })

  it('can disable text-only enforcement for compatibility', async () => {
    const { child, stdout, stderr } = makeChild()
    spawnMock.mockReturnValue(child)
    const { runCliLlm } = await import('../src/cli/cli-runner.js')
    const promise = runCliLlm({
      cliPath: '/usr/bin/traecli',
      prompt: 'hello',
      enforceTextOnly: false,
    })

    stdout.end('{"message":{"content":"ok"}}')
    stderr.end('')
    child.emit('close', 0)

    await expect(promise).resolves.toMatchObject({ message: { content: 'ok' } })
    expect(spawnMock.mock.calls[0][1]).toEqual([
      'hello',
      '-p',
      '--json',
      '--query-timeout',
      '120s',
    ])
  })

  it('kills the process on abort', async () => {
    const { child, stdout, stderr } = makeChild()
    spawnMock.mockReturnValue(child)
    const { runCliLlm } = await import('../src/cli/cli-runner.js')
    const controller = new AbortController()
    const promise = runCliLlm({
      cliPath: '/usr/bin/traecli',
      prompt: 'hello',
      abortSignal: controller.signal,
    })

    controller.abort()
    stdout.end('')
    stderr.end('')
    child.emit('close', null)

    await expect(promise).rejects.toThrow(/aborted/)
    expect(child.kill).toHaveBeenCalled()
  })

  it('fails fast when already aborted before spawn', async () => {
    const { runCliLlm } = await import('../src/cli/cli-runner.js')
    const controller = new AbortController()
    controller.abort()

    await expect(runCliLlm({
      cliPath: '/usr/bin/traecli',
      prompt: 'hello',
      abortSignal: controller.signal,
    })).rejects.toThrow(/aborted/)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('kills the process when the provider timeout elapses', async () => {
    vi.useFakeTimers()
    const { child, stdout, stderr } = makeChild()
    spawnMock.mockReturnValue(child)
    const { runCliLlm } = await import('../src/cli/cli-runner.js')
    const promise = runCliLlm({
      cliPath: '/usr/bin/traecli',
      prompt: 'hello',
      queryTimeout: 1,
      maxRetries: 0,
    })
    const rejection = expect(promise).rejects.toThrow(/timed out after 1s/)

    await vi.advanceTimersByTimeAsync(1000)
    stdout.end('')
    stderr.end('')
    child.emit('close', null)

    await rejection
    expect(child.kill).toHaveBeenCalled()
  })

  it('times out even when close event is never emitted', async () => {
    vi.useFakeTimers()
    const { child } = makeChild()
    spawnMock.mockReturnValue(child)
    const { runCliLlm } = await import('../src/cli/cli-runner.js')
    const promise = runCliLlm({
      cliPath: '/usr/bin/traecli',
      prompt: 'hello',
      queryTimeout: 1,
      maxRetries: 0,
    })
    const rejection = expect(promise).rejects.toThrow(/timed out after 1s/)

    await vi.advanceTimersByTimeAsync(1000)

    await rejection
    expect(child.kill).toHaveBeenCalled()
  })

  it('aborts even when close event is never emitted', async () => {
    const { child } = makeChild()
    spawnMock.mockReturnValue(child)
    const { runCliLlm } = await import('../src/cli/cli-runner.js')
    const controller = new AbortController()
    const promise = runCliLlm({
      cliPath: '/usr/bin/traecli',
      prompt: 'hello',
      abortSignal: controller.signal,
    })

    controller.abort()

    await expect(promise).rejects.toThrow(/aborted/)
    expect(child.kill).toHaveBeenCalled()
  })

  it('retries once on transient failure', async () => {
    const first = makeChild()
    const second = makeChild()
    spawnMock.mockImplementationOnce(() => first.child).mockImplementationOnce(() => {
      setImmediate(() => {
        second.stdout.end('')
        second.stderr.end('tenantsecurity: fetch mcp whitelist returned code 30017')
        second.child.emit('close', 2)
      })
      return second.child
    })
    const { runCliLlm } = await import('../src/cli/cli-runner.js')

    const promise = runCliLlm({
      cliPath: '/usr/bin/traecli',
      prompt: 'hello',
      retryDelayMs: 0,
      maxRetries: 1,
    })

    first.stdout.end('')
    first.stderr.end('tenantsecurity: fetch mcp whitelist returned code 30017')
    first.child.emit('close', 2)

    await expect(promise).rejects.toThrow(/tenantsecurity/i)
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })
})
