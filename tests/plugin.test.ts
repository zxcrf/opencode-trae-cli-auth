import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '@opencode-ai/plugin'

vi.mock('../src/trae-language-model.js', async () => {
  const actual = await vi.importActual<typeof import('../src/trae-language-model.js')>('../src/trae-language-model.js')
  return {
    ...actual,
    resolveTraeCliPath: vi.fn(() => '/usr/bin/traecli'),
  }
})

vi.mock('../src/trae-config-models.js', () => ({
  discoverTraeModels: vi.fn(() => ({
    sonnet: {
      id: 'sonnet',
      name: 'Claude Sonnet',
      attachment: false,
      reasoning: false,
      temperature: false,
      tool_call: false,
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      limit: { context: 200000, output: 8192 },
    },
  })),
}))

describe('TraeProviderPlugin', () => {
  let pluginModule: typeof import('../index.js')

  beforeEach(async () => {
    vi.resetModules()
    vi.unstubAllEnvs()
    pluginModule = await import('../index.js')
  })

  it('exports TraeProviderPlugin', () => {
    expect(typeof pluginModule.TraeProviderPlugin).toBe('function')
  })

  it('injects provider metadata and options', async () => {
    const hooks = await pluginModule.TraeProviderPlugin({
      openaiBaseURL: 'https://example.test/v1',
      openaiApiKey: 'test-key',
      enableToolCalling: true,
      allowCliFallback: true,
      cliPath: '/custom/traecli',
      modelName: 'Kimi-K2.6',
    })
    const config = {} as Config
    await hooks.config!(config)

    expect(config.provider?.trae).toBeDefined()
    expect(config.provider?.trae?.name).toBe('Trae')
    expect(config.provider?.trae?.npm).toMatch(/^file:\/\//)
    expect(config.provider?.trae?.models?.['GLM-5.1']?.tool_call).toBe(true)
    expect(config.provider?.trae?.models).not.toHaveProperty('default')
    expect(config.provider?.trae?.models).not.toHaveProperty('coding')
    expect(config.provider?.trae?.models).not.toHaveProperty('fast')
    expect(config.provider?.trae?.models).not.toHaveProperty('balanced')
    expect(config.provider?.trae?.models).not.toHaveProperty('strong')
    expect(config.provider?.trae?.models?.sonnet?.name).toBe('Claude Sonnet')
    expect(config.provider?.trae?.models?.sonnet?.tool_call).toBe(true)
    expect(config.provider?.trae?.models?.sonnet?.attachment).toBe(false)
    expect(config.provider?.trae?.options).toMatchObject({
      cliPath: '/custom/traecli',
      openaiBaseURL: 'https://example.test/v1',
      openaiApiKey: 'test-key',
      modelName: 'Kimi-K2.6',
      enableToolCalling: true,
    })
  })

  it('authorize succeeds when traecli is available', async () => {
    const hooks = await pluginModule.TraeProviderPlugin({})
    const auth = hooks.auth!
    const method = auth.methods?.[0]
    expect(await method?.authorize?.()).toMatchObject({ type: 'success', key: 'trae-cli-auth' })
  })

  it('does not enable legacy Trae CLI fallback by default', async () => {
    const hooks = await pluginModule.TraeProviderPlugin({})
    const config = {} as Config
    await hooks.config!(config)

    expect(config.provider?.trae?.options?.allowCliFallback).toBe(false)
    expect(config.provider?.trae?.options?.cliPath).toBeUndefined()
  })

  it('does not read OpenAI-compatible transport tokens from environment variables', async () => {
    vi.stubEnv('TRAE_OPENAI_BASE_URL', 'https://env.example.test/v1')
    vi.stubEnv('TRAE_OPENAI_API_KEY', 'env-key')

    const hooks = await pluginModule.TraeProviderPlugin({})
    const config = {} as Config
    await hooks.config!(config)

    expect(config.provider?.trae?.options?.openaiBaseURL).toBeUndefined()
    expect(config.provider?.trae?.options?.openaiApiKey).toBeUndefined()
  })

  it('uses explicit pat option for Trae raw chat auth exchange with enterprise API default base URL', async () => {
    const hooks = await pluginModule.TraeProviderPlugin({
      pat: 'explicit-pat',
    } as any)
    const config = {} as Config
    await hooks.config!(config)

    expect(config.provider?.trae?.options).toMatchObject({
      pat: 'explicit-pat',
      traeRawBaseURL: 'https://api.enterprise.trae.cn',
      allowCliFallback: false,
    })
    expect(config.provider?.trae?.options?.traeRawApiKey).toBeUndefined()
  })

  it('does not treat the PAT placeholder as a configured raw chat token', async () => {
    const hooks = await pluginModule.TraeProviderPlugin({
      pat: 'REPLACE_WITH_TRAE_PAT',
    } as any)
    const config = {} as Config
    await hooks.config!(config)

    expect(config.provider?.trae?.options?.pat).toBeUndefined()
    expect(config.provider?.trae?.options?.traeRawBaseURL).toBeUndefined()
    expect(config.provider?.trae?.options?.traeRawApiKey).toBeUndefined()
  })

  it('does not read Trae tokens from environment variables', async () => {
    vi.stubEnv('TRAE_RAW_BASE_URL', 'https://env.example.test')
    vi.stubEnv('TRAE_RAW_API_KEY', 'raw-env-key')
    vi.stubEnv('TRAECLI_PERSONAL_ACCESS_TOKEN', 'pat-env-key')

    const hooks = await pluginModule.TraeProviderPlugin({})
    const config = {} as Config
    await hooks.config!(config)

    expect(config.provider?.trae?.options?.traeRawBaseURL).toBeUndefined()
    expect(config.provider?.trae?.options?.traeRawApiKey).toBeUndefined()
  })
})
