#!/usr/bin/env node

import { spawn } from 'node:child_process'

const args = parseArgs(process.argv.slice(2))
const model = args.model ?? 'trae/coding'
const strict = args.strict === 'true'
const timeoutMs = normalizeInt(args.timeoutMs, 180000)
const cwd = args.cwd ?? process.cwd()
const prompt =
  args.prompt ??
  'Use tool read to read README.md and reply with only the first markdown heading.'

console.log(`Starting tool-call smoke: model=${model} strict=${strict} timeoutMs=${timeoutMs}`)

const startedAt = Date.now()
const result = await runOnce({
  cwd,
  timeoutMs,
  cmd: 'opencode',
  argv: ['run', '--format', 'json', '--model', model, prompt],
})
const durationMs = Date.now() - startedAt

const events = parseJsonEvents(result.stdout)
const toolCalls = events.filter((e) => e.type === 'tool-call' || e.type === 'tool_use')
const finishEvents = events.filter((e) => e.type === 'finish')
const hasToolCall = toolCalls.length > 0
const finishReasons = finishEvents
  .map((e) => stringify(e.finishReason))
  .filter(Boolean)

console.log('\n=== Tool-call Smoke Summary ===')
console.log(`exitCode=${result.exitCode} durationMs=${durationMs}`)
console.log(`events=${events.length} toolCalls=${toolCalls.length} finishReasons=${finishReasons.join(',') || '(none)'}`)
if (result.stderr.trim()) {
  console.log(`stderr=${result.stderr.trim().slice(0, 320)}`)
}

if (hasToolCall) {
  console.log('status=PASS tool-call events detected')
} else {
  console.log('status=WARN no tool-call events detected')
}

if (strict && (!hasToolCall || result.exitCode !== 0)) {
  process.exitCode = 1
}

function runOnce({ cwd, timeoutMs, cmd, argv }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let resolved = false
    const finish = (exitCode) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      resolve({
        exitCode,
        stdout,
        stderr,
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!resolved) child.kill('SIGKILL')
      }, 3000).unref?.()
      setTimeout(() => {
        if (!resolved) {
          stderr += '\n[smoke] forced timeout resolution'
          finish(-1)
        }
      }, 6000).unref?.()
    }, timeoutMs)
    timer.unref?.()

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (err) => {
      stderr += `\n[smoke] spawn error: ${String(err)}`
      finish(-1)
    })
    child.on('close', (code) => {
      finish(timedOut ? -1 : (code ?? -1))
    })
  })
}

function parseJsonEvents(stdout) {
  const out = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (!line || line[0] !== '{') continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
        out.push(parsed)
      }
    } catch {
      continue
    }
  }
  return out
}

function stringify(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function normalizeInt(raw, fallback) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.floor(n))
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) {
      out[key.slice(2)] = 'true'
      continue
    }
    out[key.slice(2)] = value
    i += 1
  }
  return out
}
