import type { Hooks, Plugin } from '@opencode-ai/plugin'
import { existsSync } from 'node:fs'
import { TRAE_MODELS, TRAE_MODEL_PROFILES, type TraeModelDefinition } from './src/models.js'
import { discoverTraeModels } from './src/trae-config-models.js'
import { resolveTraeCliPath } from './src/trae-language-model.js'

type TraePluginOptions = {
  profile?: 'coding' | 'text' | 'tools'
  cliPath?: string
  modelName?: string
  modelAliases?: Record<string, string>
  enableToolCalling?: boolean
  queryTimeout?: number
  includeToolHistory?: boolean
  maxPromptMessages?: number
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
      const effectiveOptions = withProfileDefaults(options)
      const mergedModels = applyCapabilityOverrides(
        { ...TRAE_MODELS, ...discoveredModels, ...(existing.models ?? {}) },
        effectiveOptions,
      )

      config.provider.trae = {
        ...existing,
        npm: existing.npm ?? providerFileUrl,
        name: existing.name ?? 'Trae',
        options: {
          ...(existing.options ?? {}),
          ...(effectiveOptions.cliPath ? { cliPath: effectiveOptions.cliPath } : {}),
          ...(effectiveOptions.modelName ? { modelName: effectiveOptions.modelName } : {}),
          ...(typeof effectiveOptions.modelAliases === 'object' && effectiveOptions.modelAliases ? { modelAliases: effectiveOptions.modelAliases } : {}),
          ...(typeof effectiveOptions.enableToolCalling === 'boolean' ? { enableToolCalling: effectiveOptions.enableToolCalling } : {}),
          ...(typeof effectiveOptions.queryTimeout === 'number' ? { queryTimeout: effectiveOptions.queryTimeout } : {}),
          ...(typeof effectiveOptions.includeToolHistory === 'boolean' ? { includeToolHistory: effectiveOptions.includeToolHistory } : {}),
          ...(typeof effectiveOptions.maxPromptMessages === 'number' ? { maxPromptMessages: effectiveOptions.maxPromptMessages } : {}),
          ...(typeof effectiveOptions.maxPromptChars === 'number' ? { maxPromptChars: effectiveOptions.maxPromptChars } : {}),
          ...(typeof effectiveOptions.enforceTextOnly === 'boolean' ? { enforceTextOnly: effectiveOptions.enforceTextOnly } : {}),
          ...(typeof effectiveOptions.maxRetries === 'number' ? { maxRetries: effectiveOptions.maxRetries } : {}),
          ...(typeof effectiveOptions.retryDelayMs === 'number' ? { retryDelayMs: effectiveOptions.retryDelayMs } : {}),
          ...(Array.isArray(effectiveOptions.extraArgs) ? { extraArgs: effectiveOptions.extraArgs } : {}),
          ...(typeof effectiveOptions.sessionId === 'string' ? { sessionId: effectiveOptions.sessionId } : {}),
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

function withProfileDefaults(options: TraePluginOptions): TraePluginOptions {
  if (options.profile === 'coding' || !options.profile) {
    return {
      ...options,
      modelName: options.modelName ?? TRAE_MODEL_PROFILES.coding,
      enableToolCalling: options.enableToolCalling ?? true,
      includeToolHistory: options.includeToolHistory ?? true,
      enforceTextOnly: options.enforceTextOnly ?? false,
      maxPromptMessages: options.maxPromptMessages ?? 60,
      maxPromptChars: options.maxPromptChars ?? 20000,
    }
  }
  if (options.profile === 'tools') {
    return {
      ...options,
      enableToolCalling: options.enableToolCalling ?? true,
      includeToolHistory: options.includeToolHistory ?? true,
      enforceTextOnly: options.enforceTextOnly ?? false,
      maxPromptMessages: options.maxPromptMessages ?? 50,
      maxPromptChars: options.maxPromptChars ?? 16000,
    }
  }
  if (options.profile === 'text') {
    return {
      ...options,
      enableToolCalling: options.enableToolCalling ?? false,
      includeToolHistory: options.includeToolHistory ?? false,
      enforceTextOnly: options.enforceTextOnly ?? true,
      maxPromptMessages: options.maxPromptMessages ?? 40,
      maxPromptChars: options.maxPromptChars ?? 12000,
    }
  }
  return options
}
