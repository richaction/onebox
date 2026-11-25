import type { EditorView } from '@tiptap/pm/view'
import type { ViewportMetrics } from '../metrics'
import type { ViewportObserver } from './blockNodeView'
import { sameSet, visibilityKey } from './visibility'

const compactBlockLimit = 64
const compactContentLimit = 32_768

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
  { rootMargin = 200, metrics, mountCompactDocuments = true }:
    { rootMargin?: number; metrics?: ViewportMetrics; mountCompactDocuments?: boolean } = {},
): ViewportObserver {
  const blocks = view.dom.getElementsByClassName('onebox-block')
  let raf = 0
  let disconnected = false
  const schedule = () => {
    if (!disconnected && !raf) raf = requestAnimationFrame(flush)
  }
  const isCompact = () => {
    const { doc } = view.state
    return mountCompactDocuments && doc.childCount <= compactBlockLimit && doc.content.size <= compactContentLimit
      && doc.firstChild?.type.name !== 'viewportGroup'
  }
  const onScroll = () => {
    if (!isCompact() || visibilityKey.getState(view.state)?.visible.size !== view.state.doc.childCount) schedule()
  }

  const flush = () => {
    raf = 0
    // IME 组合中销毁块会丢字：推迟到 composition 结束
    if (view.composing) {
      schedule()
      return
    }
    if (!root.isConnected) return
    const next = new Set<number>()
    if (isCompact()) {
      // An unloaded image temporarily loses its intrinsic height. Keep small
      // documents mounted so turning around mid-scroll can reuse their layout.
      view.state.doc.forEach((_node, pos) => { next.add(pos) })
    } else {
      const viewport = root.getBoundingClientRect()
      const top = viewport.top - rootMargin
      const bottom = viewport.bottom + rootMargin
      // Search live block order without observing each placeholder.
      let first = 0
      let end = blocks.length
      while (first < end) {
        const middle = (first + end) >>> 1
        if (blocks[middle].getBoundingClientRect().bottom < top) first = middle + 1
        else end = middle
      }
      for (let index = first; index < blocks.length; index++) {
        const block = blocks[index]
        if (block.getBoundingClientRect().top > bottom) break
        next.add(blockPosOf(view, block))
      }
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
    const transaction = view.state.tr.setMeta(visibilityKey, { visible: changed })
    const start = metrics ? performance.now() : 0
    view.dispatch(transaction)
    if (metrics) {
      const elapsed = performance.now() - start
      metrics.transactions++
      metrics.lastTransactionMs = elapsed
      metrics.maxTransactionMs = Math.max(metrics.maxTransactionMs, elapsed)
    }
  }

  const resize = new ResizeObserver(schedule)
  resize.observe(root)
  resize.observe(view.dom)
  root.addEventListener('scroll', onScroll, { passive: true })

  return {
    observe() {
      if (metrics) metrics.created++
      schedule()
    },
    unobserve() {
      if (metrics) metrics.destroyed++
      schedule()
    },
    disconnect() {
      disconnected = true
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      resize.disconnect()
      root.removeEventListener('scroll', onScroll)
    },
  }
}
