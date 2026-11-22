import { expect, it, vi } from 'vitest'
import { createImageZoom } from '../src/ui/previewImage'

it('finishes a small zoom at 120 Hz when the image renderer rounds its scale', async () => {
  let frame: FrameRequestCallback | undefined
  let scale = 0.6
  const applyViewState = vi.fn(async ({ scale: next }: { scale?: number }) => {
    if (next !== undefined) scale = Number(next.toFixed(3))
    return { scale }
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => { frame = undefined })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  try {
    const zoom = createImageZoom(document.createElement('div'), () => ({
      getZoomState: () => ({ scale, minScale: 0.1, maxScale: 5, label: '', canZoomIn: true, canZoomOut: true, canReset: true }),
      applyViewState,
    }), () => {})
    zoom.scaleBy(1.0045)
    for (let index = 1; frame && index <= 24; index++) {
      const callback = frame
      frame = undefined
      await callback(index * 1000 / 120)
    }
    expect(frame).toBeUndefined()
    expect(scale).toBe(0.603)
    expect(applyViewState).toHaveBeenLastCalledWith(
      { scale: expect.closeTo(0.6027) },
      { source: 'user', action: 'zoom-change', notify: true },
    )
  } finally {
    vi.unstubAllGlobals()
  }
})
