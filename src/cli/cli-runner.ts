import { spawn } from 'node:child_process'
import { parseJsonValues, parseLastJsonValue, type TraeCliResult } from './json-output.js'

export type CliLlmRunOptions = {
  cliPath?: string
  modelName?: string
  sessionId?: string
  prompt: string
  queryTimeout?: number
  extraArgs?: string[]
  enforceTextOnly?: boolean
  maxRetries?: number
  retryDelayMs?: number
  abortSignal?: AbortSignal
}

export type CliLlmStreamAction = 'continue' | 'stop'

const DEFAULT_DISALLOWED_TOOLS = ['Read', 'Bash', 'Edit', 'Replace', 'Write', 'Glob', 'Grep', 'Task'] as const

export async function runCliLlm(args: CliLlmRunOptions): Promise<TraeCliResult> {
  if (!args.cliPath) {
    throw new Error('traecli binary not found. Install traecli and ensure it is on PATH.')
  }

  const maxRetries = normalizeRetryCount(args.maxRetries ?? 1)
  const retryDelayMs = normalizeDelayMs(args.retryDelayMs ?? 800)
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await runOnce(args)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (!shouldRetry(lastError, attempt, maxRetries, args.abortSignal)) throw lastError
      await waitWithAbort(retryDelayMs, args.abortSignal)
    }
  }

  throw lastError ?? new Error('traecli request failed')
}

export async function runCliLlmStreaming(
  args: CliLlmRunOptions,
  onResult: (result: TraeCliResult) => CliLlmStreamAction | void,
): Promise<TraeCliResult> {
  if (!args.cliPath) {
    throw new Error('traecli binary not found. Install traecli and ensure it is on PATH.')
  }

  const maxRetries = normalizeRetryCount(args.maxRetries ?? 1)
  const retryDelayMs = normalizeDelayMs(args.retryDelayMs ?? 800)
  let lastError: Error | undefined
  let emitted = false

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await runStreamingOnce(args, (result) => {
        emitted = true
        return onResult(result)
      })
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (emitted || !shouldRetry(lastError, attempt, maxRetries, args.abortSignal)) throw lastError
      await waitWithAbort(retryDelayMs, args.abortSignal)
    }
  }

  throw lastError ?? new Error('traecli request failed')
}

async function runOnce(args: CliLlmRunOptions): Promise<TraeCliResult> {
  let lastResult: TraeCliResult | undefined
  return runStreamingOnce(args, (result) => {
    lastResult = result
  }).then((result) => result ?? lastResult ?? parseLastJsonValue(''))
}

async function runStreamingOnce(
  args: CliLlmRunOptions,
  onResult: (result: TraeCliResult) => CliLlmStreamAction | void,
): Promise<TraeCliResult> {
  if (args.abortSignal?.aborted) {
    throw new Error('traecli request aborted')
  }
  const disallowToolsArgs =
    args.enforceTextOnly === false ? [] : DEFAULT_DISALLOWED_TOOLS.flatMap((name) => ['--disallowed-tool', name])

  const cliArgs = [
    args.prompt,
    '-p',
    '--json',
    '--query-timeout',
    formatDuration(args.queryTimeout ?? 120),
    ...disallowToolsArgs,
    ...(args.modelName ? ['--config', `model.name=${args.modelName}`] : []),
    ...(args.sessionId ? ['--session-id', args.sessionId] : []),
    ...(args.extraArgs ?? []),
  ]

  const child = spawn(args.cliPath, cliArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  const timeoutSeconds = normalizeTimeoutSeconds(args.queryTimeout ?? 120)
  return await new Promise<TraeCliResult>((resolve, reject) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let stdoutPending = ''
    let lastResult: TraeCliResult | undefined
    let timeout: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      args.abortSignal?.removeEventListener('abort', onAbort)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
      child.stdout?.removeListener('data', onStdoutData)
      child.stderr?.removeListener('data', onStderrData)
      fn()
    }

    const killChild = () => {
      child.kill('SIGTERM')
      if (killTimer) clearTimeout(killTimer)
      killTimer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 300)
      killTimer.unref?.()
    }

    const onStdoutData = (chunk: string | Buffer) => {
      const text = String(chunk)
      stdout += text
      stdoutPending += text
      const parsed = parseJsonValues(stdoutPending)
      stdoutPending = parsed.rest
      for (const result of parsed.values) {
        lastResult = result
        if (onResult(result) === 'stop') {
          killChild()
          finish(() => resolve(result))
          return
        }
      }
    }
    const onStderrData = (chunk: string | Buffer) => {
      stderr += String(chunk)
    }

    const onAbort = () => {
      killChild()
      finish(() => reject(new Error('traecli request aborted')))
    }

    const onTimeout = () => {
      killChild()
      finish(() => reject(new Error(`traecli timed out after ${formatDuration(timeoutSeconds)}`)))
    }

    const onError = (error: unknown) => {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))))
    }

    const onClose = (exitCode: number | null) => {
      finish(() => {
        if (exitCode !== 0 && !stdout.trim()) {
          reject(new Error(stderr.trim() || `traecli exited with code ${exitCode}`))
          return
        }
        try {
          const result = lastResult ?? parseLastJsonValue(`${stdout}\n${stderr}`)
          resolve(result)
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    }

    child.stdout?.on('data', onStdoutData)
    child.stderr?.on('data', onStderrData)
    child.once('error', onError)
    child.once('close', onClose)
    args.abortSignal?.addEventListener('abort', onAbort, { once: true })

    timeout = setTimeout(onTimeout, timeoutSeconds * 1000)
    timeout.unref?.()
  })
}

function shouldRetry(error: Error, attempt: number, maxRetries: number, abortSignal?: AbortSignal): boolean {
  if (abortSignal?.aborted) return false
  if (attempt >= maxRetries) return false
  const msg = error.message.toLowerCase()
  return (
    msg.includes('timed out') ||
    msg.includes('tenantsecurity') ||
    msg.includes('fetch mcp whitelist') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('connection reset')
  )
}

function waitWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('traecli request aborted'))
    }
    if (abortSignal?.aborted) return onAbort()
    abortSignal?.addEventListener('abort', onAbort, { once: true })
  })
}

function formatDuration(seconds: number): string {
  return `${normalizeTimeoutSeconds(seconds)}s`
}

function normalizeTimeoutSeconds(seconds: number): number {
  return Math.max(1, Math.floor(seconds))
}

function normalizeRetryCount(count: number): number {
  return Math.max(0, Math.floor(count))
}

function normalizeDelayMs(delayMs: number): number {
  return Math.max(0, Math.floor(delayMs))
}
