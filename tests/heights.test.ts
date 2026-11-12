import { describe, expect, it } from 'vitest'
import { EditorState } from '@tiptap/pm/state'
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

  it('counts explicit newlines, not just characters', () => {
    const code = schema.node('codeBlock', null, [schema.text('a\n'.repeat(9) + 'a')])
    expect(estimateHeight(code)).toBe(240)
  })
})

describe('node identity across transactions', () => {
  it('keeps an unmodified block reference so the cache still hits', () => {
    const doc = schema.node('doc', null, [para('aaa'), para('bbb')])
    const cache = new HeightCache()
    const second = doc.child(1)
    cache.set(second, 90)
    const next = EditorState.create({ doc }).tr.insertText('x', 1).doc
    expect(next.child(1)).toBe(second)
    expect(cache.get(next.child(1))).toBe(90)
  })
})
