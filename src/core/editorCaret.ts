import { closeHistory } from '@tiptap/pm/history'
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { selectedBlock } from './blockCommands'

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

export function placeCaretInGutter(view: EditorView, event: MouseEvent, scrollRoot: HTMLElement) {
  if (!view.editable || view.composing || event.defaultPrevented || event.button !== 0 ||
    event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return
  const target = event.target
  if (!(target instanceof HTMLElement) ||
    (target !== scrollRoot && target !== view.dom.parentElement && target !== view.dom &&
      !target.matches('.onebox-block, .viewport-group'))) return

  const bounds = view.dom.getBoundingClientRect()
  const { doc } = view.state
  if (event.clientY >= bounds.bottom) {
    const grouped = doc.lastChild?.type.name === 'viewportGroup'
    const last = grouped ? doc.lastChild?.lastChild : doc.lastChild
    const continued = last && continueAfterBlock(view, doc.content.size - last.nodeSize - (grouped ? 1 : 0))
    if (!continued) {
      view.dispatch(view.state.tr.setSelection(Selection.atEnd(doc)))
    }
  } else if (event.clientY < bounds.top) {
    view.dispatch(view.state.tr.setSelection(Selection.atStart(doc)))
  } else {
    const selectingBlock = event.clientX < bounds.left
    const point = view.posAtCoords({
      // Sample inside the block instead of in the list's indentation.
      left: selectingBlock ? bounds.left + bounds.width / 2
        : Math.max(bounds.left + 1, Math.min(event.clientX, bounds.right - 1)),
      top: event.clientY,
    })
    if (!point) return
    const selection = (selectingBlock ? blockAtGutterPoint(view, event.clientY, point) : undefined)
      ?? nearestCaret(view, point.pos, event.clientY)
    view.dispatch(view.state.tr.setSelection(selection))
  }
  event.preventDefault()
  event.stopPropagation()
  view.focus()
}

export function blockAtGutterPoint(view: EditorView, y: number, point?: { pos: number; inside: number }) {
  if (!point) {
    const bounds = view.dom.getBoundingClientRect()
    if (y < bounds.top || y >= bounds.bottom) return
    point = view.posAtCoords({ left: bounds.left + bounds.width / 2, top: y }) ?? undefined
  }
  if (!point) return
  const direct = point.inside >= 0 ? directBlockHit(view, point.inside) : undefined
  if (direct) return direct
  const block = selectedBlock(nearestCaret(view, point.pos, y))
  if (block && NodeSelection.isSelectable(block.node)) return NodeSelection.create(view.state.doc, block.from)
}

function directBlockHit(view: EditorView, inside: number) {
  const { doc } = view.state
  const $inside = doc.resolve(inside)
  const node = $inside.nodeAfter
  if (node?.isBlock && NodeSelection.isSelectable(node) &&
    (node.isAtom || node.type.name === 'codeBlock' || node.type.name === 'listItem' || isDisplayMath(node))) {
    return NodeSelection.create(doc, inside)
  }
  // A displayed formula is rendered as an inline atom inside its own paragraph.
  if ($inside.depth && isDisplayMath($inside.parent)) return NodeSelection.create(doc, $inside.before())
}

function nearestCaret(view: EditorView, position: number, y: number) {
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
