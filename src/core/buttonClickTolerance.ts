export function reachesDragThreshold(dx: number, dy: number, pointerType = 'mouse') {
  return Math.hypot(dx, dy) >= (pointerType === 'touch' ? 18 : 10)
}

export function enableButtonClickTolerance(document: Document) {
  const window = document.defaultView!
  type Press = { button: HTMLButtonElement; pointer: number; x: number; y: number }
  let press: Press | undefined
  let canceled: Press | undefined

  const outsideTolerance = (event: PointerEvent, current: Press) =>
    reachesDragThreshold(event.clientX - current.x, event.clientY - current.y, event.pointerType)

  function releaseCapture() {
    const current = press
    press = undefined
    if (current?.button.hasPointerCapture(current.pointer)) current.button.releasePointerCapture(current.pointer)
  }

  function start(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0) return
    releaseCapture()
    canceled = undefined
    if (event.defaultPrevented || !(event.target instanceof Element)) return
    const button = event.target.closest('button')
    if (!button?.isConnected || button.matches(':disabled, [aria-disabled="true"]') ||
      button.hasPointerCapture(event.pointerId) || event.target.hasPointerCapture(event.pointerId)) return
    // Capture keeps the native click on the pressed button through small edge crossings.
    button.setPointerCapture(event.pointerId)
    press = { button, pointer: event.pointerId, x: event.clientX, y: event.clientY }
  }

  function move(event: PointerEvent) {
    if (event.pointerId !== press?.pointer) return
    if (outsideTolerance(event, press)) releaseCapture()
  }

  function finish(event: PointerEvent) {
    if (event.pointerId !== press?.pointer) return
    const current = press
    press = undefined
    // Some devices report the last movement only with the release. Its target
    // was already captured, so discard the click if the pointer went outside.
    if (event.type === 'pointerup' && outsideTolerance(event, current) &&
      !current.button.contains(document.elementFromPoint(event.clientX, event.clientY))) canceled = current
  }

  function click(event: MouseEvent) {
    if (!canceled || event.detail === 0) return
    const { button, pointer } = canceled
    if ('pointerId' in event && event.pointerId !== pointer) return
    canceled = undefined
    if (!event.composedPath().includes(button)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function reset() {
    releaseCapture()
    canceled = undefined
  }

  // Existing button controls can claim the pointer or cancel the press first.
  window.addEventListener('pointerdown', start)
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', finish, true)
  window.addEventListener('pointercancel', finish, true)
  window.addEventListener('click', click, true)
  window.addEventListener('blur', reset)

  return () => {
    reset()
    window.removeEventListener('pointerdown', start)
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', finish, true)
    window.removeEventListener('pointercancel', finish, true)
    window.removeEventListener('click', click, true)
    window.removeEventListener('blur', reset)
  }
}
