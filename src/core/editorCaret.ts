import { closeHistory } from '@tiptap/pm/history'
import { Plugin, PluginKey, Selection, TextSelection, type EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

export function isDisplayMath(node: import('@tiptap/pm/model').Node) {
  return node.type.name === 'paragraph' && node.childCount === 1
    && node.firstChild?.type.name === 'math' && node.firstChild.attrs.display
}

const emptyContinuation = new PluginKey<number | null>('onebox-empty-continuation')

function removeEmptyContinuation(state: EditorState) {
  const pos = emptyContinuation.getState(state)
  if (pos == null) return
  const paragraph = state.doc.nodeAt(pos)!
  return state.tr.delete(pos, pos + paragraph.nodeSize)
    .setMeta(emptyContinuation, null).setMeta('addToHistory', false).setMeta('preventUpdate', true)
}

export function closeEmptyContinuation(view: EditorView) {
  const cleanup = removeEmptyContinuation(view.state)
  if (cleanup) view.dispatch(cleanup)
}

export function documentWithoutEmptyContinuation(state: EditorState) {
  return removeEmptyContinuation(state)?.doc ?? state.doc
}

export function emptyContinuationPlugin() {
  return new Plugin<number | null>({
    key: emptyContinuation,
    state: {
      init: () => null,
      apply(tr, previous) {
        const opened = tr.getMeta(emptyContinuation) as number | null | undefined
        if (opened !== undefined) return opened
        if (previous === null || !tr.docChanged) return previous
        const mapped = tr.mapping.mapResult(previous)
        const paragraph = mapped.deleted ? null : tr.doc.nodeAt(mapped.pos)
        return paragraph?.type === tr.doc.type.schema.nodes.paragraph && !paragraph.content.size
          ? mapped.pos : null
      },
    },
    appendTransaction(_transactions, _oldState, state) {
      const pos = emptyContinuation.getState(state)
      const { from, to } = state.selection
      if (pos != null && (from !== pos + 1 || to !== pos + 1)) return removeEmptyContinuation(state)
    },
    props: {
      handleDOMEvents: {
        blur(view) {
          // Let the click reach its target before closing the line changes the layout.
          if (emptyContinuation.getState(view.state) != null) queueMicrotask(() => {
            if (!view.isDestroyed && !view.hasFocus() && !view.composing) closeEmptyContinuation(view)
          })
          return false
        },
      },
    },
  })
}

export function continueAfterBlock(view: EditorView, pos: number) {
  const { doc, schema, tr } = view.state
  const block = doc.nodeAt(pos)
  if (!view.editable || view.composing || !block || (block.type.name !== 'codeBlock' && !isDisplayMath(block))) return false

  const end = pos + block.nodeSize
  const after = doc.resolve(end)
  const paragraph = schema.nodes.paragraph
  const isTextParagraph = (next: typeof after.nodeAfter) => next?.type === paragraph && !isDisplayMath(next)
  let caret = isTextParagraph(after.nodeAfter) ? end + 1 : undefined
  if (!after.nodeAfter && after.parent.type.name === 'viewportGroup') {
    const boundary = after.after()
    const next = doc.resolve(boundary).nodeAfter
    if (isTextParagraph(next)) caret = boundary + 1
    else if (next?.type.name === 'viewportGroup' && isTextParagraph(next.firstChild)) caret = boundary + 2
  }
  if (caret === undefined) {
    if (!after.parent.canReplaceWith(after.index(), after.index(), paragraph)) return false
    // Switching gaps replaces the previous unused paragraph in the same transaction.
    const cleanup = removeEmptyContinuation(view.state)
    if (cleanup) for (const step of cleanup.steps) tr.step(step)
    const insert = tr.mapping.map(end)
    closeHistory(tr).insert(insert, paragraph.create())
      .setMeta(emptyContinuation, insert).setMeta('addToHistory', false).setMeta('preventUpdate', true)
    caret = insert + 1
  }
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView())
  view.focus()
  return true
}

function headingEndInWhitespace(view: EditorView, event: MouseEvent) {
  const heading = (event.target as Element | null)?.closest?.('h1, h2, h3, h4, h5, h6')
  if (!heading || !view.dom.contains(heading)) return
  const end = view.posAtDOM(heading, heading.childNodes.length)
  const caret = view.coordsAtPos(end, -1)
  const rtl = getComputedStyle(heading).direction === 'rtl'
  if (caret.top <= event.clientY && event.clientY <= caret.bottom &&
    (rtl ? event.clientX < caret.left : event.clientX > caret.right)) return end
}

export function isGutterPress(view: EditorView, event: MouseEvent, scrollRoot: HTMLElement) {
  if (!view.editable || view.composing || event.defaultPrevented || event.button !== 0 ||
    event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
  const target = event.target
  return target instanceof HTMLElement &&
    (target === scrollRoot || target === view.dom.parentElement || target === view.dom ||
      target.matches('.onebox-block, .viewport-group') || headingEndInWhitespace(view, event) !== undefined)
}

export function placeCaretInGutter(view: EditorView, event: MouseEvent, scrollRoot: HTMLElement) {
  if (!isGutterPress(view, event, scrollRoot)) return false
  const bounds = view.dom.getBoundingClientRect()
  const { doc } = view.state
  const headingEnd = headingEndInWhitespace(view, event)
  if (headingEnd !== undefined) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, headingEnd)))
  } else if (event.clientY >= bounds.bottom) {
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
