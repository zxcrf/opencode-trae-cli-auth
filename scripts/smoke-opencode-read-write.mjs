#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const args = parseArgs(process.argv.slice(2))
const model = args.model ?? 'trae/GLM-5.1'
const timeoutMs = normalizeInt(args.timeoutMs, 180000)
const keep = args.keep === 'true'
const tmpRoot = args.tmpRoot ?? '/private/tmp'
const opencodeCmd = args.opencodeCmd ?? 'opencode'

const root = await mkdtemp(join(tmpRoot, 'opencode-trae-rw-smoke-'))
await seedWorkspace(root)

const cases = [
  {
    name: 'bash lists the working directory',
    expectedTools: ['bash'],
    prompt: [
      'Use OpenCode Bash tool exactly once to run `pwd` in the current directory.',
      'Then answer with the absolute path only.',
      'Do not use Trae internal tools.',
    ].join(' '),
  },
  {
    name: 'read reads a file',
    expectedTools: ['read'],
    prompt: [
      'Use OpenCode Read tool to read README.md.',
      'Then answer with only the first markdown heading.',
      'Do not use Bash for this task.',
    ].join(' '),
    expectTextIncludes: ['# Smoke Workspace'],
  },
  {
    name: 'glob finds package manifests',
    expectedTools: ['glob'],
    prompt: [
      'Use OpenCode Glob tool with pattern **/package.json.',
      'Then answer with only the matching relative paths.',
      'Do not use Bash for this task.',
    ].join(' '),
    expectTextIncludes: ['package.json', 'nested/package.json'],
  },
  {
    name: 'grep searches file contents',
    expectedTools: ['grep'],
    prompt: [
      'Use OpenCode Grep tool to search for the string TRAE_SMOKE_MARKER.',
      'Then answer with only the matching file path.',
      'Do not use Bash for this task.',
    ].join(' '),
    expectTextIncludes: ['src/app.ts'],
  },
  {
    name: 'write creates a file',
    expectedTools: ['write'],
    prompt: [
      'Use OpenCode Write tool to create generated.txt with exactly this content: alpha from write tool',
      'Then answer with only "written".',
      'Do not use Bash for this task.',
    ].join(' '),
    verifyFile: {
      path: 'generated.txt',
      includes: 'alpha from write tool',
    },
  },
  {
    name: 'edit updates an existing file',
    expectedTools: ['edit'],
    prompt: [
      'Use OpenCode Edit tool to replace NEEDS_EDIT with EDITED_OK in editable.txt.',
      'Then answer with only "edited".',
      'Do not use Bash for this task.',
    ].join(' '),
    verifyFile: {
      path: 'editable.txt',
      includes: 'EDITED_OK',
      excludes: 'NEEDS_EDIT',
    },
  },
]

if (args.includeScaffold === 'true') {
  cases.push({
    name: 'project scaffold starts with bash execution',
    expectedTools: ['bash'],
    prompt: [
      '初始化一个 Next.js + Prisma + React 的工程。',
      '选择：SQLite、App Router、博客。',
      'Use OpenCode Bash tool to create the project scaffolding.',
      'After the tool runs, summarize the created project path.',
    ].join(' '),
    expectTextIncludes: ['next'],
  })
}

console.log(`Starting OpenCode read/write smoke: model=${model} timeoutMs=${timeoutMs}`)
console.log(`opencodeCmd=${opencodeCmd}`)
console.log(`workspace=${root}`)

const summaries = []
let failed = false

try {
  for (const testCase of cases) {
    const startedAt = Date.now()
    const result = await runOpenCode({
      cwd: root,
      model,
      timeoutMs,
      prompt: testCase.prompt,
      opencodeCmd,
    })
    const durationMs = Date.now() - startedAt
    const events = parseJsonEvents(result.stdout)
    const tools = extractToolNames(events)
    const text = extractText(events)
    const missingTools = testCase.expectedTools.filter((tool) => !tools.includes(tool))
    const textMissing = (testCase.expectTextIncludes ?? []).filter((needle) => !text.includes(needle))
    const fileError = testCase.verifyFile ? await verifyFile(root, testCase.verifyFile) : undefined
    const ok = result.exitCode === 0 && missingTools.length === 0 && textMissing.length === 0 && !fileError

    summaries.push({
      name: testCase.name,
      ok,
      exitCode: result.exitCode,
      durationMs,
      tools,
      missingTools,
      textMissing,
      fileError,
      stderr: result.stderr.trim(),
      text: text.trim(),
    })
    if (!ok) failed = true
    printCaseSummary(summaries.at(-1))
  }
} finally {
  if (!keep) await rm(root, { recursive: true, force: true })
}

