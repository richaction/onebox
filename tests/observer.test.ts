import { describe, expect, it } from 'vitest'
import { nextVisibleSet } from '../src/core/viewport/observer'

describe('nextVisibleSet', () => {
  it('returns null for identical sets', () => {
    expect(nextVisibleSet(new Set([0, 5]), new Set([5, 0]))).toBeNull()
  })

  it('returns null for two empty sets', () => {
    expect(nextVisibleSet(new Set(), new Set())).toBeNull()
  })

  it('returns the new set when a block enters', () => {
    const next = new Set([0, 5, 10])
    expect(nextVisibleSet(new Set([0, 5]), next)).toBe(next)
  })

  it('returns the new set when a block leaves', () => {
    const next = new Set([0])
    expect(nextVisibleSet(new Set([0, 5]), next)).toBe(next)
  })

  it('returns the new set when size matches but members differ', () => {
    const next = new Set([0, 10])
    expect(nextVisibleSet(new Set([0, 5]), next)).toBe(next)
  })
})
