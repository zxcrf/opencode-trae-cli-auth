import { describe, expect, it } from 'vitest'
import { mapUsage } from '../src/cli/usage.js'

describe('mapUsage', () => {
  it('maps common usage field names', () => {
    expect(mapUsage({ prompt_tokens: 3, completion_tokens: 4 })).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
    })
  })
})
