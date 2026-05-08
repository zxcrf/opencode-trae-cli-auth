import { describe, expect, it } from 'vitest'
import { contentToText } from '../src/cli/text-content.js'

describe('contentToText', () => {
  it('extracts supported text content variants', () => {
    expect(contentToText('ok')).toEqual(['ok'])
    expect(contentToText([{ type: 'text', text: 'a' }, { type: 'output_text', text: 'b' }])).toEqual(['a', 'b'])
  })

  it('strips leaked think tags from visible assistant text', () => {
    expect(contentToText('好，直接查。</think>')).toEqual(['好，直接查。'])
    expect(contentToText('<think>internal</think>最终答案')).toEqual(['最终答案'])
    expect(contentToText([{ type: 'text', text: '让我先看一下<think>debug</think>目录。' }])).toEqual(['让我先看一下目录。'])
  })
})
