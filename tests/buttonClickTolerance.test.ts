import { expect, it, vi } from 'vitest'
import { enableButtonClickTolerance } from '../src/core/buttonClickTolerance'

function withButton(run: (fixture: {
  button: HTMLButtonElement
  capture: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
  pointer: (type: string, x: number) => void
}) => void) {
  const button = document.createElement('button')
  const child = document.createElement('span')
  button.append(child)
  document.body.append(button)
  let captured = false
  const capture = vi.fn(() => { captured = true })
  const release = vi.fn(() => { captured = false })
  Object.assign(button, {
    hasPointerCapture: () => captured,
    setPointerCapture: capture,
    releasePointerCapture: release,
  })
  Object.assign(child, { hasPointerCapture: () => false })
  const stop = enableButtonClickTolerance(document)
  const pointer = (type: string, x: number) => child.dispatchEvent(new PointerEvent(type, {
    bubbles: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: x,
    button: 0, buttons: type === 'pointerup' ? 0 : 1,
  }))
  try { run({ button, capture, release, pointer }) }
  finally { stop(); button.remove() }
}

it('keeps the pressed button captured through slight motion and releases it for a drag', () => {
  withButton(({ capture, release, pointer }) => {
    pointer('pointerdown', 20)
    expect(capture).toHaveBeenCalledExactlyOnceWith(1)
    pointer('pointermove', 27)
    expect(release).not.toHaveBeenCalled()
    pointer('pointermove', 28)
    expect(release).toHaveBeenCalledExactlyOnceWith(1)
  })
})

it('blocks a captured release beyond the tolerance when the final movement has no move event', () => {
  withButton(({ button, pointer }) => {
    const hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(document.body)
    try {
      const activate = vi.fn()
      button.addEventListener('click', activate)
      pointer('pointerdown', 20)
      pointer('pointerup', 30)
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, cancelable: true }))
      expect(activate).not.toHaveBeenCalled()
      button.click()
      expect(activate).toHaveBeenCalledOnce()
    } finally { hit.mockRestore() }
  })
})
