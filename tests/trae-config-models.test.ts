import { describe, expect, it } from 'vitest'
import { extractModelsFromYaml } from '../src/trae-config-models.js'

describe('trae config model discovery', () => {
  it('extracts real model names from Trae YAML config', () => {
    const models = extractModelsFromYaml(`
model:
  name: "sonnet"
models:
  - name: "sonnet"
    description: "Claude Sonnet"
    context_window: 200000
    claude:
      model: "claude-sonnet-4-20250514"
  - name: doubao-pro # comment
    description: 豆包 Pro
    ark:
      model: ep-xxx
mcp_servers:
  - name: not-a-model
`)

    expect(models).toEqual([
      { name: 'sonnet', description: 'Trae sonnet' },
      { name: 'doubao-pro', description: '豆包 Pro' },
    ])
  })

  it('extracts current model.name when models list is absent', () => {
    const models = extractModelsFromYaml(`
model:
    name: GLM-5.1
trae_login_base_url: https://console.enterprise.trae.cn
`)

    expect(models).toEqual([{ name: 'GLM-5.1', description: 'Trae GLM-5.1' }])
  })

  it('deduplicates models by first occurrence', () => {
    const models = extractModelsFromYaml(`
models:
  - name: sonnet
    description: first
  - name: sonnet
    description: second
`)

    expect(models).toEqual([{ name: 'sonnet', description: 'first' }])
  })
})
