import type { Node, ResolvedPos } from '@tiptap/pm/model'
import { NodeSelection, Plugin, Selection, type SelectionBookmark } from '@tiptap/pm/state'
import type { Mappable } from '@tiptap/pm/transform'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { ListRowsSelection } from './listSelection'

const isGroup = (node: Node) => node.type.name === 'viewportGroup'

function documentBlock($pos: ResolvedPos) {
  const depth = $pos.depth > 0 && isGroup($pos.node(1)) ? 1 : 0
  return $pos.doc.resolve($pos.posAtIndex($pos.index(depth), depth))
}

function isDocumentBlockStart($pos: ResolvedPos) {
  return ($pos.depth === 0 || ($pos.depth === 1 && isGroup($pos.parent))) &&
    $pos.nodeAfter && !isGroup($pos.nodeAfter) && NodeSelection.isSelectable($pos.nodeAfter)
}

export class BlockRangeSelection extends Selection {
  visible = false

  private constructor(readonly first: ResolvedPos, readonly last: ResolvedPos) {
    super(first, last.doc.resolve(last.pos + last.nodeAfter!.nodeSize))
  }

  static between(first: ResolvedPos, last: ResolvedPos): Selection | undefined {
    if (first.pos > last.pos) return this.between(last, first)
    if (!isDocumentBlockStart(first) || !isDocumentBlockStart(last)) return
    return first.pos === last.pos ? new NodeSelection(first) : new BlockRangeSelection(first, last)
  }

  map(doc: Node, mapping: Mappable) {
    return this.getBookmark().map(mapping).resolve(doc)
  }

  eq(other: Selection) {
    return other instanceof BlockRangeSelection && this.from === other.from && this.to === other.to
  }

  getBookmark() { return new BlockRangeBookmark(this.first.pos, this.last.pos) }

  toJSON() { return { type: 'oneboxBlockRange', first: this.first.pos, last: this.last.pos } }

  static fromJSON(doc: Node, json: { first: number; last: number }) {
    return new BlockRangeBookmark(json.first, json.last).resolve(doc)
  }
}

class BlockRangeBookmark implements SelectionBookmark {
  constructor(readonly first: number, readonly last: number) {}

  map(mapping: Mappable) {
    return new BlockRangeBookmark(mapping.map(this.first, 1), mapping.map(this.last, 1))
  }

  resolve(doc: Node) {
    const first = doc.resolve(this.first)
    return BlockRangeSelection.between(first, doc.resolve(this.last)) ?? Selection.near(first)
  }
}

Selection.jsonID('oneboxBlockRange', BlockRangeSelection)

export function extendBlockSelection(anchor: NodeSelection, target: NodeSelection) {
  if (anchor.from === target.from) return anchor
  return ListRowsSelection.between(anchor.$from, target.$from)
    ?? BlockRangeSelection.between(documentBlock(anchor.$from), documentBlock(target.$from))
}

export function isBlockSelection(selection: Selection) {
  return selection instanceof BlockRangeSelection || selection instanceof ListRowsSelection ||
    (selection instanceof NodeSelection && selection.node.isBlock)
}

export function blockRangeSelectionPlugin() {
  let cache: { selection: BlockRangeSelection; decorations: DecorationSet } | undefined
  return new Plugin({
    props: {
      attributes(state): Record<string, string> {
        return isBlockSelection(state.selection) ? { 'data-block-selection': '' } : {}
      },
      decorations({ doc, selection }) {
        if (!(selection instanceof BlockRangeSelection)) return null
        if (cache?.selection === selection) return cache.decorations
        const blocks: Decoration[] = []
        doc.nodesBetween(selection.from, selection.to, (node, pos) => {
          if (isGroup(node)) return true
          blocks.push(Decoration.node(pos, pos + node.nodeSize, { 'data-block-range-selected': '' }))
          return false
        })
        const decorations = DecorationSet.create(doc, blocks)
        cache = { selection, decorations }
        return decorations
      },
    },
  })
}
