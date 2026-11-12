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

export function createBlockNodeView(
  node: Node,
  view: EditorView,
  getPos: () => number | undefined,
  heights: HeightCache,
  getObserver: () => ViewportObserver | null,
): NodeView {
  let current = node
  const pos = getPos()

  // PM 的 nodeViews 按【类型名】注册，对所有深度生效：listItem / blockquote 里的
  // 段落同样会进这个工厂。它们的 pos 不是顶层位置，isBlockVisible 必然 false，
  // 若走占位分支就会把列表项与引用的内容整段销毁。非顶层一律正常渲染、不参与虚拟化。
  const topLevel = pos !== undefined && view.state.doc.resolve(pos).depth === 0
  if (!topLevel) {
    const nested = DOMSerializer.renderSpec(document, node.type.spec.toDOM!(node))
    return {
      dom: nested.dom,
      contentDOM: nested.contentDOM ?? undefined,
      update(next) {
        if (!next.sameMarkup(current)) return false
        current = next
        return true
      },
    }
  }

  const visible = isBlockVisible(view.state, pos)

  const dom = document.createElement('div')
  dom.className = 'onebox-block'
  dom.dataset.visible = visible ? 'true' : 'false'

  let contentDOM: HTMLElement | undefined
  let resizeObserver: ResizeObserver | undefined

  if (visible) {
    // 用节点自身的 toDOM 渲染，保留 h1/pre>code/ul/ol/hr 语义。
    // 恒用 div 会丢掉标题与列表语义，而 nodeView 拥有 DOM，后续 CSS 无法补救。
    // NodeSpec.toDOM 在 d.ts 上是可选的（TS2722），但七个 TOP_LEVEL_BLOCK_TYPES 全都定义了它，
    // 且 renderSpec 对它们恒返回元素 dom、contentDOM 为元素或 undefined（已实测）。
    const rendered = DOMSerializer.renderSpec(document, node.type.spec.toDOM!(node))
    rendered.dom.classList.add('onebox-block-content')
    dom.appendChild(rendered.dom)
    // horizontalRule 是 leaf，renderSpec 不返回 contentDOM，这是正确行为
    contentDOM = rendered.contentDOM ?? undefined
    resizeObserver = new ResizeObserver(() => {
      const h = dom.offsetHeight
      // 挂载在 display:none 祖先下时 offsetHeight 为 0，缓存 0 会让占位塌成 0px
      if (h > 0) heights.set(current, h)
    })
    resizeObserver.observe(dom)
  } else {
    const cached = heights.get(current)
    dom.style.height = `${cached && cached > 0 ? cached : estimateHeight(current)}px`
  }

  getObserver()?.observe(dom)

  return {
    dom,
    contentDOM,
    update(nextNode) {
      const p = getPos()
      const nextVisible = p !== undefined && isBlockVisible(view.state, p)
      if (nextVisible !== visible) return false
      // toDOM 的产物带 attrs（h2 的级别、code 的 language-*）。PM 不会重新应用
      // toDOM，markup 变了必须返回 false 让它重建，否则级别 2→3 仍留在 <h2>。
      if (!nextNode.sameMarkup(current)) return false
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
