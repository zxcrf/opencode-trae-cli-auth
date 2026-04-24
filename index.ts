import type { Hooks, Plugin } from '@opencode-ai/plugin'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { TRAE_MODELS } from './src/models.js'
import { discoverTraeModels } from './src/trae-config-models.js'
import { resolveTraeCliPath } from './src/trae-language-model.js'

type TraePluginOptions = {
  cliPath?: string
  modelName?: string
  queryTimeout?: number
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
      const mergedModels = { ...TRAE_MODELS, ...discoveredModels, ...(existing.models ?? {}) }

      config.provider.trae = {
        ...existing,
        npm: existing.npm ?? providerFileUrl,
        name: existing.name ?? 'Trae',
        options: {
          ...(existing.options ?? {}),
          ...(options.cliPath ? { cliPath: options.cliPath } : {}),
          ...(options.modelName ? { modelName: options.modelName } : {}),
          ...(typeof options.queryTimeout === 'number' ? { queryTimeout: options.queryTimeout } : {}),
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
