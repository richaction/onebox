export function reachesDragThreshold(dx: number, dy: number, pointerType = 'mouse') {
  return Math.hypot(dx, dy) >= (pointerType === 'touch' ? 18 : 10)
}

export function enableButtonClickTolerance(document: Document) {
  const window = document.defaultView!
  type Press = { button: HTMLButtonElement; pointer: number; x: number; y: number; activateOnRelease: boolean }
  let press: Press | undefined
  let canceled: Press | undefined
  let activated: Press | undefined

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
    const previousActivation = activated
    canceled = undefined
    activated = undefined
    if (event.defaultPrevented || !(event.target instanceof Element)) return
    const button = event.target.closest('button')
    if (!button?.isConnected || button.matches(':disabled, [aria-disabled="true"]') ||
      button.hasPointerCapture(event.pointerId) || event.target.hasPointerCapture(event.pointerId)) return
    // Capture keeps the native click on the pressed button through small edge crossings.
    button.setPointerCapture(event.pointerId)
    press = { button, pointer: event.pointerId, x: event.clientX, y: event.clientY,
      activateOnRelease: event.pointerType === 'mouse' && button.hasAttribute('data-activate-on-release') }
    // A delayed click for the previous button can arrive during the next mouse press.
    if (press.activateOnRelease) canceled = previousActivation
  }

  function move(event: PointerEvent) {
    if (event.pointerId !== press?.pointer) return
    if (outsideTolerance(event, press)) {
      canceled = undefined
      releaseCapture()
    }
  }

  function finish(event: PointerEvent) {
    if (event.pointerId !== press?.pointer) return
    const current = press
    press = undefined
    canceled = undefined
    // Some devices report the last movement only with the release. Its target
    // was already captured, so discard the click if the pointer went outside.
    if (event.type !== 'pointerup') return
    if (outsideTolerance(event, current) &&
      !current.button.contains(document.elementFromPoint(event.clientX, event.clientY))) {
      canceled = current
      return
    }
    if (current.activateOnRelease && current.button.isConnected && !current.button.disabled) {
      if (current.button.hasPointerCapture(event.pointerId)) current.button.releasePointerCapture(event.pointerId)
      current.button.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, composed: true, detail: event.detail || 1,
        clientX: event.clientX, clientY: event.clientY, altKey: event.altKey, ctrlKey: event.ctrlKey,
        metaKey: event.metaKey, shiftKey: event.shiftKey,
      }))
      activated = current
    }
  }

  function finishNativeButton(event: PointerEvent) {
    if (!press?.activateOnRelease) finish(event)
  }

  function click(event: MouseEvent) {
    const blocked = activated ?? canceled
    if (!blocked || event.detail === 0) return
    const { button, pointer } = blocked
    if ('pointerId' in event && event.pointerId !== pointer) return
    // Opening AI removes the original button before WebKit delivers its native click.
    if (!activated && !event.composedPath().includes(button)) return
    activated = undefined
    canceled = undefined
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function reset() {
    releaseCapture()
    canceled = undefined
    activated = undefined
  }

  // Existing button controls can claim the pointer or cancel the press first.
  window.addEventListener('pointerdown', start)
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', finishNativeButton, true)
  // Let the menu observe release before running a command that may replace it.
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish, true)
  window.addEventListener('click', click, true)
  window.addEventListener('blur', reset)

  return () => {
    reset()
    window.removeEventListener('pointerdown', start)
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', finishNativeButton, true)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish, true)
    window.removeEventListener('click', click, true)
    window.removeEventListener('blur', reset)
  }
}
