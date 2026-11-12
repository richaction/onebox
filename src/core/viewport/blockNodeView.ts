import type { Node } from '@tiptap/pm/model'
import type { EditorView, NodeView } from '@tiptap/pm/view'
import { TOP_LEVEL_BLOCK_TYPES } from '../schema'
import { estimateHeight, type HeightCache } from './heights'
import { isBlockVisible } from './visibility'

export interface ViewportObserver {
  observe(el: Element): void
  unobserve(el: Element): void
  disconnect(): void
}

export function createBlockNodeView(
  node: Node,
  view: EditorView,
  getPos: () => number | undefined,
  heights: HeightCache,
  getObserver: () => ViewportObserver | null,
): NodeView {
  let current = node
  const pos = getPos()
  const visible = pos !== undefined && isBlockVisible(view.state, pos)

  const dom = document.createElement('div')
  dom.className = 'onebox-block'
  dom.dataset.visible = visible ? 'true' : 'false'

  let contentDOM: HTMLElement | undefined
  let resizeObserver: ResizeObserver | undefined

  if (visible) {
    contentDOM = document.createElement('div')
    contentDOM.className = 'onebox-block-content'
    dom.appendChild(contentDOM)
    resizeObserver = new ResizeObserver(() => {
      heights.set(current, dom.offsetHeight)
    })
    resizeObserver.observe(dom)
  } else {
    dom.style.height = `${heights.get(current) ?? estimateHeight(current)}px`
  }

  getObserver()?.observe(dom)

  return {
    dom,
    contentDOM,
    update(nextNode) {
      const p = getPos()
      const nextVisible = p !== undefined && isBlockVisible(view.state, p)
      if (nextVisible !== visible) return false
      current = nextNode
      return true
    },
    destroy() {
      resizeObserver?.disconnect()
      getObserver()?.unobserve(dom)
    },
    ignoreMutation(mutation) {
      return !contentDOM || !contentDOM.contains(mutation.target)
    },
  }
}

export function blockNodeViews(
  heights: HeightCache,
  getObserver: () => ViewportObserver | null,
): Record<string, (node: Node, view: EditorView, getPos: () => number | undefined) => NodeView> {
  const out: Record<
    string,
    (node: Node, view: EditorView, getPos: () => number | undefined) => NodeView
  > = {}
  for (const name of TOP_LEVEL_BLOCK_TYPES) {
    out[name] = (node, view, getPos) => createBlockNodeView(node, view, getPos, heights, getObserver)
  }
  return out
}
