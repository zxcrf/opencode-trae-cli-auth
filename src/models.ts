export interface TraeModelDefinition {
  id: string
  name: string
  attachment: boolean
  reasoning: boolean
  temperature: boolean
  tool_call: boolean
  cost: {
    input: number
    output: number
    cache_read: number
    cache_write: number
  }
  limit: {
    context: number
    output: number
  }
}

export const TRAE_CLOUD_MODEL_IDS = [
  'Doubao-Seed-2.0-Code',
  'Doubao-Seed-Code',
  'GLM-5.1',
  'GLM-5',
  'GLM-4.7',
  'MiniMax-M2.7',
  'MiniMax-M2.5',
  'Qwen3-Coder-Next',
  'Kimi-K2.6',
  'Kimi-K2.5',
  'DeepSeek-V3.2',
  'DeepSeek-V3.1-Terminus',
] as const

export const TRAE_MODELS: Record<string, TraeModelDefinition> = {
  default: {
    id: 'default',
    name: 'Trae Default',
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: false,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 128000, output: 8192 },
  },
  ...Object.fromEntries(
    TRAE_CLOUD_MODEL_IDS.map((id) => [id, createTraeModelDefinition(id)]),
  ),
}

export const DEFAULT_MODEL_ID = 'default'

export function getModelById(id: string): TraeModelDefinition | undefined {
  return TRAE_MODELS[id]
}

export function createTraeModelDefinition(id: string, description?: string, contextWindow?: number): TraeModelDefinition {
  return {
    id,
    name: description || id,
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: false,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: contextWindow ?? 128000, output: 8192 },
  }
}
