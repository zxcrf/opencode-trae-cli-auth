import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createTraeModelDefinition, type TraeModelDefinition } from './models.js'

type DiscoveredTraeModel = {
  name: string
  description?: string
  contextWindow?: number
}

export function discoverTraeModels(cwd = process.cwd()): Record<string, TraeModelDefinition> {
  const discovered = new Map<string, DiscoveredTraeModel>()
  for (const filePath of getTraeConfigPaths(cwd)) {
    for (const model of extractModelsFromYaml(readTextIfExists(filePath))) {
      discovered.set(model.name, model)
    }
  }

  return Object.fromEntries(
    [...discovered.values()].map((model) => [
      model.name,
      createTraeModelDefinition(model.name, model.description, model.contextWindow),
    ]),
  )
}

function getTraeConfigPaths(cwd: string): string[] {
  const paths = [
    join(homedir(), '.trae', 'traecli.yaml'),
    join(homedir(), '.trae', 'trae_cli.yaml'),
  ]

  let current = cwd
  while (true) {
    paths.push(join(current, '.coco', 'coco.yaml'))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return paths
}

function readTextIfExists(filePath: string): string | undefined {
  try {
    return existsSync(filePath) ? readFileSync(filePath, 'utf8') : undefined
  } catch {
    return undefined
  }
}

export function extractModelsFromYaml(source: string | undefined): DiscoveredTraeModel[] {
  if (!source) return []
  const lines = source.replace(/\t/g, '  ').split(/\r?\n/)
  const result: DiscoveredTraeModel[] = []

  const currentModelName = extractCurrentModelName(lines)
  if (currentModelName) result.push({ name: currentModelName, description: `Trae ${currentModelName}` })

  const modelsLine = lines.findIndex((line) => /^models:\s*(?:#.*)?$/.test(line.trim()))
  if (modelsLine < 0) return dedupeModels(result)
  let current: DiscoveredTraeModel | undefined
  let inModels = false

  for (let i = modelsLine + 1; i < lines.length; i += 1) {
    const raw = stripComment(lines[i])
    if (!raw.trim()) continue
    const indent = leadingSpaces(raw)
    const trimmed = raw.trim()

    if (indent === 0) break
    if (!inModels && indent < 2) break
    inModels = true

    if (trimmed.startsWith('- ')) {
      if (current?.name) result.push(current)
      current = {}
      applyModelField(current, trimmed.slice(2).trim())
      continue
    }

    if (!current || indent < 4) continue
    applyModelField(current, trimmed)
  }

  if (current?.name) result.push(current)
  return dedupeModels(result)
}

function extractCurrentModelName(lines: string[]): string | undefined {
  const modelLine = lines.findIndex((line) => /^model:\s*(?:#.*)?$/.test(line.trim()))
  if (modelLine < 0) return undefined

  for (let i = modelLine + 1; i < lines.length; i += 1) {
    const raw = stripComment(lines[i])
    if (!raw.trim()) continue
    const indent = leadingSpaces(raw)
    if (indent === 0) break
    const match = /^name:\s*(.*)$/.exec(raw.trim())
    if (match) return unquote(match[1].trim()) || undefined
  }

  return undefined
}

function dedupeModels(models: DiscoveredTraeModel[]): DiscoveredTraeModel[] {
  return models.filter((model, index, all) => all.findIndex((item) => item.name === model.name) === index)
}

function applyModelField(model: Partial<DiscoveredTraeModel>, line: string): void {
  const match = /^(name|description|context_window):\s*(.*)$/.exec(line)
  if (!match) return
  const [, key, rawValue] = match
  const value = unquote(rawValue.trim())
  if (!value) return
  if (key === 'name') model.name = value
  if (key === 'description') model.description = value
  if (key === 'context_window') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) model.contextWindow = parsed
  }
}

function stripComment(line: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"' && !inSingle) inDouble = !inDouble
    if (ch === "'" && !inDouble) inSingle = !inSingle
    if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i)
  }
  return line
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, '')
}
