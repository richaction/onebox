import { closeHistory } from '@tiptap/pm/history'
import { Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

function isDisplayMath(node: import('@tiptap/pm/model').Node) {
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
    const point = view.posAtCoords({
      left: Math.max(bounds.left + 1, Math.min(event.clientX, bounds.right - 1)),
      top: event.clientY,
    })
    if (!point) return
    const pos = doc.resolve(point.pos)
    let selection = TextSelection.between(pos, pos)
    if (!pos.parent.inlineContent) {
      const before = Selection.findFrom(pos, -1, true)
      const after = Selection.findFrom(pos, 1, true)
      if (before && after) {
        const distance = (candidate: Selection) => {
          const rect = view.coordsAtPos(candidate.head)
          const vertical = Math.max(rect.top - event.clientY, event.clientY - rect.bottom, 0)
          return vertical
        }
        selection = distance(before) <= distance(after) ? before : after
      }
    }
    view.dispatch(view.state.tr.setSelection(selection))
  }
  event.preventDefault()
  event.stopPropagation()
  view.focus()
}
