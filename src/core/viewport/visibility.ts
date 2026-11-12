import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node } from '@tiptap/pm/model'

export interface VisibilityState {
  visible: ReadonlySet<number>
}

export const visibilityKey = new PluginKey<VisibilityState>('onebox-visibility')

export function forcedVisiblePositions(state: EditorState): Set<number> {
  const forced = new Set<number>()
  for (const pos of [state.selection.from, state.selection.to]) {
    const $pos = state.doc.resolve(pos)
    forced.add($pos.depth === 0 ? pos : $pos.before(1))
  }
  return forced
}

export function isBlockVisible(state: EditorState, pos: number): boolean {
  if (visibilityKey.getState(state)?.visible.has(pos)) return true
  return forcedVisiblePositions(state).has(pos)
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
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
        return meta ? { visible: meta.visible } : value
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
          // 第 4 个参数才是 Decoration.spec 的返回值；attrs 无法从公开 API 读回
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
