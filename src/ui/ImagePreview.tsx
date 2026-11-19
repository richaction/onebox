import { createSignal, onCleanup, onMount, Show } from 'solid-js'

type GestureEvent = MouseEvent & { scale: number }
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))

export default function ImagePreview(props: { url: string; name: string; onError: () => void }) {
  let stage!: HTMLDivElement
  let image!: HTMLImageElement
  let reposition = 0
  let pinch: { zoom: number; x: number; y: number } | undefined
  let drag: { pointer: number; x: number; y: number; left: number; top: number } | undefined
  const [size, setSize] = createSignal({ width: 0, height: 0 })
  const [viewport, setViewport] = createSignal({ width: 0, height: 0 })
  const [scale, setScale] = createSignal<number>()
  const [dragging, setDragging] = createSignal(false)
  const fit = () => Math.max(0.001, Math.min(1,
    (viewport().width - 32) / size().width, (viewport().height - 32) / size().height))
  const zoom = () => scale() ?? fit()
  const min = () => Math.min(0.1, fit())
  const max = 8
  const overflow = () => size().width * zoom() + 32 > viewport().width + 1 ||
    size().height * zoom() + 32 > viewport().height + 1

  const zoomTo = (next: number | undefined, x?: number, y?: number) => {
    if (!size().width) return
    cancelAnimationFrame(reposition)
    const bounds = stage.getBoundingClientRect()
    const cursorX = x ?? bounds.left + stage.clientWidth / 2
    const cursorY = y ?? bounds.top + stage.clientHeight / 2
    const previous = image.getBoundingClientRect()
    const horizontal = clamp((cursorX - previous.left) / previous.width, 0, 1)
    const vertical = clamp((cursorY - previous.top) / previous.height, 0, 1)
    setScale(next === undefined ? undefined : clamp(next, min(), max))
    reposition = requestAnimationFrame(() => {
      const current = image.getBoundingClientRect()
      stage.scrollLeft += current.left + current.width * horizontal - cursorX
      stage.scrollTop += current.top + current.height * vertical - cursorY
    })
  }

  const step = (direction: number) => zoomTo(zoom() * 1.25 ** direction)
  const resetDrag = () => {
    drag = undefined
    setDragging(false)
  }

  onMount(() => {
    const resize = new ResizeObserver(() => setViewport({ width: stage.clientWidth, height: stage.clientHeight }))
    resize.observe(stage)
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      if (pinch) return
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1)
      zoomTo(zoom() * Math.exp(clamp(-delta / 250, -1, 1)), event.clientX, event.clientY)
    }
    const gestureStart = (event: Event) => {
      event.preventDefault()
      const { clientX, clientY } = event as GestureEvent
      pinch = { zoom: zoom(), x: clientX, y: clientY }
    }
    const gestureChange = (event: Event) => {
      event.preventDefault()
      const { scale } = event as GestureEvent
      if (pinch && Number.isFinite(scale)) zoomTo(pinch.zoom * scale, pinch.x, pinch.y)
    }
    const gestureEnd = (event: Event) => {
      event.preventDefault()
      pinch = undefined
    }
    stage.addEventListener('wheel', wheel, { passive: false })
    stage.addEventListener('gesturestart', gestureStart, { passive: false })
    stage.addEventListener('gesturechange', gestureChange, { passive: false })
    stage.addEventListener('gestureend', gestureEnd, { passive: false })
    onCleanup(() => {
      resize.disconnect()
      cancelAnimationFrame(reposition)
      stage.removeEventListener('wheel', wheel)
      stage.removeEventListener('gesturestart', gestureStart)
      stage.removeEventListener('gesturechange', gestureChange)
      stage.removeEventListener('gestureend', gestureEnd)
    })
  })

  return (
    <div class="image-viewer">
      <div class="preview-controls" role="group" aria-label="图片缩放">
        <button type="button" aria-label="缩小" title="缩小（−）" disabled={!size().width || zoom() <= min()}
          onClick={() => step(-1)}>−</button>
        <output aria-label="缩放比例">{size().width ? `${(zoom() * 100).toFixed(zoom() < 0.1 ? 1 : 0)}%` : '—'}</output>
        <button type="button" aria-label="放大" title="放大（+）" disabled={!size().width || zoom() >= max}
          onClick={() => step(1)}>+</button>
        <span class="preview-control-separator" aria-hidden="true" />
        <button type="button" aria-pressed={scale() === undefined} title="适合窗口（0）" onClick={() => zoomTo(undefined)}>适合</button>
        <button type="button" aria-pressed={scale() === 1} title="实际大小（1）" onClick={() => zoomTo(1)}>原尺寸</button>
        <Show when={size().width}>
          <span class="image-dimensions">{size().width} × {size().height}</span>
        </Show>
      </div>
      <div class="image-preview-stage" ref={stage} tabIndex={0} aria-label="图片预览，按加减键缩放"
        classList={{ 'can-pan': overflow(), 'is-panning': dragging() }}
        onKeyDown={(event) => {
          if (event.metaKey || event.ctrlKey || event.altKey) return
          switch (event.key) {
            case '+': case '=': step(1); break
            case '-': step(-1); break
            case '0': zoomTo(undefined); break
            case '1': zoomTo(1); break
            default: return
          }
          event.preventDefault()
        }}
        onPointerDown={(event) => {
          if (!overflow() || event.button !== 0 || event.pointerType === 'touch' ||
            event.target !== image) return
          drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop }
          stage.setPointerCapture(event.pointerId)
          setDragging(true)
          stage.focus({ preventScroll: true })
          event.preventDefault()
        }}
        onPointerMove={(event) => {
          if (drag?.pointer !== event.pointerId) return
          stage.scrollLeft = drag.left + drag.x - event.clientX
          stage.scrollTop = drag.top + drag.y - event.clientY
        }}
        onLostPointerCapture={resetDrag}>
        <div class="image-preview-canvas">
          <img ref={image} src={props.url} alt={props.name} draggable={false}
            style={size().width ? { width: `${size().width * zoom()}px`, height: `${size().height * zoom()}px` } : { visibility: 'hidden' }}
            onLoad={() => setSize({ width: image.naturalWidth, height: image.naturalHeight })}
            onError={props.onError} />
        </div>
      </div>
    </div>
  )
}
