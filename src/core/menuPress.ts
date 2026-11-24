export function trackMenuPress(document: Document, onCancel: (menu: HTMLElement) => void) {
  let press: { menu: HTMLElement; pointer: number; released: boolean } | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined

  function clear() {
    clearTimeout(timeout)
    press = undefined
  }

  function release(event: PointerEvent) {
    if (!press || press.released || event.pointerId !== press.pointer) return
    const { menu } = press
    if (event.type === 'pointercancel' || !event.composedPath().includes(menu)) {
      clear()
      onCancel(menu)
      return
    }
    // mouseup, focus, and layout handlers can still run before click.
    press.released = true
    timeout = setTimeout(clear, 400)
  }

  function click(event: MouseEvent) {
    if (!press || !event.composedPath().includes(press.menu)) return
    clearTimeout(timeout)
    // Keep the command's target stable through the click's default action as well.
    timeout = setTimeout(clear, 0)
  }

  document.addEventListener('pointerup', release, true)
  document.addEventListener('pointercancel', release, true)
  document.addEventListener('click', click, true)

  return {
    start(event: PointerEvent, menu: HTMLElement | undefined) {
      clear()
      if (menu && event.button === 0 && !event.defaultPrevented) press = { menu, pointer: event.pointerId, released: false }
    },
    active(menu: HTMLElement | undefined) { return !!press && press.menu === menu },
    clear,
    destroy() {
      clear()
      document.removeEventListener('pointerup', release, true)
      document.removeEventListener('pointercancel', release, true)
      document.removeEventListener('click', click, true)
    },
  }
}
