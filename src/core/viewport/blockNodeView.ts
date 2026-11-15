import type { Node } from '@tiptap/pm/model'
import { DOMSerializer } from '@tiptap/pm/model'
import type { EditorView, NodeView } from '@tiptap/pm/view'
import { TOP_LEVEL_BLOCK_TYPES } from '../schema'
import { estimateHeight, type HeightCache } from './heights'
import { isBlockVisible } from './visibility'

export interface ViewportObserver {
  observe(el: Element): void
  unobserve(el: Element): void
  disconnect(): void
}

type BlockNodeViewFactory = (
  node: Node, view: EditorView, getPos: () => number | undefined,
) => NodeView

interface BlockContent {
  dom: HTMLElement
  contentDOM?: HTMLElement
  updateContent?: (node: Node) => void
  destroy?: () => void
  stopEvent?: NodeView['stopEvent']
}

export type PresentBlock = (node: Node, rendered: BlockContent) => BlockContent

function renderContent(node: Node, document: Document, present?: PresentBlock): BlockContent {
  const spec = DOMSerializer.renderSpec(document, node.type.spec.toDOM!(node))
  const rendered = { dom: spec.dom, contentDOM: spec.contentDOM ?? undefined }
  return present?.(node, rendered) ?? rendered
}

export function createBlockNodeView(
  node: Node,
  view: EditorView,
  getPos: () => number | undefined,
  heights: HeightCache,
  getObserver: () => ViewportObserver | null,
  present?: PresentBlock,
): NodeView {
  let current = node
  const pos = getPos()

  // PM 的 nodeViews 按【类型名】注册，对所有深度生效：listItem / blockquote 里的
  // 段落同样会进这个工厂。它们的 pos 不是顶层位置，isBlockVisible 必然 false，
  // 若走占位分支就会把列表项与引用的内容整段销毁。非顶层一律正常渲染、不参与虚拟化。
  const topLevel = pos !== undefined && view.state.doc.resolve(pos).depth === 0
  if (!topLevel) {
    const nested = renderContent(node, document, present)
    return {
      dom: nested.dom,
      contentDOM: nested.contentDOM,
      stopEvent: nested.stopEvent,
      destroy: nested.destroy,
      ignoreMutation(mutation) {
        return mutation.type !== 'selection' && (!nested.contentDOM || !nested.contentDOM.contains(mutation.target))
      },
      update(next) {
        if (!next.sameMarkup(current)) return false
        current = next
        nested.updateContent?.(next)
        return true
      },
    }
  }

  const visible = isBlockVisible(view.state, pos)

  const dom = document.createElement('div')
  dom.className = 'onebox-block'
  dom.dataset.visible = visible ? 'true' : 'false'

  let rendered: BlockContent | undefined
  let resizeObserver: ResizeObserver | undefined

  const placeholderHeight = (block: Node) => {
    const cached = heights.get(block)
    return cached && cached > 0 ? cached : estimateHeight(block)
  }

  if (visible) {
    // Read the semantic DOM from the schema before adding any editor chrome.
    rendered = renderContent(node, dom.ownerDocument, present)
    rendered.dom.classList.add('onebox-block-content')
    dom.appendChild(rendered.dom)
    resizeObserver = new ResizeObserver(() => {
      // 外壳必须是 BFC（Task 9 的 display: flow-root）：否则子元素的 margin 折叠到
      // 外壳之外，offsetHeight 小于实际占据高度，每个占位块都系统性偏矮。
      const h = dom.offsetHeight
      // 挂载在 display:none 祖先下时 offsetHeight 为 0，缓存 0 会让占位塌成 0px
      if (h > 0) heights.set(current, h)
    })
    resizeObserver.observe(dom)
  } else {
    dom.style.height = `${placeholderHeight(current)}px`
  }

  getObserver()?.observe(dom)
  const contentDOM = rendered?.contentDOM

  return {
    dom,
    contentDOM,
    stopEvent: rendered?.stopEvent,
    update(nextNode) {
      const p = getPos()
      const nextVisible = p !== undefined && isBlockVisible(view.state, p)
      if (nextVisible !== visible) return false
      // toDOM 的产物带 attrs（h2 的级别、code 的 language-*）。PM 不会重新应用
      // toDOM，markup 变了必须返回 false 让它重建，否则级别 2→3 仍留在 <h2>。
      if (!nextNode.sameMarkup(current)) return false
      if (visible && current !== nextNode) {
        const height = heights.get(current)
        if (height !== undefined) heights.set(nextNode, height)
      }
      current = nextNode
      rendered?.updateContent?.(nextNode)
      // 隐藏块的内容也会被 transaction 改到（撤销、跨块替换），占位高度须跟着重算
      if (!visible) dom.style.height = `${placeholderHeight(current)}px`
      return true
    },
    destroy() {
      resizeObserver?.disconnect()
      rendered?.destroy?.()
      // 必须重新取，不能用构造时捕获的实例：Task 9 先建 EditorView 再建 observer，
      // 首批 nodeView 构造时 getObserver() 是 null，由 createEditor 补挂。用捕获的
      // null 注销就永远注销不掉，states 与 IO 会随翻转累积脱离文档的元素。
      getObserver()?.unobserve(dom)
    },
    ignoreMutation(mutation) {
      // PM 自己的默认实现从不忽略 selection mutation（view dist:1125）。吞掉它
      // 会让 PM 不再从 DOM 回读选区。ViewMutationRecord 的联合类型里含 'selection'。
      return mutation.type !== 'selection' && (!contentDOM || !contentDOM.contains(mutation.target))
    },
  }
}

export function blockNodeViews(
  heights: HeightCache,
  getObserver: () => ViewportObserver | null,
  present?: PresentBlock,
): Record<string, BlockNodeViewFactory> {
  const out: Record<string, BlockNodeViewFactory> = {}
  for (const name of TOP_LEVEL_BLOCK_TYPES) {
    out[name] = (node, view, getPos) => createBlockNodeView(node, view, getPos, heights, getObserver, present)
  }
  return out
}
