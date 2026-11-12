import { describe, expect, it } from 'vitest'
import { HeightCache, estimateHeight } from '../src/core/viewport/heights'
import { schema } from '../src/core/schema'

const para = (text: string) => schema.node('paragraph', null, text ? [schema.text(text)] : [])

describe('HeightCache', () => {
  it('returns undefined for an unmeasured block', () => {
    expect(new HeightCache().get(para('x'))).toBeUndefined()
  })

  it('hits on the same node object', () => {
    const cache = new HeightCache()
    const block = para('x')
    cache.set(block, 120)
    expect(cache.get(block)).toBe(120)
  })

  it('misses on a different node object with identical content', () => {
    const cache = new HeightCache()
    cache.set(para('x'), 120)
    expect(cache.get(para('x'))).toBeUndefined()
  })

  it('overwrites a previous measurement', () => {
    const cache = new HeightCache()
    const block = para('x')
    cache.set(block, 100)
    cache.set(block, 200)
    expect(cache.get(block)).toBe(200)
  })
})

describe('estimateHeight', () => {
  it('applies the floor to an empty block', () => {
    expect(estimateHeight(para(''))).toBe(28)
  })

  it('applies the floor to a short block', () => {
    expect(estimateHeight(para('短'))).toBe(28)
  })

  it('scales with line count', () => {
    expect(estimateHeight(para('x'.repeat(160)))).toBe(48)
    expect(estimateHeight(para('x'.repeat(161)))).toBe(72)
  })
})
