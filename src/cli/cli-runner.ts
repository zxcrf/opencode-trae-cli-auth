import { spawn } from 'node:child_process'
import { parseLastJsonValue, type TraeCliResult } from './json-output.js'

export type CliLlmRunOptions = {
  cliPath?: string
  modelName?: string
  prompt: string
  queryTimeout?: number
  extraArgs?: string[]
  abortSignal?: AbortSignal
}

export async function runCliLlm(args: CliLlmRunOptions): Promise<TraeCliResult> {
  if (!args.cliPath) {
    throw new Error('traecli binary not found. Install traecli and ensure it is on PATH.')
  }

  const cliArgs = [
    args.prompt,
    '-p',
    '--json',
    '--query-timeout',
    formatDuration(args.queryTimeout ?? 120),
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

function formatDuration(seconds: number): string {
  return `${normalizeTimeoutSeconds(seconds)}s`
}

function normalizeTimeoutSeconds(seconds: number): number {
  return Math.max(1, Math.floor(seconds))
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
