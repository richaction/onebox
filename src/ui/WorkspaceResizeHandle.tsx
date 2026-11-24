import { createSignal, onCleanup, onMount } from 'solid-js'

const minimum = 180
const maximum = 460
const sidebarSettings = {
  workspace: { key: 'onebox:workspace-width', initialWidth: 252, label: '调整侧栏宽度', controls: 'workspace-sidebar' },
  ai: { key: 'onebox:ai-sidebar-width', initialWidth: 306, label: '调整 AI 侧栏宽度', controls: 'onebox-ai-sidebar' },
}
type Sidebar = keyof typeof sidebarSettings

export function initialSidebarWidth(sidebar: Sidebar) {
  const settings = sidebarSettings[sidebar]
  try {
    const saved = Number(localStorage.getItem(settings.key))
    if (Number.isFinite(saved) && saved >= minimum && saved <= maximum) return saved
  } catch { /* Storage can be unavailable. */ }
  return settings.initialWidth
}

export default function WorkspaceResizeHandle(props: {
  sidebar: Sidebar
  width: number
  onWidth: (width: number) => void
  onResize: (resizing: boolean) => void
}) {
  const settings = sidebarSettings[props.sidebar]
  const direction = props.sidebar === 'ai' ? -1 : 1
  const limit = () => Math.max(minimum, Math.min(maximum, window.innerWidth - 360))
  const [available, setAvailable] = createSignal(limit())
  const current = () => Math.min(props.width, available())
  let handle!: HTMLDivElement
  let drag: { id: number; x: number; width: number } | undefined

  const remember = (width: number) => {
    try { localStorage.setItem(settings.key, String(width)) } catch { /* Keep the session width. */ }
  }
  const change = (width: number) => {
    const next = Math.round(Math.max(minimum, Math.min(available(), width)))
    props.onWidth(next)
    return next
  }
  const stopDragging = () => {
    if (!drag) return
    const { id } = drag
    drag = undefined
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id)
    props.onResize(false)
    remember(props.width)
  }
  const finish = (event: PointerEvent) => { if (drag?.id === event.pointerId) stopDragging() }
  const resizeFromPointer = (event: PointerEvent) => {
    if (drag?.id === event.pointerId) change(drag.width + (event.clientX - drag.x) * direction)
  }
  const release = (event: PointerEvent) => {
    resizeFromPointer(event)
    finish(event)
  }

  onMount(() => {
    const resize = () => setAvailable(limit())
    window.addEventListener('resize', resize)
    // A release or the next press can reach the window without hitting the handle.
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointercancel', finish, true)
    window.addEventListener('pointerdown', finish, true)
    window.addEventListener('blur', stopDragging)
    onCleanup(() => {
      stopDragging()
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('pointercancel', finish, true)
      window.removeEventListener('pointerdown', finish, true)
      window.removeEventListener('blur', stopDragging)
    })
  })

  return (
    <div ref={handle} class={`sidebar-resize-handle ${props.sidebar}-resize-handle`} role="separator" aria-label={settings.label}
      aria-orientation="vertical" aria-controls={settings.controls} tabIndex={0}
      aria-valuemin={minimum} aria-valuemax={available()} aria-valuenow={current()}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag) return
        event.preventDefault()
        drag = { id: event.pointerId, x: event.clientX, width: current() }
        event.currentTarget.setPointerCapture(event.pointerId)
        props.onResize(true)
      }}
      onPointerMove={resizeFromPointer}
      onLostPointerCapture={finish}
      onKeyDown={(event) => {
        const width = event.key === 'ArrowLeft' ? current() - 16 * direction
          : event.key === 'ArrowRight' ? current() + 16 * direction
          : event.key === 'Home' ? minimum : event.key === 'End' ? available() : undefined
        if (width === undefined) return
        event.preventDefault()
        remember(change(width))
      }}
    />
  )
}
