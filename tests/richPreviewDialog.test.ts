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
