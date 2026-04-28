import { spawn } from 'node:child_process'
import { parseLastJsonValue, type TraeCliResult } from './json-output.js'

export type CliLlmRunOptions = {
  cliPath?: string
  modelName?: string
  prompt: string
  queryTimeout?: number
  extraArgs?: string[]
  enforceTextOnly?: boolean
  maxRetries?: number
  retryDelayMs?: number
  abortSignal?: AbortSignal
}

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

async function runOnce(args: CliLlmRunOptions): Promise<TraeCliResult> {
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
    ...(args.extraArgs ?? []),
  ]

  const child = spawn(args.cliPath, cliArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  let aborted = false
  let timedOut = false
  const abort = () => {
    aborted = true
    child.kill()
  }
  args.abortSignal?.addEventListener('abort', abort, { once: true })
  const timeoutSeconds = normalizeTimeoutSeconds(args.queryTimeout ?? 120)
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutSeconds * 1000)
  timeout.unref?.()

  try {
    const stdoutPromise = readStream(child.stdout)
    const stderrPromise = readStream(child.stderr)
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve(code))
    })
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])

    if (aborted) throw new Error('traecli request aborted')
    if (timedOut) throw new Error(`traecli timed out after ${formatDuration(timeoutSeconds)}`)
    if (exitCode !== 0 && !stdout.trim()) {
      throw new Error(stderr.trim() || `traecli exited with code ${exitCode}`)
    }
    return parseLastJsonValue(`${stdout}\n${stderr}`)
  } finally {
    clearTimeout(timeout)
    args.abortSignal?.removeEventListener('abort', abort)
  }
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

function readStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stream) return resolve('')
    const chunks: string[] = []
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => chunks.push(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(chunks.join('')))
  })
}
