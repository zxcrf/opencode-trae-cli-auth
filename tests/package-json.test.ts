import { describe, expect, it } from 'vitest'
import packageJson from '../package.json' with { type: 'json' }

describe('package.json scripts', () => {
  it('uses bun directly for npm lifecycle publish validation', () => {
    expect(packageJson.scripts.prepack).toBe('bun run build')
    expect(packageJson.scripts.prepublishOnly).toBe('bun run test && bun run build')
    expect(packageJson.scripts.prepack).not.toContain('npm run')
    expect(packageJson.scripts.prepublishOnly).not.toContain('npm run')
  })

  it('exposes a real OpenCode read/write tool smoke entrypoint', () => {
    expect(packageJson.scripts['smoke:opencode:rw']).toBe('bun scripts/smoke-opencode-read-write.mjs')
  })
})
