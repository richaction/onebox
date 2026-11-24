import type { Node, ResolvedPos } from '@tiptap/pm/model'
import { Plugin, PluginKey, Selection, TextSelection, type EditorState } from '@tiptap/pm/state'
import type { Mappable } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { isBlockVisible, visibilityKey } from './viewport/visibility'

export class ListRowsSelection extends Selection {
  visible = false

  private constructor(readonly first: ResolvedPos, readonly last: ResolvedPos) {
    super(first, last.doc.resolve(last.pos + last.nodeAfter!.nodeSize))
  }

  static between(first: ResolvedPos, last: ResolvedPos): ListRowsSelection | undefined {
    if (first.pos > last.pos) return this.between(last, first)
    if (first.sameParent(last) && first.nodeAfter?.type.name === 'listItem' &&
      last.nodeAfter?.type.name === 'listItem') return new ListRowsSelection(first, last)
  }

  map(doc: Node, mapping: Mappable): Selection {
    const first = doc.resolve(mapping.map(this.first.pos, 1))
    const last = doc.resolve(mapping.map(this.last.pos, 1))
    return ListRowsSelection.between(first, last) ?? Selection.near(first)
  }

  eq(other: Selection) {
    return other instanceof ListRowsSelection && this.from === other.from && this.to === other.to
  }

  toJSON() { return { type: 'oneboxListRows', first: this.first.pos, last: this.last.pos } }

  static fromJSON(doc: Node, json: { first: number; last: number }) {
    const first = doc.resolve(json.first)
    return ListRowsSelection.between(first, doc.resolve(json.last)) ?? Selection.near(first)
  }
}
Selection.jsonID('oneboxListRows', ListRowsSelection)
const listSelectionKey = new PluginKey<{ rows: DecorationSet; textOnly: boolean }>('onebox-list-selection')

function crossesList(state: EditorState) {
  const { doc, selection } = state
  if (!(selection instanceof TextSelection) || selection.empty) return false
  let found = false
  doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.type.name === 'listItem') found = true
    return !found && !node.isTextblock
  })
  return found
}

function textRanges(view: EditorView) {
  const { doc, selection } = view.state
  const { from, to } = selection
  const ranges: Range[] = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'viewportGroup') return isBlockVisible(view.state, pos)
    if (!node.isText) return !node.isAtom
    const start = view.domAtPos(Math.max(from, pos), 1)
    const end = view.domAtPos(Math.min(to, pos + node.nodeSize), -1)
    if (!(start.node instanceof Text) || !(end.node instanceof Text)) return false
    const dom = view.dom.ownerDocument
    const add = (text: Text, a: number, b: number) => {
      if (a >= b) return
      const fragment = dom.createRange()
      fragment.setStart(text, a)
      fragment.setEnd(text, b)
      ranges.push(fragment)
    }
    if (start.node === end.node) add(start.node, start.offset, end.offset)
    else {
      // A widget or mark decoration can split one model text run in the DOM.
      add(start.node, start.offset, start.node.length)
      const walker = dom.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT, {
        acceptNode(text) {
          const wrapper = text.parentElement?.closest('[contenteditable="false"]')
          return !wrapper || wrapper === view.dom ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
        },
      })
      walker.currentNode = start.node
      for (let next = walker.nextNode(); next && next !== end.node; next = walker.nextNode()) {
        add(next as Text, 0, (next as Text).length)
      }
      add(end.node, 0, end.offset)
    }
    return false
  })
  return ranges
}

export function listTextSelectionRects(view: EditorView) {
  if (listSelectionKey.getState(view.state)?.textOnly) {
    return textRanges(view).flatMap((range) => Array.from(range.getClientRects()))
  }
}

