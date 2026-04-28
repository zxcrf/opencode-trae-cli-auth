import { describe, expect, it } from 'vitest'
import { contentToText } from '../src/cli/text-content.js'

describe('contentToText', () => {
  it('extracts supported text content variants', () => {
    expect(contentToText('ok')).toEqual(['ok'])
    expect(contentToText([{ type: 'text', text: 'a' }, { type: 'output_text', text: 'b' }])).toEqual(['a', 'b'])
  })
})