console.log('\n=== OpenCode Read/Write Smoke Summary ===')
for (const summary of summaries) {
  console.log(`${summary.ok ? 'PASS' : 'FAIL'} ${summary.name} tools=${summary.tools.join(',') || '(none)'} durationMs=${summary.durationMs}`)
}

if (failed) process.exitCode = 1

async function seedWorkspace(dir) {
  await writeFile(join(dir, 'README.md'), '# Smoke Workspace\n\nThis workspace is for real OpenCode tool smoke tests.\n')
  await writeFile(join(dir, 'package.json'), '{"name":"smoke-root","version":"1.0.0"}\n')
  await writeFile(join(dir, 'editable.txt'), 'before NEEDS_EDIT after\n')
  await import('node:fs/promises').then(async ({ mkdir }) => {
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'app.ts'), 'export const marker = "TRAE_SMOKE_MARKER"\n')
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(join(dir, 'nested', 'package.json'), '{"name":"smoke-nested","version":"1.0.0"}\n')
  })
}

function runOpenCode({ cwd, model, timeoutMs, prompt, opencodeCmd }) {
  return new Promise((resolve) => {
    const command = [
      opencodeCmd,
      'run',
      '--agent',
      'build',
      '--format',
      'json',
      '--model',
      shellQuote(model),
      shellQuote(prompt),
    ].join(' ')
    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let resolved = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!resolved) child.kill('SIGKILL')
      }, 3000).unref?.()
    }, timeoutMs)
    timer.unref?.()

    const finish = (exitCode) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      resolve({ exitCode: timedOut ? -1 : (exitCode ?? -1), stdout, stderr })
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (err) => {
      stderr += `\n[smoke] spawn error: ${String(err)}`
      finish(-1)
    })
    child.on('close', finish)
  })
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function parseJsonEvents(stdout) {
  const out = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
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

function extractToolNames(events) {
  const tools = []
  for (const event of events) {
    if (event.type === 'tool_use') {
      const tool = String(event.part?.tool ?? '').toLowerCase()
      if (tool) tools.push(tool)
    }
    if (event.type === 'tool-call') {
      const tool = String(event.toolName ?? event.part?.toolName ?? '').toLowerCase()
      if (tool) tools.push(tool)
    }
  }
  return [...new Set(tools)]
}

function extractText(events) {
  return events
    .filter((event) => event.type === 'text')
    .map((event) => String(event.part?.text ?? event.text ?? ''))
    .join('\n')
}

async function verifyFile(root, expected) {
  let text = ''
  try {
    text = await readFile(join(root, expected.path), 'utf8')
  } catch (err) {
    return `unable to read ${expected.path}: ${String(err)}`
  }
  if (expected.includes && !text.includes(expected.includes)) {
    return `${expected.path} does not include ${JSON.stringify(expected.includes)}`
  }
  if (expected.excludes && text.includes(expected.excludes)) {
    return `${expected.path} still includes ${JSON.stringify(expected.excludes)}`
  }
  return undefined
}

function printCaseSummary(summary) {
  console.log(`\n[${summary.ok ? 'PASS' : 'FAIL'}] ${summary.name}`)
  console.log(`exitCode=${summary.exitCode} durationMs=${summary.durationMs} tools=${summary.tools.join(',') || '(none)'}`)
  if (summary.missingTools.length) console.log(`missingTools=${summary.missingTools.join(',')}`)
  if (summary.textMissing.length) console.log(`textMissing=${summary.textMissing.join(',')}`)
  if (summary.fileError) console.log(`fileError=${summary.fileError}`)
  if (summary.stderr) console.log(`stderr=${summary.stderr.slice(0, 500)}`)
  if (!summary.ok && summary.text) console.log(`text=${summary.text.slice(0, 500)}`)
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
