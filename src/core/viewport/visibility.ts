import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node } from '@tiptap/pm/model'

export interface VisibilityState {
  visible: ReadonlySet<number>
}

export const visibilityKey = new PluginKey<VisibilityState>('onebox-visibility')

export function forcedVisiblePositions(state: EditorState): Set<number> {
  const forced = new Set<number>()
  const { from, to } = state.selection
  // 范围选区必须覆盖途经的每一个顶层块，只取两端会漏掉中间块；
  // AllSelection（Cmd+A）的 from=0 / to=content.size 更是只命中首块。
  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (parent === state.doc) forced.add(pos)
  })
  // 折叠选区或端点落在块边界时 nodesBetween 可能不回调，补上两端解析结果
  for (const pos of [from, to]) {
    const $pos = state.doc.resolve(pos)
    forced.add($pos.depth === 0 ? pos : $pos.before(1))
  }
  return forced
}

export function isBlockVisible(state: EditorState, pos: number): boolean {
  if (visibilityKey.getState(state)?.visible.has(pos)) return true
  const { from, to } = state.selection
  // 折叠选区是输入与滚动时的绝对多数情况，走无分配快路径：
  // 2 万块初次渲染会调用本函数 2 万次，每次都建 Set + 两次 resolve 开销显著
  if (from === to) {
    const $pos = state.doc.resolve(from)
    return pos === ($pos.depth === 0 ? from : $pos.before(1))
  }
  return forcedVisiblePositions(state).has(pos)
}

export function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

export function createVisibilityPlugin(): Plugin<VisibilityState> {
  let cache: {
    doc: Node
    visible: ReadonlySet<number>
    forced: ReadonlySet<number>
    deco: DecorationSet
  } | null = null

  return new Plugin<VisibilityState>({
    key: visibilityKey,
    state: {
      init: () => ({ visible: new Set<number>() }),
      apply(tr, value) {
        const meta = tr.getMeta(visibilityKey) as { visible: ReadonlySet<number> } | undefined
        if (meta) return { visible: meta.visible }
        if (!tr.docChanged) return value
        // 文档变更会移动其后所有顶层块的起始位置。不映射就会让下方每个块
        // 的可见性判定失效、被打成占位——每次敲键都触发一轮销毁重建。
        //
        // 不能用 mapResult 的 deleted 判断块是否消失：setNodeMarkup 产生
        // ReplaceAroundStep，assoc=1 时本块起点被判 deleted、assoc=-1 时下一块
        // 起点被判 deleted，两种都会误踢在屏块。deleted 表达的是位置映射语义，
        // 不是块的存在性。改为 map 取新位置，再按新文档真实的顶层块起点过滤。
        const mapped = new Set<number>()
        for (const pos of value.visible) mapped.add(tr.mapping.map(pos))
        const kept = new Set<number>()
        tr.doc.forEach((_node, pos) => {
          if (mapped.has(pos)) kept.add(pos)
        })
        return { visible: kept }
      },
    },
    props: {
      decorations(state) {
        const visible = visibilityKey.getState(state)!.visible
        const forced = forcedVisiblePositions(state)
        if (
          cache &&
          cache.doc === state.doc &&
          sameSet(cache.visible, visible) &&
          sameSet(cache.forced, forced)
        ) {
          return cache.deco
        }
        const decos: Decoration[] = []
        state.doc.forEach((node, pos) => {
          const on = visible.has(pos) || forced.has(pos)
          // 第 4 个参数才是 Decoration.spec 的返回值；attrs 不在公开 d.ts 上（运行时挂在 type 上）
          decos.push(
            Decoration.node(
              pos,
              pos + node.nodeSize,
              { 'data-visible': on ? 'true' : 'false' },
              { visible: on },
            ),
          )
        })
        const deco = DecorationSet.create(state.doc, decos)
        cache = { doc: state.doc, visible, forced, deco }
        return deco
      },
    },
  })
}
