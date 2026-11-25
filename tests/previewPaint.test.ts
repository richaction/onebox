import { afterEach, expect, it, vi } from 'vitest'
import { markPreviewScroll, paintPreview } from '../src/core/previewPaint'

afterEach(() => vi.useRealTimers())

it('waits for scroll input to settle before painting a chart while allowing formula previews', async () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'performance'] })
  const scroller = document.createElement('div')
  scroller.className = 'editor-scroll'
  const target = document.createElement('div')
  scroller.append(target)
  const chart = vi.fn()
  const formula = vi.fn()

  markPreviewScroll(scroller)
  const pendingChart = paintPreview(chart, target)
  const pendingFormula = paintPreview(formula)
  await vi.advanceTimersByTimeAsync(80)
  expect(formula).toHaveBeenCalledOnce()
  expect(chart).not.toHaveBeenCalled()
  markPreviewScroll(scroller)
  await vi.advanceTimersByTimeAsync(80)
  expect(chart).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(60)
  expect(chart).toHaveBeenCalledOnce()
  await Promise.all([pendingChart, pendingFormula])
})
