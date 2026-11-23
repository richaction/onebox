import { closeHistory } from '@tiptap/pm/history'
import { NodeSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

const documentContainer = (type: string) => type === 'doc' || type === 'viewportGroup'

export function blockDropTarget(view: EditorView, source: NodeSelection, y: number) {
  const { doc } = view.state
  const body = view.dom.getBoundingClientRect()
  const sourceParent = source.$from.parent.type.name
  const grouped = documentContainer(sourceParent)
  const head = y < body.top
  const tail = y >= body.bottom
  const hit = !head && !tail ? view.posAtCoords({ left: body.left + body.width / 2, top: y }) : null
  const point = head ? (doc.firstChild?.type.name === 'viewportGroup' ? 1 : 0)
    : tail ? doc.content.size - (doc.lastChild?.type.name === 'viewportGroup' ? 1 : 0)
    : hit && (hit.inside < 0 ? hit.pos : hit.inside)
  if (point === null || ((head || tail) && !grouped)) return

  const $point = doc.resolve(point)
  for (let depth = $point.depth; depth >= 0; depth--) {
    const parent = $point.node(depth)
    const compatible = grouped ? documentContainer(parent.type.name)
      : parent.type.name === sourceParent && depth === source.$from.depth
    if (!compatible || !parent.childCount) continue
    const index = Math.min($point.index(depth), parent.childCount - 1)
    const start = $point.posAtIndex(index, depth)
    const node = view.nodeDOM(start)
    if (!(node instanceof HTMLElement)) return
    const rect = node.getBoundingClientRect()
    const after = y >= rect.top + rect.height / 2
    const pos = after ? start + parent.child(index).nodeSize : start
    if ((pos >= source.from && pos <= source.to) ||
      !parent.canReplaceWith(index + Number(after), index + Number(after), source.node.type, source.node.marks)) return
    return { pos, x: rect.left, y: after ? rect.bottom : rect.top, width: rect.width }
  }
}

export function moveBlock(view: EditorView, source: NodeSelection, target: number) {
  if (!view.editable || view.state.selection !== source || (target >= source.from && target <= source.to)) return
  const tr = closeHistory(view.state.tr).deleteRange(source.from, source.to)
  if (!tr.docChanged) return
  const pos = tr.mapping.map(target)
  const $pos = tr.doc.resolve(pos)
  if (!$pos.parent.canReplaceWith($pos.index(), $pos.index(), source.node.type, source.node.marks)) return
  tr.insert(pos, source.node)
  if (tr.doc.eq(view.state.doc)) return
  view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)).setMeta('uiEvent', 'drop'))
  view.focus()
}
