import { describe, expect, it } from 'vitest'

describe('test harness', () => {
  it('provides a DOM environment', () => {
    const el = document.createElement('div')
    el.textContent = 'onebox'
    expect(el.textContent).toBe('onebox')
  })
})
