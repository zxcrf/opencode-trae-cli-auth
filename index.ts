import type { Hooks, Plugin } from '@opencode-ai/plugin'
import { existsSync } from 'node:fs'
import { TRAE_MODELS, type TraeModelDefinition } from './src/models.js'
import { discoverTraeModels } from './src/trae-config-models.js'
import { resolveTraeCliPath } from './src/trae-language-model.js'

type TraePluginOptions = {
  cliPath?: string
  modelName?: string
  modelAliases?: Record<string, string>
  enableToolCalling?: boolean
  queryTimeout?: number
  includeToolHistory?: boolean
  maxPromptChars?: number
  enforceTextOnly?: boolean
  maxRetries?: number
  retryDelayMs?: number
  extraArgs?: string[]
  sessionId?: string
}

export const TraeProviderPlugin: Plugin<TraePluginOptions> = async (options = {}) => {
  const providerFileUrl = new URL(
    existsSync(new URL('./provider.js', import.meta.url)) ? './provider.js' : './provider.ts',
    import.meta.url,
  ).href

  return {
    async config(config) {
      config.provider = config.provider ?? {}
      const existing = config.provider.trae ?? {}
      const discoveredModels = discoverTraeModels()
      const mergedModels = applyCapabilityOverrides(
        { ...TRAE_MODELS, ...discoveredModels, ...(existing.models ?? {}) },
        options,
      )

      config.provider.trae = {
        ...existing,
        npm: existing.npm ?? providerFileUrl,
        name: existing.name ?? 'Trae',
        options: {
          ...(existing.options ?? {}),
          ...(options.cliPath ? { cliPath: options.cliPath } : {}),
          ...(options.modelName ? { modelName: options.modelName } : {}),
          ...(typeof options.modelAliases === 'object' && options.modelAliases ? { modelAliases: options.modelAliases } : {}),
          ...(typeof options.enableToolCalling === 'boolean' ? { enableToolCalling: options.enableToolCalling } : {}),
          ...(typeof options.queryTimeout === 'number' ? { queryTimeout: options.queryTimeout } : {}),
          ...(typeof options.includeToolHistory === 'boolean' ? { includeToolHistory: options.includeToolHistory } : {}),
          ...(typeof options.maxPromptChars === 'number' ? { maxPromptChars: options.maxPromptChars } : {}),
          ...(typeof options.enforceTextOnly === 'boolean' ? { enforceTextOnly: options.enforceTextOnly } : {}),
          ...(typeof options.maxRetries === 'number' ? { maxRetries: options.maxRetries } : {}),
          ...(typeof options.retryDelayMs === 'number' ? { retryDelayMs: options.retryDelayMs } : {}),
          ...(Array.isArray(options.extraArgs) ? { extraArgs: options.extraArgs } : {}),
          ...(typeof options.sessionId === 'string' ? { sessionId: options.sessionId } : {}),
        },
        models: mergedModels,
      }
    },
    auth: {
      provider: 'trae',
      async loader() {
        return resolveTraeCliPath() ? {} : {}
      },
      methods: [
        {
          type: 'api',
          label: 'Log in with traecli in your terminal',
          prompts: [],
          async authorize() {
            if (resolveTraeCliPath()) {
              return { type: 'success', key: 'trae-cli-auth' }
            }
            return {
              type: 'failed',
              message: 'traecli binary not found. Install traecli and ensure it is on PATH.',
            }
          },
        },
      ],
    },
  } satisfies Hooks
}

export default TraeProviderPlugin

function applyCapabilityOverrides(
  models: Record<string, TraeModelDefinition>,
  options: TraePluginOptions,
): Record<string, TraeModelDefinition> {
  if (options.enableToolCalling !== true) return models
  return Object.fromEntries(
    Object.entries(models).map(([id, model]) => [id, { ...model, tool_call: true }]),
  )
}
