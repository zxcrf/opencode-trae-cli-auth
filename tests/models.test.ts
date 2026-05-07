import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL_ID, TRAE_CLOUD_MODEL_IDS, TRAE_MODELS, getModelById } from '../src/models.js'

describe('trae models', () => {
  it('uses a real Trae model as the default exposed model', () => {
    expect(DEFAULT_MODEL_ID).toBe('GLM-5.1')
    expect(TRAE_MODELS[DEFAULT_MODEL_ID]).toBeDefined()
    expect(TRAE_MODELS[DEFAULT_MODEL_ID].tool_call).toBe(false)
  })

  it('advertises Trae as text-only without tool calling or attachments', () => {
    for (const [id, model] of Object.entries(TRAE_MODELS)) {
      expect(model.attachment, `${id}.attachment`).toBe(false)
      expect(model.tool_call, `${id}.tool_call`).toBe(false)
      expect(model.reasoning, `${id}.reasoning`).toBe(false)
    }
  })

  it('returns model by id', () => {
    expect(getModelById('GLM-5.1')?.name).toBe('GLM-5.1')
  })

  it('does not expose profile aliases as selectable models', () => {
    expect(Object.keys(TRAE_MODELS)).not.toEqual(expect.arrayContaining([
      'default',
      'fast',
      'balanced',
      'strong',
      'coding',
    ]))
  })

  it('exposes known Trae cloud model ids discovered from /model', () => {
    expect(TRAE_CLOUD_MODEL_IDS).toEqual([
      'Doubao-Seed-Code',
      'GLM-5.1',
      'MiniMax-M2.7',
      'Kimi-K2.6',
      'DeepSeek-V4-Pro',
    ])
    expect(TRAE_CLOUD_MODEL_IDS).toContain('GLM-5.1')
    expect(TRAE_CLOUD_MODEL_IDS).not.toContain('DeepSeek-V3.1-Terminus')
    expect(TRAE_CLOUD_MODEL_IDS).not.toContain('Doubao-Seed-2.0-Code')
    for (const id of TRAE_CLOUD_MODEL_IDS) {
      expect(TRAE_MODELS[id]?.id).toBe(id)
      expect(TRAE_MODELS[id]?.name).toBe(id)
      expect(TRAE_MODELS[id]?.tool_call).toBe(false)
    }
  })
})
