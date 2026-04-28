#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'

const args = parseArgs(process.argv.slice(2))
const model = args.model ?? 'trae/coding'
const cwd = args.cwd ?? process.cwd()
const durationHours = normalizeFloat(args.hours, 8)
const durationMs = Math.max(60_000, Math.floor(durationHours * 3600_000))
const maxRuns = args.maxRuns ? normalizeInt(args.maxRuns, 1) : undefined
const concurrency = normalizeInt(args.concurrency, 2)
const timeoutMs = normalizeInt(args.timeoutMs, 180_000)
const promptsFile = args.promptsFile ?? args.prompts
const outDir = path.resolve(cwd, args.outDir ?? 'artifacts/overnight')
const outJsonl = path.join(outDir, `run-${Date.now()}.jsonl`)
const outSummary = outJsonl.replace(/\.jsonl$/, '.summary.json')

if (!promptsFile) {
  console.error('Missing --promptsFile. Provide a text file with one prompt per line.')
  process.exit(2)
}

const prompts = loadPrompts(path.resolve(cwd, promptsFile))
if (prompts.length === 0) {
  console.error(`No prompts loaded from ${promptsFile}`)
  process.exit(2)
}

mkdirSync(outDir, { recursive: true })
writeFileSync(outJsonl, '')

console.log(`Starting overnight run: model=${model} hours=${durationHours} concurrency=${concurrency} timeoutMs=${timeoutMs}`)
console.log(`prompts=${prompts.length} out=${outJsonl}`)

const startedAt = Date.now()
const deadlineAt = startedAt + durationMs
const state = {
  total: 0,
  success: 0,
  failure: 0,
  timeouts: 0,
  durations: [],
}

await runPool(concurrency, async (workerId) => {
  while (Date.now() < deadlineAt) {
    if (maxRuns !== undefined && state.total >= maxRuns) break
    const idx = state.total % prompts.length
    const prompt = prompts[idx]
    state.total += 1
    const item = await runOnce({ cwd, model, prompt, timeoutMs, index: state.total, workerId })
    if (item.ok) state.success += 1
    else state.failure += 1
    if (item.timedOut) state.timeouts += 1
    state.durations.push(item.durationMs)
    appendFileSync(outJsonl, `${JSON.stringify(item)}\n`)
  }
})

const endedAt = Date.now()
const sorted = [...state.durations].sort((a, b) => a - b)
const summary = {
  model,
  cwd,
  promptsFile: path.resolve(cwd, promptsFile),
  startedAt: new Date(startedAt).toISOString(),
  endedAt: new Date(endedAt).toISOString(),
  elapsedMs: endedAt - startedAt,
  elapsedHours: Number(((endedAt - startedAt) / 3600_000).toFixed(3)),
  maxRuns: maxRuns ?? null,
  total: state.total,
  success: state.success,
  failure: state.failure,
  timeout: state.timeouts,
  successRate: state.total > 0 ? Number(((state.success / state.total) * 100).toFixed(2)) : 0,
  p50Ms: percentile(sorted, 50),
  p95Ms: percentile(sorted, 95),
  p99Ms: percentile(sorted, 99),
  maxMs: sorted[sorted.length - 1] ?? 0,
  outJsonl,
}

writeFileSync(outSummary, `${JSON.stringify(summary, null, 2)}\n`)

console.log('\n=== Overnight Summary ===')
console.log(JSON.stringify(summary, null, 2))
process.exitCode = summary.failure > 0 ? 1 : 0

function runPool(concurrencyLimit, worker) {
  return Promise.all(
    Array.from({ length: concurrencyLimit }, (_, i) => worker(i + 1)),
  )
}

function runOnce({ cwd, model, prompt, timeoutMs, index, workerId }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn('opencode', ['run', '--format', 'json', '--model', model, prompt], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 3000).unref?.()
    }, timeoutMs)
    timer.unref?.()

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (err) => {
      clearTimeout(timer)
      const endedAt = Date.now()
      resolve({
        t: new Date(endedAt).toISOString(),
        index,
        workerId,
        ok: false,
        timedOut,
        exitCode: -1,
        durationMs: endedAt - startedAt,
        prompt,
        events: 0,
        toolCalls: 0,
        finishReasons: [],
        textPreview: '',
        stderr: `[spawn-error] ${String(err)}`.slice(0, 2000),
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const endedAt = Date.now()
      const events = parseJsonEvents(stdout)
      const toolCalls = events.filter((e) => e.type === 'tool-call').length
      const finishReasons = events
        .filter((e) => e.type === 'step_finish' || e.type === 'finish')
        .map((e) => stringify(e.part?.reason ?? e.finishReason))
        .filter(Boolean)
      const textPreview = events
        .filter((e) => e.type === 'text')
        .map((e) => String(e.part?.text ?? '').trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 280)

      resolve({
        t: new Date(endedAt).toISOString(),
        index,
        workerId,
        ok: !timedOut && (code ?? -1) === 0,
        timedOut,
        exitCode: code ?? -1,
        durationMs: endedAt - startedAt,
        prompt,
        events: events.length,
        toolCalls,
        finishReasons,
        textPreview,
        stderr: stderr.trim().slice(0, 2000),
      })
    })
  })
}

function parseJsonEvents(stdout) {
  const out = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line || line[0] !== '{') continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') out.push(parsed)
    } catch {
      continue
    }
  }
  return out
}

function stringify(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function percentile(values, p) {
  if (values.length === 0) return 0
  const rank = Math.ceil((p / 100) * values.length) - 1
  return values[Math.max(0, Math.min(values.length - 1, rank))]
}

function loadPrompts(file) {
  const raw = readFileSync(file, 'utf8')
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

function normalizeInt(raw, fallback) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.floor(n))
}

function normalizeFloat(raw, fallback) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0.1, n)
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
