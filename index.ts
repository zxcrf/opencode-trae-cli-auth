import type { Hooks, Plugin } from '@opencode-ai/plugin'
import { existsSync } from 'node:fs'
import { TRAE_MODELS, TRAE_MODEL_PROFILES, type TraeModelDefinition } from './src/models.js'
import { discoverTraeModels } from './src/trae-config-models.js'
import { resolveTraeCliPath } from './src/trae-language-model.js'

type TraePluginOptions = {
  pat?: string
  allowCliFallback?: boolean
  cliPath?: string
  openaiBaseURL?: string
  openaiApiKey?: string
  modelName?: string
  enableToolCalling?: boolean
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
      const effectiveOptions = withDefaultOptions(withEnvironmentDefaults({ ...(existing.options ?? {}), ...options } as TraePluginOptions))
      const pat = normalizePat(effectiveOptions.pat)
      const rawBaseURL = normalizeTraeRawBaseURL(undefined, pat)
      const mergedModels = applyCapabilityOverrides(
        { ...TRAE_MODELS, ...discoveredModels, ...(existing.models ?? {}) },
        effectiveOptions,
      )

      config.provider.trae = {
        ...existing,
        npm: existing.npm ?? providerFileUrl,
        name: existing.name ?? 'Trae',
        options: {
          allowCliFallback: effectiveOptions.allowCliFallback ?? false,
          ...(effectiveOptions.allowCliFallback === true && effectiveOptions.cliPath ? { cliPath: effectiveOptions.cliPath } : {}),
          ...(pat ? { pat } : {}),
          ...(rawBaseURL ? { traeRawBaseURL: rawBaseURL } : {}),
          ...(effectiveOptions.openaiBaseURL ? { openaiBaseURL: effectiveOptions.openaiBaseURL } : {}),
          ...(effectiveOptions.openaiApiKey ? { openaiApiKey: effectiveOptions.openaiApiKey } : {}),
          ...(effectiveOptions.modelName ? { modelName: effectiveOptions.modelName } : {}),
          ...(typeof effectiveOptions.enableToolCalling === 'boolean' ? { enableToolCalling: effectiveOptions.enableToolCalling } : {}),
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

function withEnvironmentDefaults(options: TraePluginOptions): TraePluginOptions {
  return {
    ...options,
  }
}

function normalizePat(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed === 'REPLACE_WITH_TRAE_PAT') return undefined
  return trimmed
}

function normalizeTraeRawBaseURL(value: string | undefined, pat: string | undefined): string | undefined {
  if (!value) return pat ? 'https://api.enterprise.trae.cn' : undefined
  if (pat && stripTrailingSlash(value) === 'https://console.enterprise.trae.cn') {
    return 'https://api.enterprise.trae.cn'
  }
  return value
}

function isPatLike(value: string | undefined): boolean {
  return !!normalizePat(value)?.startsWith('trae-lt-')
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function applyCapabilityOverrides(
  models: Record<string, TraeModelDefinition>,
  options: TraePluginOptions,
): Record<string, TraeModelDefinition> {
  if (options.enableToolCalling !== true) return models
  return Object.fromEntries(
    Object.entries(models).map(([id, model]) => [id, { ...model, tool_call: true }]),
  )
}

function withDefaultOptions(options: TraePluginOptions): TraePluginOptions {
  return {
    ...options,
    enableToolCalling: options.enableToolCalling ?? true,
  }
}
