export function reachesDragThreshold(dx: number, dy: number, pointerType = 'mouse') {
  return Math.hypot(dx, dy) >= (pointerType === 'touch' ? 18 : 10)
}

export function enableButtonClickTolerance(document: Document) {
  const window = document.defaultView!
  type Press = { button: HTMLButtonElement; pointer: number; x: number; y: number; activateOnRelease: boolean }
  type EarlyRelease = { button: HTMLButtonElement; event: PointerEvent; received: number; nativeClicked?: boolean }
  let press: Press | undefined
  let canceled: Press | undefined
  let activated: Press | undefined
  let primaryDown: number | undefined
  let earlyRelease: EarlyRelease | undefined

  const outsideTolerance = (event: PointerEvent, current: Press) =>
    reachesDragThreshold(event.clientX - current.x, event.clientY - current.y, event.pointerType)

  function buttonAt(event: Event) {
    const target = event.target
    return target instanceof Element ? target.closest('button') : null
  }

  function activatesOnRelease(button: HTMLButtonElement) {
    return !!button.closest('[data-activate-on-release]')
  }

  function recoversReorderedTap(button: HTMLButtonElement) {
    return activatesOnRelease(button) || button.hasAttribute('data-recover-reordered-tap')
  }

  function rememberDown(event: PointerEvent) {
    if (event.isPrimary && event.button === 0) primaryDown = event.pointerId
  }

  function releaseCapture() {
    const current = press
    press = undefined
    if (current?.button.hasPointerCapture(current.pointer)) current.button.releasePointerCapture(current.pointer)
  }

  function start(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0) return
    releaseCapture()
    const earlier = earlyRelease
    earlyRelease = undefined
    const previousActivation = activated
    canceled = undefined
    activated = undefined
    if (event.defaultPrevented || !(event.target instanceof Element)) return
    const button = buttonAt(event)
    if (!button?.isConnected || button.matches(':disabled, [aria-disabled="true"]') ||
      button.hasPointerCapture(event.pointerId) || event.target.hasPointerCapture(event.pointerId)) return
    const current = { button, pointer: event.pointerId, x: event.clientX, y: event.clientY,
      activateOnRelease: event.pointerType === 'mouse' && activatesOnRelease(button) }
    // WebKit can deliver a trackpad tap's up before its down when an input method is active.
    // Match their original timestamps and target. Never wait for a later gesture to finish the tap.
    if (earlier?.button === button && event.pointerType === 'mouse' && earlier.event.pointerId === event.pointerId &&
        earlier.event.timeStamp >= event.timeStamp && window.performance.now() - earlier.received <= 150 &&
        !outsideTolerance(earlier.event, current)) {
      primaryDown = undefined
      event.preventDefault()
      if (!earlier.nativeClicked) activate(current, earlier.event)
      return
    }
    // Capture keeps the native click on the pressed button through small edge crossings.
    button.setPointerCapture(event.pointerId)
    press = current
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
    if (current.activateOnRelease && current.button.isConnected && !current.button.disabled) activate(current, event)
  }

  function activate(current: Press, event: PointerEvent) {
    if (current.button.hasPointerCapture(event.pointerId)) current.button.releasePointerCapture(event.pointerId)
    current.button.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, composed: true, detail: event.detail || 1,
      clientX: event.clientX, clientY: event.clientY, altKey: event.altKey, ctrlKey: event.ctrlKey,
      metaKey: event.metaKey, shiftKey: event.shiftKey,
    }))
    activated = current
  }

  function finishNativeButton(event: PointerEvent) {
    if (event.isPrimary && event.button === 0) {
      const button = buttonAt(event)
      earlyRelease = primaryDown !== event.pointerId && event.pointerType === 'mouse' && button &&
          !button.matches(':disabled, [aria-disabled="true"]') && recoversReorderedTap(button)
        ? { button, event, received: window.performance.now() } : undefined
      primaryDown = undefined
    }
    if (!press?.activateOnRelease) finish(event)
  }

  function cancel(event: PointerEvent) {
    if (primaryDown === event.pointerId) primaryDown = undefined
    if (earlyRelease?.event.pointerId === event.pointerId) earlyRelease = undefined
    finish(event)
  }

  function click(event: MouseEvent) {
    if (event.detail === 0) return
    // A reversed tap can include a native click before its delayed pointerdown.
    // Its timestamp matches this release, so it belongs to the new tap.
    if (earlyRelease && event.timeStamp === earlyRelease.event.timeStamp &&
        (!('pointerId' in event) || event.pointerId === earlyRelease.event.pointerId) &&
        event.composedPath().includes(earlyRelease.button)) {
      if (earlyRelease.nativeClicked) {
        suppressClick(event)
        return
      }
      earlyRelease.nativeClicked = true
      return
    }
    const blocked = activated ?? canceled
    if (!blocked) return
    const { button, pointer } = blocked
    if ('pointerId' in event && event.pointerId !== pointer) return
    // Opening AI removes the original button before WebKit delivers its native click.
    if (!activated && !event.composedPath().includes(button)) return
    activated = undefined
    canceled = undefined
    suppressClick(event)
  }

  function suppressClick(event: MouseEvent) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function reset() {
    releaseCapture()
    canceled = undefined
    activated = undefined
    earlyRelease = undefined
    primaryDown = undefined
  }

  // Existing button controls can claim the pointer or cancel the press first.
  window.addEventListener('pointerdown', rememberDown, true)
  window.addEventListener('pointerdown', start)
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', finishNativeButton, true)
  // Let the menu observe release before running a command that may replace it.
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', cancel, true)
  window.addEventListener('click', click, true)
  window.addEventListener('blur', reset)

  return () => {
    reset()
    window.removeEventListener('pointerdown', rememberDown, true)
    window.removeEventListener('pointerdown', start)
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', finishNativeButton, true)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', cancel, true)
    window.removeEventListener('click', click, true)
    window.removeEventListener('blur', reset)
  }
}