function rectPainter(view: EditorView, scrollRoot: HTMLElement) {
  const doc = view.dom.ownerDocument
  const layer = doc.createElement('div')
  layer.className = 'editor-list-selection-layer'
  layer.setAttribute('aria-hidden', 'true')
  scrollRoot.append(layer)
  let ranges: readonly Range[] = []
  let frame = 0
  const paint = () => {
    const fragments = doc.createDocumentFragment()
    if (ranges.length) {
      const bounds = scrollRoot.getBoundingClientRect()
      const rightEdge = bounds.left + scrollRoot.clientWidth
      const bottomEdge = bounds.top + scrollRoot.clientHeight
      for (const range of ranges) {
        for (const rect of range.getClientRects()) {
          const left = Math.max(bounds.left, rect.left)
          const top = Math.max(bounds.top, rect.top)
          const width = Math.min(rightEdge, rect.right) - left
          const height = Math.min(bottomEdge, rect.bottom) - top
          if (width <= 0 || height <= 0) continue
          const fragment = doc.createElement('span')
          Object.assign(fragment.style, {
            left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
          })
          fragments.append(fragment)
        }
      }
    }
    layer.replaceChildren(fragments)
  }
  const schedule = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(paint)
  }
  const resize = new ResizeObserver(schedule)
  resize.observe(scrollRoot)
  scrollRoot.addEventListener('scroll', schedule, true)
  return {
    update(next: readonly Range[]) {
      ranges = next
      if (ranges.length) schedule()
      else { cancelAnimationFrame(frame); layer.replaceChildren() }
    },
    destroy() {
      cancelAnimationFrame(frame)
      resize.disconnect()
      scrollRoot.removeEventListener('scroll', schedule, true)
      layer.remove()
    },
  }
}

export function listSelectionPlugin(scrollRoot: HTMLElement) {
  return new Plugin<{ rows: DecorationSet; textOnly: boolean }>({
    key: listSelectionKey,
    state: {
      init: (_, state) => ({ rows: DecorationSet.empty, textOnly: crossesList(state) }),
      apply(tr, previous, _old, state) {
        if (!tr.docChanged && !tr.selectionSet) return previous
        const { doc, selection } = tr
        if (!(selection instanceof ListRowsSelection)) {
          return { rows: DecorationSet.empty, textOnly: crossesList(state) }
        }
        const parent = selection.first.parent
        const decorations: Decoration[] = []
        let pos = selection.from
        const first = selection.first.index()
        const last = selection.last.index()
        for (let i = first; i <= last; i++) {
          const end = pos + parent.child(i).nodeSize
          const edge = first === last ? 'single' : i === first ? 'start' : i === last ? 'end' : 'middle'
          decorations.push(Decoration.node(pos, end, { 'data-list-row-selected': edge }))
          pos = end
        }
        return { rows: DecorationSet.create(doc, decorations), textOnly: false }
      },
    },
    props: {
      decorations(state) { return listSelectionKey.getState(state)?.rows },
      attributes(state): Record<string, string> {
        return listSelectionKey.getState(state)?.textOnly ? { 'data-list-text-highlights': 'true' } : {}
      },
    },
    view(view) {
      const key = 'onebox-list-text'
      const registry = typeof Highlight !== 'undefined' ? globalThis.CSS?.highlights : undefined
      let painted: Highlight | undefined
      let fallback: ReturnType<typeof rectPainter> | undefined
      const update = () => {
        if (painted && registry?.get(key) === painted) registry.delete(key)
        painted = undefined
        if (!listSelectionKey.getState(view.state)?.textOnly) { fallback?.update([]); return }
        const ranges = textRanges(view)
        if (registry && ranges.length) {
          painted = new Highlight()
          for (const range of ranges) painted.add(range)
          registry.set(key, painted)
        }
        if (!registry) (fallback ??= rectPainter(view, scrollRoot)).update(ranges)
      }
      update()
      return {
        update(view, previous) {
          const { doc, selection } = view.state
          if (doc === previous.doc && selection.eq(previous.selection) &&
            visibilityKey.getState(view.state) === visibilityKey.getState(previous)) return
          update()
        },
        destroy() {
          if (painted && registry?.get(key) === painted) registry.delete(key)
          fallback?.destroy()
        },
      }
    },
  })
}
