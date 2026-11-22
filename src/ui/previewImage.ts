import type { ViewerController, ViewerFitOptions } from '@file-viewer/web-full'

export const isImagePreview = (name: string) => /\.(png|jpe?g|svg|gif|webp|avif|bmp|ico|heic|heif|tiff?)$/iu.test(name)

export const imageFit = { mode: 'scale-down', resize: 'until-interaction', padding: 24 } satisfies ViewerFitOptions

function getZoomLayer(host: HTMLElement, baseScale: number) {
  const layer = host.querySelector<HTMLElement>('.image-stage > .image-frame')
  const stage = layer?.parentElement
  const viewport = stage?.closest<HTMLElement>('.image-viewer')
  if (!layer || !stage || !viewport || viewport.scrollLeft || viewport.scrollTop) return
  const { width, height } = layer.getBoundingClientRect()
  if (!width || !height) return
  const style = getComputedStyle(stage)
  const scaleLimit = baseScale * Math.min(
    (viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / width,
    (viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / height,
  )
  if (scaleLimit >= baseScale) return { layer, baseScale, scaleLimit }
}

export function createImageZoom(
  host: HTMLElement,
  getViewer: () => Pick<ViewerController, 'getZoomState' | 'applyViewState'> | undefined,
  onVisualZoom: (state: ImagePreviewState) => void,
) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  let targetScale: number | undefined
  let frame = 0
  let lastFrame = 0
  let applying = false
  let composite: ReturnType<typeof getZoomLayer>
  let animationScale: number | undefined

  const schedule = () => {
    if (!frame && !applying && targetScale !== undefined) frame = requestAnimationFrame(update)
  }

  async function update(time: number) {
    frame = 0
    const viewer = getViewer()
    const zoom = viewer?.getZoomState()
    if (!viewer || !zoom || targetScale === undefined) {
      cancel()
      return
    }
    const instant = reducedMotion.matches
    if (!lastFrame && !instant) composite = getZoomLayer(host, zoom.scale)
    const elapsed = lastFrame ? Math.max(1, time - lastFrame) : 16
    lastFrame = time
    const current = animationScale ?? zoom.scale
    const fraction = instant ? 1 : 1 - Math.exp(-elapsed / 38)
    const scale = current + (targetScale - current) * fraction
    const settled = Math.abs(targetScale - scale) < 0.001
    // While the image fits, its layout stays centered at every intermediate scale.
    // Animate its frame without resizing the decoded image or its scroll container.
    if (!settled && composite && targetScale <= composite.scaleLimit) {
      composite.layer.style.setProperty('--ob-image-zoom', String(scale / composite.baseScale))
      if (animationScale === undefined) composite.layer.classList.add('onebox-image-zoom-layer')
      animationScale = scale
      onVisualZoom({
        label: `${Math.round(scale * 100)}%`,
        canZoomIn: scale < (zoom.maxScale ?? 5),
        canZoomOut: scale > (zoom.minScale ?? 0.1),
      })
      schedule()
      return
    }

    const next = settled ? targetScale : scale
    if (settled) cancel()
    else {
      clearLayer()
      // Keep the interpolated value across frames even when the renderer rounds its scale.
      animationScale = scale
    }
    applying = true
    try {
      await viewer.applyViewState({ scale: next }, { source: 'user', action: 'zoom-change', notify: settled })
    } catch {
      cancel()
    } finally {
      applying = false
      schedule()
    }
  }

  function clearLayer() {
    composite?.layer.classList.remove('onebox-image-zoom-layer')
    composite?.layer.style.removeProperty('--ob-image-zoom')
    composite = undefined
  }

  function cancel() {
    cancelAnimationFrame(frame)
    frame = 0
    lastFrame = 0
    targetScale = undefined
    animationScale = undefined
    clearLayer()
  }

  return {
    scaleBy(factor: number) {
      const zoom = getViewer()?.getZoomState()
      if (!zoom || !Number.isFinite(factor) || factor <= 0) return false
      const next = (targetScale ?? zoom.scale) * factor
      const scale = Math.min(zoom.maxScale ?? 5, Math.max(zoom.minScale ?? 0.1, next))
      if (targetScale === undefined && scale === zoom.scale) return true
      targetScale = scale
      schedule()
      return true
    },
    finish() {
      const scale = targetScale
      if (scale === undefined) return
      cancel()
      void getViewer()?.applyViewState({ scale }, { source: 'user', action: 'zoom-change' }).catch(() => {})
    },
    cancel,
  }
}

export type ImagePreviewAction = 'rotate' | 'zoom-out' | 'fit' | 'zoom-in'

export interface ImagePreviewState {
  label: string
  canZoomIn: boolean
  canZoomOut: boolean
  pages?: string
}
