export function reachesDragThreshold(dx: number, dy: number, pointerType = 'mouse') {
  return Math.hypot(dx, dy) >= (pointerType === 'touch' ? 18 : 10)
}

export function isClickFromRelease(click: MouseEvent, release: PointerEvent) {
  return click.detail > 0 && click.timeStamp === release.timeStamp &&
    (!('pointerId' in click) || click.pointerId === release.pointerId)
}

export function isReorderedPointerRelease(down: PointerEvent, up: PointerEvent, elapsed: number) {
  return down.pointerType === 'mouse' && down.pointerId === up.pointerId &&
    down.timeStamp <= up.timeStamp && up.timeStamp - down.timeStamp <= 150 && elapsed <= 150 &&
    !reachesDragThreshold(up.clientX - down.clientX, up.clientY - down.clientY)
}

export function enableButtonClickTolerance(document: Document) {
  const window = document.defaultView!
  type Press = { button: HTMLButtonElement; pointer: number; x: number; y: number; activateOnRelease: boolean }
  type Release = { button: HTMLButtonElement; event: PointerEvent; received: number }
  let press: Press | undefined
  let handled: Release[] = []
  let primaryDown: number | undefined
  let earlyRelease: (Release & { nativeClicked?: boolean }) | undefined
  let earlyDragRelease: { handle: Element; event: PointerEvent; received: number } | undefined
  let reorderedDown: { event: PointerEvent; release: NonNullable<typeof earlyRelease> } | undefined
  const generatedClicks = new WeakSet<MouseEvent>()
  const pending = new Map<Release, number>()

  const recent = (release: Release) => window.performance.now() - release.received <= 500
  const outsideTolerance = (event: PointerEvent, x: number, y: number) =>
    reachesDragThreshold(event.clientX - x, event.clientY - y, event.pointerType)

  function buttonAt(event: Event) {
    const target = event.target
    const button = target instanceof Element ? target.closest('button') : null
    return button?.isConnected && !button.matches(':disabled, [aria-disabled="true"]') ? button : null
  }

  function dragHandleAt(event: Event) {
    return event.target instanceof Element ? event.target.closest('[data-pointer-drag-handle]') : null
  }

  function rememberRelease(button: HTMLButtonElement, event: PointerEvent) {
    handled = handled.filter(recent)
    handled.push({ button, event, received: window.performance.now() })
  }

  function matchDown(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0) return
    const earlier = earlyRelease
    const dragRelease = earlyDragRelease
    earlyRelease = undefined
    earlyDragRelease = undefined
    reorderedDown = undefined
    primaryDown = event.pointerId
    // The native event timestamps retain their original order even when WebKit
    // delivers the mouse release first.
    if (dragRelease && dragHandleAt(event) === dragRelease.handle &&
      isReorderedPointerRelease(event, dragRelease.event, window.performance.now() - dragRelease.received)) {
      primaryDown = undefined
      event.preventDefault()
      return
    }
    if (event.ctrlKey || !earlier || !isReorderedPointerRelease(event, earlier.event, window.performance.now() - earlier.received)) return
    if (buttonAt(event) !== earlier.button && !(earlier.nativeClicked && !earlier.button.isConnected)) return
    primaryDown = undefined
    reorderedDown = { event, release: earlier }
    // Drag handles must not open a new drag for a tap that already ended.
    event.preventDefault()
  }

  function releaseCapture() {
    const current = press
    press = undefined
    if (current?.button.hasPointerCapture(current.pointer)) current.button.releasePointerCapture(current.pointer)
  }

  function start(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0) return
    releaseCapture()
    if (event === reorderedDown?.event) {
      const { button, event: release, nativeClicked } = reorderedDown.release
      reorderedDown = undefined
      if (!nativeClicked && buttonAt(event) === button) activate(button, release)
      return
    }
    if (event.defaultPrevented || event.ctrlKey || !(event.target instanceof Element)) return
    const button = buttonAt(event)
    if (!button || button.hasPointerCapture(event.pointerId) || event.target.hasPointerCapture(event.pointerId)) return
    const activateOnRelease = event.pointerType === 'mouse' && !!button.closest('[data-activate-on-release]')
    // Capture keeps the native click on the pressed button through small edge crossings.
    button.setPointerCapture(event.pointerId)
    press = { button, pointer: event.pointerId, x: event.clientX, y: event.clientY,
      activateOnRelease }
  }

  function move(event: PointerEvent) {
    if (event.pointerId !== press?.pointer) return
    if (outsideTolerance(event, press.x, press.y)) releaseCapture()
  }

  function finish(event: PointerEvent) {
    if (event.pointerId !== press?.pointer) return
    const current = press
    press = undefined
    // Some devices report the last movement only with the release. Its target
    // was already captured, so discard the click if the pointer went outside.
    if (event.type !== 'pointerup') return
    if (outsideTolerance(event, current.x, current.y) &&
      !current.button.contains(document.elementFromPoint(event.clientX, event.clientY))) {
      rememberRelease(current.button, event)
      return
    }
    if (event.pointerType !== 'mouse' || outsideTolerance(event, current.x, current.y)) return
    if (current.activateOnRelease) activate(current.button, event)
    else {
      // Keep the normal native click (including its click count and default action).
      // Only recover ordered releases for which WKWebView does not deliver click.
      const release = { button: current.button, event, received: window.performance.now() }
      pending.set(release, window.setTimeout(() => {
        pending.delete(release)
        activate(release.button, event)
      }, 40))
    }
  }

  function activate(button: HTMLButtonElement, event: PointerEvent) {
    if (!button.isConnected || button.matches(':disabled, [aria-disabled="true"]') || button.closest('[inert]')) return
    if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId)
    rememberRelease(button, event)
    const click = new MouseEvent('click', {
      bubbles: true, cancelable: true, composed: true, detail: event.detail || 1,
      clientX: event.clientX, clientY: event.clientY, altKey: event.altKey, ctrlKey: event.ctrlKey,
      metaKey: event.metaKey, shiftKey: event.shiftKey,
    })
    generatedClicks.add(click)
    button.dispatchEvent(click)
  }

  function finishNativeButton(event: PointerEvent) {
    if (event.isPrimary && event.button === 0) {
      const button = buttonAt(event)
      const dragHandle = dragHandleAt(event)
      earlyRelease = primaryDown !== event.pointerId && event.pointerType === 'mouse' && button
        ? { button, event, received: window.performance.now() } : undefined
      earlyDragRelease = primaryDown !== event.pointerId && event.pointerType === 'mouse' && dragHandle
        ? { handle: dragHandle, event, received: window.performance.now() } : undefined
      primaryDown = undefined
    }
    if (!press?.activateOnRelease) finish(event)
  }

  function cancel(event: PointerEvent) {
    if (primaryDown === event.pointerId) primaryDown = undefined
    if (earlyRelease?.event.pointerId === event.pointerId) earlyRelease = undefined
    if (earlyDragRelease?.event.pointerId === event.pointerId) earlyDragRelease = undefined
    finish(event)
  }

  function click(event: MouseEvent) {
    if (event.detail === 0 || generatedClicks.has(event)) return
    for (const [release, timer] of pending) {
      if (event.composedPath().includes(release.button) && isClickFromRelease(event, release.event)) {
        window.clearTimeout(timer)
        pending.delete(release)
      }
    }
    // A released command may remove itself before WKWebView delivers the click.
    // In that case WebKit can retarget the same release to the underlying UI.
    if (handled.some((release) => recent(release) && isClickFromRelease(event, release.event) &&
      (event.composedPath().includes(release.button) ||
        (event.clientX === release.event.clientX && event.clientY === release.event.clientY)))) {
      suppressClick(event)
      return
    }
    // A reversed tap can include a native click before its delayed pointerdown.
    if (earlyRelease && recent(earlyRelease) && isClickFromRelease(event, earlyRelease.event) &&
        event.composedPath().includes(earlyRelease.button)) {
      earlyRelease.nativeClicked = true
      rememberRelease(earlyRelease.button, earlyRelease.event)
    }
  }

  function suppressClick(event: MouseEvent) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function reset() {
    releaseCapture()
    handled = []
    earlyRelease = undefined
    earlyDragRelease = undefined
    reorderedDown = undefined
    primaryDown = undefined
    for (const timer of pending.values()) window.clearTimeout(timer)
    pending.clear()
  }

  // Existing button controls can claim the pointer or cancel the press first.
  window.addEventListener('pointerdown', matchDown, true)
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
    window.removeEventListener('pointerdown', matchDown, true)
    window.removeEventListener('pointerdown', start)
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', finishNativeButton, true)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', cancel, true)
    window.removeEventListener('click', click, true)
    window.removeEventListener('blur', reset)
  }
}
