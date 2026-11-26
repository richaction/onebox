type PreviewMedia = HTMLImageElement | SVGSVGElement
type Point = { x: number; y: number }

const minScale = 0.25
const maxScale = 5
const zoomStep = 1.25
const visibleEdge = 48

function clampOffset(offset: number, start: number, size: number, viewportSize: number) {
  const visible = Math.min(visibleEdge, size, viewportSize / 2)
  return Math.max(visible - start - size, Math.min(viewportSize - visible - start, offset))
}

export function enableExpandedPreviewZoom(viewport: HTMLElement, content: HTMLElement, media: PreviewMedia) {
  const toolbar = viewport.ownerDocument.createElement('div')
  toolbar.className = 'rich-preview-zoom-tools'
  toolbar.setAttribute('role', 'group')
  toolbar.setAttribute('aria-label', '预览缩放')
  const button = (label: string, text: string, activate: () => void) => {
    const control = viewport.ownerDocument.createElement('button')
    control.type = 'button'
    control.title = label
    control.setAttribute('aria-label', label)
    control.textContent = text
    control.onclick = activate
    toolbar.append(control)
    return control
  }

  let scale = 1
  let offset: Point = { x: 0, y: 0 }
  let painted = { ...offset, scale }
  let geometry: { viewport: DOMRect; media: DOMRect } | undefined
  let frame = 0
  const zoomOut = button('缩小', '−', () => zoom(scale / zoomStep))
  const reset = button('恢复默认缩放', '100%', () => {
    scale = 1
    offset = { x: 0, y: 0 }
    schedule()
  })
  const zoomIn = button('放大', '+', () => zoom(scale * zoomStep))
  content.dataset.zoomable = ''
  viewport.dataset.navigable = ''
  viewport.dataset.pointerDragHandle = ''
  viewport.setAttribute('aria-description', '用方向键移动图面')

  function useNaturalWidth() {
    const width = media instanceof HTMLImageElement ? media.naturalWidth : media.viewBox.baseVal.width
    if (width > 0) content.style.setProperty('--preview-media-base', `${width}px`)
  }
  useNaturalWidth()
  if (media instanceof HTMLImageElement) media.addEventListener('load', useNaturalWidth, { once: true })

  function measure() {
    const bounds = viewport.getBoundingClientRect()
    const rect = media.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    // The transform affects the visual rectangle, never the observed layout size.
    geometry = { viewport: bounds, media: new DOMRect(
      rect.left - bounds.left - painted.x, rect.top - bounds.top - painted.y,
      rect.width / painted.scale, rect.height / painted.scale,
    ) }
    limitOffset()
    schedule()
  }

  function limitOffset() {
    if (!geometry) return
    const { viewport, media } = geometry
    offset.x = clampOffset(offset.x, media.x, media.width * scale, viewport.width)
    offset.y = clampOffset(offset.y, media.y, media.height * scale, viewport.height)
  }

  function paint() {
    if (offset.x === painted.x && offset.y === painted.y && scale === painted.scale) return
    media.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`
    if (scale !== painted.scale) {
      const percentage = `${Math.round(scale * 100)}%`
      if (reset.textContent !== percentage) reset.textContent = percentage
      zoomOut.disabled = scale === minScale
      zoomIn.disabled = scale === maxScale
    }
    painted = { ...offset, scale }
  }

  function schedule() {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      paint()
    })
  }

  function zoom(requested: number, anchor?: Point) {
    const next = Math.max(minScale, Math.min(maxScale, requested))
    if (!geometry || next === scale) return
    const { viewport, media } = geometry
    const x = anchor ? anchor.x - viewport.left : viewport.width / 2
    const y = anchor ? anchor.y - viewport.top : viewport.height / 2
    const ratio = next / scale
    offset.x += (media.x + offset.x - x) * (ratio - 1)
    offset.y += (media.y + offset.y - y) * (ratio - 1)
    scale = next
    limitOffset()
    schedule()
  }

  function moveOffset(x: number, y: number) {
    offset.x += x
    offset.y += y
    limitOffset()
  }

  function pan(x: number, y: number) {
    moveOffset(x, y)
    schedule()
  }

  measure()
  const resize = new ResizeObserver(measure)
  resize.observe(media)
  resize.observe(viewport)

  viewport.addEventListener('wheel', (event) => {
    const { deltaMode, deltaX, deltaY } = event
    if (!geometry || (!deltaX && !deltaY) || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return
    event.preventDefault()
    const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? geometry.viewport.height : 1
    if (Math.abs(deltaX) > Math.abs(deltaY)) pan(-deltaX * unit, -deltaY * unit)
    else {
      const delta = Math.max(-180, Math.min(180, deltaY * unit))
      zoom(scale * Math.exp(-delta * 0.002), { x: event.clientX, y: event.clientY })
    }
  }, { passive: false })

  viewport.onkeydown = (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const page = Math.max(40, (geometry?.viewport.height ?? 0) - 40)
    switch (event.key) {
      case 'ArrowLeft': pan(40, 0); break
      case 'ArrowRight': pan(-40, 0); break
      case 'ArrowUp': pan(0, 40); break
      case 'ArrowDown': pan(0, -40); break
      case 'PageUp': pan(0, page); break
      case 'PageDown': pan(0, -page); break
      default: return
    }
    event.preventDefault()
  }

  let drag: { id: number; x: number; y: number } | undefined
  viewport.onpointerdown = (event) => {
    if (event.defaultPrevented || event.button !== 0 || !event.isPrimary) return
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY }
    viewport.setPointerCapture(event.pointerId)
    viewport.dataset.panning = ''
    event.preventDefault()
  }
  const dragTo = (event: PointerEvent) => {
    if (drag?.id !== event.pointerId) return
    moveOffset(event.clientX - drag.x, event.clientY - drag.y)
    drag.x = event.clientX
    drag.y = event.clientY
    // Publish the latest position before the browser's next paint, even if
    // it delivers this pointer event after the current animation callbacks.
    paint()
  }
  const endDrag = (event: PointerEvent) => {
    if (drag?.id !== event.pointerId) return
    drag = undefined
    delete viewport.dataset.panning
  }
  viewport.onpointermove = dragTo
  viewport.onpointerup = (event) => {
    dragTo(event)
    endDrag(event)
  }
  viewport.onpointercancel = viewport.onlostpointercapture = endDrag

  return {
    toolbar,
    destroy() {
      cancelAnimationFrame(frame)
      resize.disconnect()
      media.removeEventListener('load', useNaturalWidth)
    },
  }
}
