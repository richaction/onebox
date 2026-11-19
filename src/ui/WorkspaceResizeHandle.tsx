import { createSignal, onCleanup, onMount } from 'solid-js'

const widthKey = 'onebox:workspace-width'
const minimum = 180
const maximum = 460
const defaultWidth = 252

export function initialWorkspaceWidth() {
  try {
    const saved = Number(localStorage.getItem(widthKey))
    if (Number.isFinite(saved) && saved >= minimum && saved <= maximum) return saved
  } catch { /* Storage can be unavailable. */ }
  return defaultWidth
}

export default function WorkspaceResizeHandle(props: {
  width: number
  onWidth: (width: number) => void
  onResize: (resizing: boolean) => void
}) {
  const limit = () => Math.max(minimum, Math.min(maximum, window.innerWidth - 360))
  const [available, setAvailable] = createSignal(limit())
  const current = () => Math.min(props.width, available())
  let drag: { id: number; x: number; width: number } | undefined

  onMount(() => {
    const resize = () => setAvailable(limit())
    window.addEventListener('resize', resize)
    onCleanup(() => window.removeEventListener('resize', resize))
  })

  const remember = (width: number) => {
    try { localStorage.setItem(widthKey, String(width)) } catch { /* Keep the session width. */ }
  }
  const change = (width: number) => {
    const next = Math.round(Math.max(minimum, Math.min(available(), width)))
    props.onWidth(next)
    return next
  }
  const finish = (event: PointerEvent) => {
    if (drag?.id !== event.pointerId) return
    drag = undefined
    props.onResize(false)
    remember(props.width)
  }
  onCleanup(() => { if (drag) props.onResize(false) })

  return (
    <div class="workspace-resize-handle" role="separator" aria-label="调整侧栏宽度"
      aria-orientation="vertical" aria-controls="workspace-sidebar" tabIndex={0}
      aria-valuemin={minimum} aria-valuemax={available()} aria-valuenow={current()}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag) return
        event.preventDefault()
        drag = { id: event.pointerId, x: event.clientX, width: current() }
        event.currentTarget.setPointerCapture(event.pointerId)
        props.onResize(true)
      }}
      onPointerMove={(event) => {
        if (drag?.id === event.pointerId) change(drag.width + event.clientX - drag.x)
      }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onKeyDown={(event) => {
        const width = event.key === 'ArrowLeft' ? current() - 16
          : event.key === 'ArrowRight' ? current() + 16
          : event.key === 'Home' ? minimum : event.key === 'End' ? available() : undefined
        if (width === undefined) return
        event.preventDefault()
        remember(change(width))
      }}
    />
  )
}
