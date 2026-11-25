import { closeHistory } from '@tiptap/pm/history'
import { Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

export function isDisplayMath(node: import('@tiptap/pm/model').Node) {
  return node.type.name === 'paragraph' && node.childCount === 1
    && node.firstChild?.type.name === 'math' && node.firstChild.attrs.display
}

export function continueAfterBlock(view: EditorView, pos: number) {
  const { doc, schema, tr } = view.state
  const block = doc.nodeAt(pos)
  if (!view.editable || view.composing || !block || (block.type.name !== 'codeBlock' && !isDisplayMath(block))) return false

  const end = pos + block.nodeSize
  const after = doc.resolve(end)
  const paragraph = schema.nodes.paragraph
  let caret = after.nodeAfter?.type === paragraph ? end + 1 : undefined
  if (!after.nodeAfter && after.parent.type.name === 'viewportGroup') {
    const boundary = after.after()
    const next = doc.resolve(boundary).nodeAfter
    if (next?.type === paragraph) caret = boundary + 1
    else if (next?.type.name === 'viewportGroup' && next.firstChild?.type === paragraph) caret = boundary + 2
  }
  if (caret === undefined) {
    if (!after.parent.canReplaceWith(after.index(), after.index(), paragraph)) return false
    closeHistory(tr).insert(end, paragraph.create())
    caret = end + 1
  }
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView())
  view.focus()
  return true
}

export function isGutterPress(view: EditorView, event: MouseEvent, scrollRoot: HTMLElement) {
  if (!view.editable || view.composing || event.defaultPrevented || event.button !== 0 ||
    event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
  const target = event.target
  return target instanceof HTMLElement &&
    (target === scrollRoot || target === view.dom.parentElement || target === view.dom ||
      target.matches('.onebox-block, .viewport-group'))
}

export function placeCaretInGutter(view: EditorView, event: MouseEvent, scrollRoot: HTMLElement) {
  if (!isGutterPress(view, event, scrollRoot)) return false
  const bounds = view.dom.getBoundingClientRect()
  const { doc } = view.state
  if (event.clientY >= bounds.bottom) {
    const grouped = doc.lastChild?.type.name === 'viewportGroup'
    const last = grouped ? doc.lastChild?.lastChild : doc.lastChild
    const continued = last && continueAfterBlock(view, doc.content.size - last.nodeSize - (grouped ? 1 : 0))
    if (!continued) {
      view.dispatch(view.state.tr.setSelection(Selection.atEnd(doc)))
    }
  } else {
    const caret = caretAtEditorPoint(view, event.clientX, event.clientY)
    if (!caret) return false
    view.dispatch(view.state.tr.setSelection(caret))
  }
  event.preventDefault()
  view.focus()
  return true
}

export function caretAtEditorPoint(view: EditorView, x: number, y: number) {
  const bounds = view.dom.getBoundingClientRect()
  if (bounds.height > 0) {
    if (y < bounds.top) return Selection.atStart(view.state.doc)
    if (y >= bounds.bottom) return Selection.atEnd(view.state.doc)
  }
  // Sample inside the block when the tap lands in the page padding.
  const left = bounds.width <= 2 ? x : x < bounds.left ? bounds.left + bounds.width / 2
    : Math.max(bounds.left + 1, Math.min(x, bounds.right - 1))
  const taskCaret = taskCaretAtPoint(view, left, y)
  if (taskCaret) return taskCaret
  const point = view.posAtCoords({ left, top: y })
  return point ? nearestCaret(view, point.pos, y) : undefined
}

export function taskCaretAtPoint(view: EditorView, x: number, y: number) {
  const document = view.dom.ownerDocument
  const hit = document.elementFromPoint(x, y)
  const task = hit?.closest('li[data-checked]')
  if (!task || !view.dom.contains(task)) return
  const content = task.querySelector(':scope > div')
  const paragraph = hit === task || hit === content ? content?.querySelector(':scope > p') : hit?.closest('p')
  if (!paragraph || paragraph.parentElement !== content) return
  const end = view.posAtDOM(paragraph, paragraph.childNodes.length)
  const edge = view.coordsAtPos(end, -1)
  const rtl = getComputedStyle(paragraph).direction === 'rtl'
  if (y >= edge.top - 3 && y <= edge.bottom + 3 && (rtl ? x <= edge.right : x >= edge.left)) {
    return TextSelection.create(view.state.doc, end)
  }

  // WebKit can resolve a point in a list item's padding to a block boundary.
  // Hit-test on the nearest painted text fragment while keeping the click's x.
  const range = document.createRange()
  range.selectNodeContents(paragraph)
  let closest: DOMRect | undefined
  let verticalDistance = Infinity
  let horizontalDistance = Infinity
  for (const rect of range.getClientRects()) {
    if (!rect.width || !rect.height) continue
    const dy = Math.max(rect.top - y, y - rect.bottom, 0)
    const dx = Math.max(rect.left - x, x - rect.right, 0)
    if (dy < verticalDistance || (dy === verticalDistance && dx < horizontalDistance)) {
      closest = rect
      verticalDistance = dy
      horizontalDistance = dx
    }
  }
  if (!closest) return
  const left = Math.max(closest.left + 0.1, Math.min(x, closest.right - 0.1))
  const top = (closest.top + closest.bottom) / 2
  const caret = document.caretPositionFromPoint?.(left, top)
  const legacy = caret ? undefined : document.caretRangeFromPoint?.(left, top)
  const node = caret?.offsetNode ?? legacy?.startContainer
  const offset = caret?.offset ?? legacy?.startOffset
  if (node && offset !== undefined && paragraph.contains(node)) {
    const position = view.posAtDOM(node, offset)
    const resolved = view.state.doc.resolve(position)
    if (resolved.parent.inlineContent) return TextSelection.create(view.state.doc, position)
  }
}

export function nearestCaret(view: EditorView, position: number, y: number) {
  const pos = view.state.doc.resolve(position)
  if (!pos.parent.inlineContent) {
    const before = Selection.findFrom(pos, -1, true)
    const after = Selection.findFrom(pos, 1, true)
    if (before && after) {
      const distance = (candidate: Selection) => {
        const rect = view.coordsAtPos(candidate.head)
        return Math.max(rect.top - y, y - rect.bottom, 0)
      }
      return distance(before) <= distance(after) ? before : after
    }
  }
  return TextSelection.between(pos, pos)
}
