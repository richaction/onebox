import type { EditorView } from '@tiptap/pm/view'
import type { ViewportObserver } from './blockNodeView'
import { sameSet, visibilityKey } from './visibility'

export function nextVisibleSet(
  prev: ReadonlySet<number>,
  next: ReadonlySet<number>,
): ReadonlySet<number> | null {
  return sameSet(prev, next) ? null : next
}

export function blockPosOf(view: EditorView, el: Element): number {
  const pos = view.posAtDOM(el, 0)
  const $pos = view.state.doc.resolve(pos)
  return $pos.depth === 0 ? pos : $pos.before(1)
}

export function createViewportObserver(
  view: EditorView,
  root: HTMLElement,
  rootMargin = '200px',
): ViewportObserver {
  const states = new Map<Element, boolean>()
  let raf = 0

  const flush = () => {
    raf = 0
    // IME 组合中销毁块会丢字：推迟到 composition 结束
    if (view.composing) {
      raf = requestAnimationFrame(flush)
      return
    }
    const next = new Set<number>()
    for (const [el, intersecting] of states) {
      if (!intersecting || !el.isConnected) continue
      next.add(blockPosOf(view, el))
    }
    // 与 plugin 的【权威】可见集比较，不自存一份 prev。plugin 会在每个 docChanged
    // transaction 里自行 map+filter，私有副本必然与它漂移：一旦 DOM 算出的 next
    // 恰好等于过期副本，就永远不再派发纠正事务，屏上块永久停在占位态。
    // 读权威集同时省掉「位置平移后 plugin 已映射正确、却因 next != prev 再派发
    // 一次全量 updateState」的冗余开销。setMeta 事务的 apply 原样返回 meta.visible，
    // 故派发后 plugin 状态恒等于 next，不会自激循环。
    const current = visibilityKey.getState(view.state)?.visible ?? new Set<number>()
    const changed = nextVisibleSet(current, next)
    if (!changed) return
    view.dispatch(view.state.tr.setMeta(visibilityKey, { visible: changed }))
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) states.set(entry.target, entry.isIntersecting)
      if (!raf) raf = requestAnimationFrame(flush)
    },
    { root, rootMargin },
  )

  return {
    observe(el) {
      states.set(el, false)
      io.observe(el)
    },
    unobserve(el) {
      states.delete(el)
      io.unobserve(el)
    },
    disconnect() {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      io.disconnect()
      states.clear()
    },
  }
}
