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
  let prev: ReadonlySet<number> = new Set()
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
    const changed = nextVisibleSet(prev, next)
    if (!changed) return
    prev = changed
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
