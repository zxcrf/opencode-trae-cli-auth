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
  'Doubao-Seed-Code',
  'GLM-5.1',
  'MiniMax-M2.7',
  'Kimi-K2.6',
] as const

export const TRAE_MODEL_PROFILES = {
  fast: 'MiniMax-M2.7',
  balanced: 'GLM-5.1',
  strong: 'Kimi-K2.6',
} as const

const TEXT_ONLY_CAPABILITIES = {
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: false,
} as const

export const TRAE_MODELS: Record<string, TraeModelDefinition> = {
  default: {
    id: 'default',
    name: 'Trae Default',
    ...TEXT_ONLY_CAPABILITIES,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 128000, output: 8192 },
  },
  ...Object.fromEntries(
    TRAE_CLOUD_MODEL_IDS.map((id) => [id, createTraeModelDefinition(id)]),
  ),
  fast: createTraeModelDefinition('fast', `Trae Fast (${TRAE_MODEL_PROFILES.fast})`),
  balanced: createTraeModelDefinition('balanced', `Trae Balanced (${TRAE_MODEL_PROFILES.balanced})`),
  strong: createTraeModelDefinition('strong', `Trae Strong (${TRAE_MODEL_PROFILES.strong})`),
}

export const DEFAULT_MODEL_ID = 'default'

export function getModelById(id: string): TraeModelDefinition | undefined {
  return TRAE_MODELS[id]
}

export function createTraeModelDefinition(id: string, description?: string, contextWindow?: number): TraeModelDefinition {
  return {
    id,
    name: description || id,
    ...TEXT_ONLY_CAPABILITIES,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: contextWindow ?? 128000, output: 8192 },
  }
}
