#!/usr/bin/env node

import { spawn } from 'node:child_process'

const args = parseArgs(process.argv.slice(2))
const model = args.model ?? 'trae/default'
const runs = normalizeInt(args.runs, 12)
const concurrency = normalizeInt(args.concurrency, 3)
const timeoutMs = normalizeInt(args.timeoutMs, 180000)
const cwd = args.cwd ?? process.cwd()

const prompts = Array.from({ length: runs }, (_, i) => `reply exactly: soak-${i + 1}-ok`)

console.log(`Starting soak test: model=${model} runs=${runs} concurrency=${concurrency} timeoutMs=${timeoutMs}`)

const startedAt = Date.now()
const results = await runPool(prompts, concurrency, (prompt, idx) => runOnce({ model, prompt, cwd, timeoutMs, idx }))
const totalMs = Date.now() - startedAt

const successes = results.filter((r) => r.ok)
const failures = results.filter((r) => !r.ok)
const durations = results.map((r) => r.durationMs).sort((a, b) => a - b)

console.log('\n=== Soak Summary ===')
console.log(`total=${results.length} success=${successes.length} failure=${failures.length} successRate=${((successes.length / results.length) * 100).toFixed(1)}%`)
console.log(`duration total=${totalMs}ms p50=${percentile(durations, 50)}ms p95=${percentile(durations, 95)}ms max=${durations[durations.length - 1] ?? 0}ms`)

if (failures.length > 0) {
  console.log('\n=== Failures ===')
  for (const f of failures.slice(0, 10)) {
    console.log(`#${f.index + 1} exit=${f.exitCode} duration=${f.durationMs}ms`)
    console.log(`error=${(f.error ?? '').slice(0, 280)}`)
  }
}

process.exitCode = failures.length > 0 ? 1 : 0

function runPool(items, concurrency, worker) {
  return new Promise((resolve) => {
    const out = new Array(items.length)
    let inFlight = 0
    let next = 0
    const pump = () => {
      while (inFlight < concurrency && next < items.length) {
        const idx = next++
        inFlight += 1
        worker(items[idx], idx)
          .then((res) => { out[idx] = res })
          .catch((err) => {
            out[idx] = {
              index: idx,
              ok: false,
              durationMs: 0,
              exitCode: -1,
              output: '',
              error: String(err),
            }
          })
          .finally(() => {
            inFlight -= 1
            if (next >= items.length && inFlight === 0) return resolve(out)
            pump()
          })
      }
    }
    pump()
  })
}

function runOnce({ model, prompt, cwd, timeoutMs, idx }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn('opencode', ['run', '--model', model, prompt], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    timer.unref?.()

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => {
      clearTimeout(timer)
      const durationMs = Date.now() - startedAt
      resolve({
        index: idx,
        ok: code === 0,
        durationMs,
        exitCode: code ?? -1,
        output: extractLastContent(stdout),
        error: stderr.trim(),
      })
    })
  })
}

function extractLastContent(text) {
  const lines = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !s.includes('orchestrator · default'))
  return lines[lines.length - 1] ?? ''
}

function percentile(values, p) {
  if (values.length === 0) return 0
  const rank = Math.ceil((p / 100) * values.length) - 1
  return values[Math.max(0, Math.min(values.length - 1, rank))]
}

function normalizeInt(raw, fallback) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.floor(n))
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
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
