import { expect, it, vi } from 'vitest'
import { enableButtonClickTolerance } from '../src/core/buttonClickTolerance'

function nativeClick(target: EventTarget, timeStamp: number, x = 0, detail = 1) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, detail, clientX: x })
  Object.defineProperty(event, 'timeStamp', { value: timeStamp })
  return target.dispatchEvent(event)
}

function withButton(run: (fixture: {
  button: HTMLButtonElement
  capture: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
  pointer: (type: string, x: number, timeStamp?: number, target?: EventTarget) => void
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
  const pointer = (type: string, x: number, timeStamp?: number, target: EventTarget = child) => {
    const event = new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: x,
      button: 0, buttons: type === 'pointerup' ? 0 : 1,
    })
    if (timeStamp !== undefined) Object.defineProperty(event, 'timeStamp', { value: timeStamp })
    target.dispatchEvent(event)
  }
  try { run({ button, capture, release, pointer }) }
  finally { stop(); button.remove() }
}

it('keeps the pressed button captured through slight motion and releases it for a drag', () => {
  withButton(({ capture, release, pointer }) => {
    pointer('pointerdown', 20)
    expect(capture).toHaveBeenCalledExactlyOnceWith(1)
    pointer('pointermove', 29)
    expect(release).not.toHaveBeenCalled()
    pointer('pointermove', 30)
    expect(release).toHaveBeenCalledExactlyOnceWith(1)
  })
})

it('executes a WebKit tap with reversed pointer events before the next selection', () => {
  withButton(({ button, pointer, capture }) => {
    button.dataset.activateOnRelease = ''
    const activate = vi.fn()
    button.addEventListener('click', activate)
    pointer('pointerup', 24, 101)
    expect(activate).not.toHaveBeenCalled()
    pointer('pointerdown', 20, 100)
    expect(activate).toHaveBeenCalledOnce()
    expect(capture).not.toHaveBeenCalled()
    nativeClick(button, 101, 24)
    pointer('pointerdown', 200, 300, document.body)
    pointer('pointermove', 280, 301, document.body)
    pointer('pointerup', 320, 302, document.body)
    expect(activate).toHaveBeenCalledOnce()
  })
})

it('does not pair a release from an earlier gesture with a new press', () => {
  withButton(({ button, pointer }) => {
    button.dataset.activateOnRelease = ''
    const activate = vi.fn()
    button.addEventListener('click', activate)
    pointer('pointerup', 20, 100)
    pointer('pointerdown', 20, 200)
    expect(activate).not.toHaveBeenCalled()
    pointer('pointerup', 20, 201)
    expect(activate).toHaveBeenCalledOnce()
  })
})

it('does not swallow a new native click arriving before its delayed press', () => {
  withButton(({ button, pointer, capture }) => {
    button.dataset.activateOnRelease = ''
    const activate = vi.fn()
    button.addEventListener('click', activate)

    pointer('pointerup', 24, 101)
    pointer('pointerdown', 20, 100)
    expect(activate).toHaveBeenCalledOnce()

    // AppKit delivered the second tap in order. WebKit delivered up, click, then down.
    pointer('pointerup', 24, 201)
    nativeClick(button, 201, 24)
    nativeClick(button, 101, 24)
    nativeClick(button, 201, 24)
    expect(activate).toHaveBeenCalledTimes(2)
    pointer('pointerdown', 20, 200)
    expect(activate).toHaveBeenCalledTimes(2)
    expect(capture).not.toHaveBeenCalled()

    pointer('pointerdown', 20, 300)
    pointer('pointerup', 24, 301)
    expect(activate).toHaveBeenCalledTimes(3)
    nativeClick(button, 301, 24)
    expect(activate).toHaveBeenCalledTimes(3)
  })
})

it('does not turn an editor drag ending on a menu button into another click', () => {
  withButton(({ button, pointer }) => {
    button.dataset.activateOnRelease = ''
    const activate = vi.fn()
    button.addEventListener('click', activate)
    pointer('pointerdown', 200, 100, document.body)
    pointer('pointerup', 20, 102)
    pointer('pointerdown', 20, 101)
    expect(activate).not.toHaveBeenCalled()
    pointer('pointercancel', 20, 103)
    expect(activate).not.toHaveBeenCalled()
  })
})

