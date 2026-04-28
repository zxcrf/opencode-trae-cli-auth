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
    pluginModule = await import('../index.js')
  })

  it('exports TraeProviderPlugin', () => {
    expect(typeof pluginModule.TraeProviderPlugin).toBe('function')
  })

  it('injects provider metadata and options', async () => {
    const hooks = await pluginModule.TraeProviderPlugin({
      cliPath: '/custom/traecli',
      queryTimeout: 33,
      includeToolHistory: false,
      enforceTextOnly: true,
      maxRetries: 2,
      retryDelayMs: 400,
      extraArgs: ['--verbose'],
    })
    const config = {} as Config
    await hooks.config!(config)

    expect(config.provider?.trae).toBeDefined()
    expect(config.provider?.trae?.name).toBe('Trae')
    expect(config.provider?.trae?.npm).toMatch(/^file:\/\//)
    expect(config.provider?.trae?.models?.default?.tool_call).toBe(false)
    expect(config.provider?.trae?.models?.sonnet?.name).toBe('Claude Sonnet')
    expect(config.provider?.trae?.models?.sonnet?.tool_call).toBe(false)
    expect(config.provider?.trae?.models?.sonnet?.attachment).toBe(false)
    expect(config.provider?.trae?.options).toMatchObject({
      cliPath: '/custom/traecli',
      queryTimeout: 33,
      includeToolHistory: false,
      enforceTextOnly: true,
      maxRetries: 2,
      retryDelayMs: 400,
      extraArgs: ['--verbose'],
    })
  })

  it('authorize succeeds when traecli is available', async () => {
    const hooks = await pluginModule.TraeProviderPlugin({})
    const auth = hooks.auth!
    const method = auth.methods?.[0]
    expect(await method?.authorize?.()).toMatchObject({ type: 'success', key: 'trae-cli-auth' })
  })
})
