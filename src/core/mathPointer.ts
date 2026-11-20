import type { MathfieldElement } from 'mathlive'

export function bindMathPointer(
  field: MathfieldElement,
  activate: (source: boolean) => boolean,
) {
  let press: { id: number; x: number; y: number; anchor: number; dragging: boolean } | undefined
  const extend = (anchor: number, head: number) => {
    if (head === anchor) field.position = head
    else field.selection = {
      ranges: [[Math.min(anchor, head), Math.max(anchor, head)]],
      direction: head < anchor ? 'backward' : 'forward',
    }
  }

  // Register before connecting the field, so MathLive never starts a second
  // pointer tracker for the same interaction.
  field.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0 || event.metaKey || event.ctrlKey) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!activate(event.altKey)) return
    const at = field.getOffsetFromPoint(event.clientX, event.clientY)
    const head = at < 0 ? field.position : at
    const anchor = event.shiftKey ? (field.selection.direction === 'backward'
      ? field.selection.ranges[0][1] : field.selection.ranges[0][0]) : head
    extend(anchor, head)
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, anchor, dragging: event.shiftKey }
    field.setPointerCapture(event.pointerId)
  }, true)

  field.addEventListener('pointermove', (event) => {
    if (!press || press.id !== event.pointerId) return
    const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y)
    if (!press.dragging && distance < (event.pointerType === 'touch' ? 18 : 8)) return
    press.dragging = true
    const head = field.getOffsetFromPoint(event.clientX, event.clientY)
    if (head >= 0 && head !== field.position) extend(press.anchor, head)
  })

  const endPress = (event: PointerEvent) => {
    if (press?.id === event.pointerId) press = undefined
  }
  field.addEventListener('pointerup', endPress)
  field.addEventListener('pointercancel', endPress)
  field.addEventListener('lostpointercapture', endPress)
}
