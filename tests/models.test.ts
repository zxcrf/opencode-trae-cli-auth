import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL_ID, TRAE_CLOUD_MODEL_IDS, TRAE_MODELS, TRAE_MODEL_PROFILES, getModelById } from '../src/models.js'

describe('trae models', () => {
  it('exposes a default model with tool calls disabled', () => {
    expect(DEFAULT_MODEL_ID).toBe('default')
    expect(TRAE_MODELS.default).toBeDefined()
    expect(TRAE_MODELS.default.tool_call).toBe(false)
  })

  it('advertises Trae as text-only without tool calling or attachments', () => {
    for (const [id, model] of Object.entries(TRAE_MODELS)) {
      expect(model.attachment, `${id}.attachment`).toBe(false)
      expect(model.tool_call, `${id}.tool_call`).toBe(false)
      expect(model.reasoning, `${id}.reasoning`).toBe(false)
    }
  })

  it('returns model by id', () => {
    expect(getModelById('default')?.name).toContain('Trae')
  })

  it('exposes profile aliases for broad usability', () => {
    expect(TRAE_MODEL_PROFILES.fast).toBe('MiniMax-M2.7')
    expect(TRAE_MODEL_PROFILES.balanced).toBe('GLM-5.1')
    expect(TRAE_MODEL_PROFILES.strong).toBe('Kimi-K2.6')
    expect(TRAE_MODELS.fast?.tool_call).toBe(false)
    expect(TRAE_MODELS.balanced?.tool_call).toBe(false)
    expect(TRAE_MODELS.strong?.tool_call).toBe(false)
  })

  it('exposes known Trae cloud model ids discovered from /model', () => {
    expect(TRAE_CLOUD_MODEL_IDS).toEqual([
      'Doubao-Seed-Code',
      'GLM-5.1',
      'MiniMax-M2.7',
      'Kimi-K2.6',
    ])
    expect(TRAE_CLOUD_MODEL_IDS).toContain('GLM-5.1')
    expect(TRAE_CLOUD_MODEL_IDS).not.toContain('DeepSeek-V3.1-Terminus')
    expect(TRAE_CLOUD_MODEL_IDS).not.toContain('Doubao-Seed-2.0-Code')
    for (const id of TRAE_CLOUD_MODEL_IDS) {
      expect(TRAE_MODELS[id]?.id).toBe(id)
      expect(TRAE_MODELS[id]?.tool_call).toBe(false)
    }
  })
})
