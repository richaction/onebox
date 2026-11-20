import type { MathfieldElement } from 'mathlive'
import { expect, it, vi } from 'vitest'
import { bindMathPointer } from '../src/core/mathPointer'

it('keeps a held click collapsed and starts selection after deliberate movement', () => {
  const field = Object.assign(document.createElement('span'), {
    position: 0,
    selection: { ranges: [[0, 0]], direction: 'none' },
    getOffsetFromPoint: (x: number) => Math.round(x),
    setPointerCapture: vi.fn(),
  })
  document.body.append(field)
  const activate = vi.fn(() => true)
  bindMathPointer(field as unknown as MathfieldElement, activate)
  const pointer = (type: string, x: number, options?: PointerEventInit) => field.dispatchEvent(new PointerEvent(type, {
    cancelable: true, isPrimary: true, button: 0, pointerId: 1, pointerType: 'mouse', clientX: x,
    ...options,
  }))

  try {
    expect(pointer('pointerdown', 10)).toBe(false)
    expect(field.position).toBe(10)
    pointer('pointermove', 13)
    expect(field.selection.ranges).toEqual([[0, 0]])

    pointer('pointermove', 20)
    expect(field.selection).toEqual({ ranges: [[10, 20]], direction: 'forward' })
    pointer('pointermove', 1)
    expect(field.selection).toEqual({ ranges: [[1, 10]], direction: 'backward' })
    pointer('pointerup', 1)
    pointer('pointermove', 25)
    expect(field.selection.ranges).toEqual([[1, 10]])

    pointer('pointerdown', 5, { altKey: true })
    expect(activate).toHaveBeenLastCalledWith(true)
  } finally {
    field.remove()
  }
})
