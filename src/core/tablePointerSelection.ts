import { CellSelection, cellAround, tableEditingKey } from '@tiptap/pm/tables'
import type { EditorView } from '@tiptap/pm/view'
import type { ResolvedPos } from '@tiptap/pm/model'
import { reachesDragThreshold } from './buttonClickTolerance'

export function trackTablePointerSelection(view: EditorView) {
  const window = view.dom.ownerDocument.defaultView!
  let press: { event: PointerEvent; anchor: ResolvedPos; selecting: boolean } | undefined

  const cellAt = (event: PointerEvent) => {
    const point = view.posAtCoords({ left: event.clientX, top: event.clientY })
    if (!point) return null
    const doc = view.state.doc
    return (point.inside >= 0 && cellAround(doc.resolve(point.inside))) || cellAround(doc.resolve(point.pos))
  }
  const select = (anchor: ResolvedPos, head: ResolvedPos) => {
    const selection = new CellSelection(anchor, head)
    if (!selection.eq(view.state.selection) || tableEditingKey.getState(view.state) == null) {
      view.dispatch(view.state.tr.setSelection(selection).setMeta(tableEditingKey, anchor.pos))
    }
  }
  const stop = () => {
    press = undefined
    if (tableEditingKey.getState(view.state) != null) view.dispatch(view.state.tr.setMeta(tableEditingKey, -1))
  }
  const start = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return
    stop()
    const target = event.target
    if (!view.editable || view.composing || event.defaultPrevented || event.ctrlKey || event.metaKey ||
      !(target instanceof Element) || !view.dom.contains(target) || !target.closest('td, th') ||
      target.closest('button, input, [contenteditable="false"]')) return
    const head = cellAt(event)
    if (!head) return
    const selection = view.state.selection
    const anchor = event.shiftKey && (selection instanceof CellSelection ? selection.$anchorCell : cellAround(selection.$anchor))
    const extend = !!anchor && anchor.start(-1) === head.start(-1) && (selection instanceof CellSelection || anchor.pos !== head.pos)
    if (extend) {
      event.preventDefault()
      select(anchor, head)
    }
    if (event.pointerType === 'mouse') press = { event, anchor: extend ? anchor : head, selecting: extend }
    else if (extend) stop()
  }
  const move = (event: PointerEvent) => {
    const current = press
    if (!current || event.pointerId !== current.event.pointerId) return
    if (!(event.buttons & 1) || !view.editable || current.anchor.doc !== view.state.doc) { stop(); return }
    if (!current.selecting && !reachesDragThreshold(event.clientX - current.event.clientX, event.clientY - current.event.clientY)) return
    const head = cellAt(event)
    if (!head || head.start(-1) !== current.anchor.start(-1) || (!current.selecting && head.pos === current.anchor.pos)) return
    current.selecting = true
    select(current.anchor, head)
  }
  const finish = (event: PointerEvent) => { if (press?.event.pointerId === event.pointerId) stop() }
  view.dom.addEventListener('pointerdown', start)
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', finish, true)
  window.addEventListener('pointercancel', finish, true)
  window.addEventListener('blur', stop)
  view.dom.addEventListener('dragstart', stop)
  return () => {
    view.dom.removeEventListener('pointerdown', start)
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', finish, true)
    window.removeEventListener('pointercancel', finish, true)
    window.removeEventListener('blur', stop)
    view.dom.removeEventListener('dragstart', stop)
  }
}
