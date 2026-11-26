import { expect, it, vi } from 'vitest'
import { showExpandedPreview } from '../src/core/expandedPreview'

it('opens an expanded chart and releases its renderer when closed or unmounted', () => {
  const trigger = document.createElement('button')
  document.body.append(trigger)
  const cleanup = vi.fn()
  const onClose = vi.fn()
  const draw = (content: HTMLElement) => {
    content.append(document.createElement('canvas'))
    return cleanup
  }
  const destroy = showExpandedPreview(trigger, 'echarts', draw, onClose)
  try {
    const dialog = document.querySelector('dialog')!
    expect(dialog.open).toBe(true)
    expect(dialog.querySelector('[data-kind="echarts"] canvas')).not.toBeNull()

    const viewport = dialog.querySelector('.rich-preview-dialog-viewport')!
    viewport.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    dialog.dispatchEvent(new MouseEvent('click'))
    expect(dialog.open).toBe(true)

    dialog.dispatchEvent(new Event('pointerdown'))
    dialog.dispatchEvent(new MouseEvent('click'))
    expect(dialog.isConnected).toBe(false)
    expect(document.activeElement).toBe(trigger)
    expect(onClose).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()

    const unmount = showExpandedPreview(trigger, 'echarts', draw, onClose)
    unmount()
    unmount()
    expect(document.querySelector('dialog')).toBeNull()
    expect(cleanup).toHaveBeenCalledTimes(2)
  } finally {
    destroy()
    trigger.remove()
  }
})

it('zooms around the pointer and allows dragging at and below the default scale', async () => {
  const trigger = document.body.appendChild(document.createElement('button'))
  const destroy = showExpandedPreview(trigger, 'image', (content) => {
    const image = content.appendChild(document.createElement('img'))
    vi.spyOn(content.parentElement!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 640, 480))
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 200, 100))
  }, () => {})

  try {
    const viewport = document.querySelector<HTMLElement>('.rich-preview-dialog-viewport')!
    const image = viewport.querySelector('img')!
    const reset = document.querySelector<HTMLButtonElement>('[aria-label="恢复默认缩放"]')!
    Object.defineProperty(viewport, 'setPointerCapture', { value: vi.fn() })
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const pointer = (type: string, x: number, y: number) => viewport.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: x, clientY: y,
    }))
    const drag = () => {
      pointer('pointerdown', 200, 150)
      pointer('pointermove', 240, 175)
      pointer('pointerup', 240, 175)
    }
    const translation = () => image.parentElement!.style.transform.match(/translate3d\(([^p]+)px, ([^p]+)px/)!.slice(1).map(Number)

    pointer('pointerdown', 200, 150)
    const delayed = new PointerEvent('pointermove', { pointerId: 1, clientX: 210, clientY: 152 })
    Object.defineProperty(delayed, 'timeStamp', { value: 0 })
    viewport.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: 240, clientY: 175 }))
    expect(translation()).toEqual([40, 25])
    viewport.dispatchEvent(delayed)
    expect(translation()).toEqual([40, 25])
    pointer('pointermove', 240, 175)
    expect(translation()).toEqual([40, 25])
    pointer('pointermove', 232, 171)
    expect(translation()).toEqual([32, 21])
    pointer('pointerup', 246, 179)
    expect(translation()).toEqual([46, 29])
    expect(document.activeElement).not.toBe(viewport)
    expect(viewport.hasAttribute('data-panning')).toBe(false)

    reset.click()
    const wheel = new WheelEvent('wheel', { deltaY: 120, cancelable: true })
    // Happy DOM's WheelEvent does not implement mouse coordinates.
    Object.defineProperties(wheel, { clientX: { value: 200 }, clientY: { value: 150 } })
    expect(viewport.dispatchEvent(wheel)).toBe(false)
    await frame()

    expect(reset.textContent).toBe('79%')
    const zoomTransform = image.style.transform
    expect(zoomTransform).toMatch(/^scale\(/)
    const [left, top] = translation()
    expect(left).toBeCloseTo(100 * (1 - Math.exp(-0.24)))
    expect(top).toBeCloseTo(50 * (1 - Math.exp(-0.24)))
    drag()
    await frame()
    expect(translation()).toEqual([left + 40, top + 25])
    expect(image.style.transform).toBe(zoomTransform)

    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    await frame()
    expect(translation()[0]).toBeCloseTo(left)

    reset.click()
    await frame()
    expect(reset.textContent).toBe('100%')
    expect(translation()).toEqual([0, 0])
  } finally {
    destroy()
    trigger.remove()
  }
})