it('recovers a reordered tap on unmarked buttons while leaving normal clicks native', () => {
  withButton(({ button, pointer }) => {
    const activate = vi.fn()
    button.addEventListener('click', activate)

    pointer('pointerdown', 20, 100)
    pointer('pointerup', 22, 101)
    // The browser automatically releases native pointer capture after pointerup.
    button.releasePointerCapture(1)
    expect(activate).not.toHaveBeenCalled()
    nativeClick(button, 101, 22)
    expect(activate).toHaveBeenCalledOnce()

    pointer('pointerup', 22, 201)
    pointer('pointerdown', 20, 200)
    expect(activate).toHaveBeenCalledTimes(2)
  })
})

it('blocks a late duplicate without swallowing another button or changing its native click count', () => {
  withButton(({ button, pointer }) => {
    button.dataset.activateOnRelease = ''
    const run = vi.fn()
    button.addEventListener('click', run)
    const next = document.createElement('button')
    document.body.append(next)
    const runNext = vi.fn()
    next.addEventListener('click', runNext)
    try {
      pointer('pointerdown', 20, 100)
      pointer('pointerup', 24, 101)
      expect(run).toHaveBeenCalledOnce()

      pointer('pointerup', 32, 201, next)
      expect(nativeClick(next, 201, 32, 2)).toBe(true)
      pointer('pointerdown', 30, 200, next)
      expect(runNext).toHaveBeenCalledOnce()
      expect(runNext.mock.calls[0][0].detail).toBe(2)

      expect(nativeClick(button, 101, 24)).toBe(false)
      expect(nativeClick(next, 101, 24)).toBe(false)
      expect(run).toHaveBeenCalledOnce()
      expect(runNext).toHaveBeenCalledOnce()
    } finally { next.remove() }
  })
})

it('marks the delayed press before it reaches a button drag handler', () => {
  withButton(({ button, pointer }) => {
    const startDrag = vi.fn()
    const activate = vi.fn()
    button.addEventListener('pointerdown', (event) => { if (!event.defaultPrevented) startDrag() })
    button.addEventListener('click', activate)
    pointer('pointerup', 24, 101)
    pointer('pointerdown', 20, 100)
    expect(activate).toHaveBeenCalledOnce()
    expect(startDrag).not.toHaveBeenCalled()
  })
})

it('allows a new click retargeted to the same point after a command removes its button', () => {
  withButton(({ button, pointer }) => {
    button.dataset.activateOnRelease = ''
    button.addEventListener('click', () => button.remove())
    pointer('pointerdown', 20, 100)
    pointer('pointerup', 24, 101)
    expect(nativeClick(document.body, 101, 24)).toBe(false)
    expect(nativeClick(document.body, 201, 24)).toBe(true)
  })
})

it('blocks a captured release beyond the tolerance when the final movement has no move event', () => {
  withButton(({ button, pointer }) => {
    const hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(document.body)
    try {
      const activate = vi.fn()
      button.addEventListener('click', activate)
      pointer('pointerdown', 20, 100)
      pointer('pointerup', 30, 101)
      nativeClick(button, 101, 30)
      expect(activate).not.toHaveBeenCalled()
      button.click()
      expect(activate).toHaveBeenCalledOnce()
    } finally { hit.mockRestore() }
  })
})

it('activates a selection command on mouse release and consumes its later native click', () => {
  withButton(({ button, pointer }) => {
    button.dataset.activateOnRelease = ''
    const activate = vi.fn()
    button.addEventListener('click', activate)
    pointer('pointerdown', 20, 100)
    pointer('pointerup', 26, 101)
    expect(activate).toHaveBeenCalledOnce()
    expect(activate.mock.calls[0][0]).toMatchObject({ clientX: 26, detail: 1 })
    nativeClick(button, 101, 26)
    expect(activate).toHaveBeenCalledOnce()
    button.click()
    expect(activate).toHaveBeenCalledTimes(2)
    pointer('pointerdown', 20)
    pointer('pointercancel', 22)
    expect(activate).toHaveBeenCalledTimes(2)
  })
})
