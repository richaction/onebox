import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Node } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { EditorView } from '@tiptap/pm/view'
import { schema } from '../src/core/schema'
import { HeightCache } from '../src/core/viewport/heights'
import { blockNodeViews, type ViewportObserver } from '../src/core/viewport/blockNodeView'
import { createVisibilityPlugin, visibilityKey } from '../src/core/viewport/visibility'
import { blockPosOf, createViewportObserver, nextVisibleSet } from '../src/core/viewport/observer'

describe('nextVisibleSet', () => {
  it('returns null for identical sets', () => {
    expect(nextVisibleSet(new Set([0, 5]), new Set([5, 0]))).toBeNull()
  })

  it('returns null for two empty sets', () => {
    expect(nextVisibleSet(new Set(), new Set())).toBeNull()
  })

  it('returns the new set when a block enters', () => {
    const next = new Set([0, 5, 10])
    expect(nextVisibleSet(new Set([0, 5]), next)).toBe(next)
  })

  it('returns the new set when a block leaves', () => {
    const next = new Set([0])
    expect(nextVisibleSet(new Set([0, 5]), next)).toBe(next)
  })

  it('returns the new set when size matches but members differ', () => {
    const next = new Set([0, 10])
    expect(nextVisibleSet(new Set([0, 5]), next)).toBe(next)
  })
})

// 编排层用【真实 EditorView + 真实 visibility plugin + 真实 nodeViews】，只替身
// IntersectionObserver 与 rAF（happy-dom 无布局，这两者无法真实运行）。posAtDOM、
// 装饰、nodeView 销毁重建全走真实实现，测的是行为而不是替身。

type Entry = { target: Element; isIntersecting: boolean }
let emit: (entries: Entry[]) => void = () => {}
let nextFrameId = 0
const frames = new Map<number, FrameRequestCallback>()

class StubIntersectionObserver {
  constructor(cb: (entries: Entry[]) => void) {
    emit = cb
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function runFrames() {
  const pending = [...frames.values()]
  frames.clear()
  for (const cb of pending) cb(0)
}

const para = (text: string) => schema.node('paragraph', null, [schema.text(text)])

const mounted: { view: EditorView; root: HTMLElement; observer: ViewportObserver }[] = []

function mount(blocks: Node[]) {
  const root = document.createElement('div')
  const element = document.createElement('div')
  root.appendChild(element)
  document.body.appendChild(root)

  const heights = new HeightCache()
  let observer: ViewportObserver | null = null
  const view = new EditorView(element, {
    state: EditorState.create({
      doc: schema.node('doc', null, blocks),
      plugins: [createVisibilityPlugin()],
    }),
    nodeViews: blockNodeViews(heights, () => observer),
  })
  observer = createViewportObserver(view, root)
  // 首批 nodeView 构造时 observer 尚未存在，与 Task 9 的 createEditor 一样补挂
  for (const child of Array.from(view.dom.children)) observer.observe(child)

  const entry = { view, root, observer }
  mounted.push(entry)
  return {
    ...entry,
    wrappers: () => Array.from(view.dom.children) as HTMLElement[],
    visible: () => [...visibilityKey.getState(view.state)!.visible].sort((a, b) => a - b),
  }
}

beforeEach(() => {
  emit = () => {}
  nextFrameId = 0
  frames.clear()
  vi.stubGlobal('IntersectionObserver', StubIntersectionObserver)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = ++nextFrameId
    frames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
})

afterEach(() => {
  for (const m of mounted.splice(0)) {
    m.observer.disconnect()
    m.view.destroy()
    m.root.remove()
  }
  vi.unstubAllGlobals()
})

describe('createViewportObserver', () => {
  it('dispatches intersecting blocks as visibilityKey meta', () => {
    const { wrappers, visible } = mount([para('aaa'), para('bbb'), para('ccc')])
    emit(wrappers().map((el) => ({ target: el, isIntersecting: true })))
    runFrames()
    expect(visible()).toEqual([0, 5, 10])
  })

  it('does not dispatch again when the intersecting set is unchanged', () => {
    const { view, wrappers } = mount([para('aaa'), para('bbb')])
    emit(wrappers().map((el) => ({ target: el, isIntersecting: true })))
    runFrames()
    const settled = view.state
    // 翻转会重建 nodeView，旧外壳已脱离文档，必须重新取
    emit(wrappers().map((el) => ({ target: el, isIntersecting: true })))
    runFrames()
    expect(view.state).toBe(settled)
  })

  it('resyncs from plugin state after a delete and equal-size reinsert in one frame', () => {
    // plugin 在每个 docChanged transaction 里自行 map+filter。删掉 [5,9) 再在 5
    // 插回等长块后，文档起点回到 [0,5,9]，但 plugin 的集合只剩 {0,9}（map(5) 被
    // 插入推到 9）。若 observer 拿私有 prev={0,5,9} 去比较，DOM 算出的 next 恰好
    // 等于它 → 永远不派发纠正事务 → 屏上的块永久停在占位态。
    const { view, wrappers, visible } = mount([para('aaa'), para('bb'), para('ccc')])
    emit(wrappers().map((el) => ({ target: el, isIntersecting: true })))
    runFrames()
    expect(visible()).toEqual([0, 5, 9])

    view.dispatch(view.state.tr.delete(5, 9))
    view.dispatch(view.state.tr.insert(5, para('bb')))
    expect(visible()).toEqual([0, 9])

    emit(wrappers().map((el) => ({ target: el, isIntersecting: true })))
    runFrames()
    expect(visible()).toEqual([0, 5, 9])
  })

  it('defers flush while composing and dispatches after composition ends', () => {
    const { view, wrappers, visible } = mount([para('aaa'), para('bbb')])
    // composing 在 prosemirror-view 1.42.9 是只读 getter（d.ts:434 → this.input.composing），
    // 由真实浏览器的 composition 事件驱动，happy-dom 产生不了。这里替身的是【输入】，
    // 被测的闸门逻辑仍是真实实现。view 每个测试新建、afterEach 销毁，无需还原。
    let composing = true
    Object.defineProperty(view, 'composing', { get: () => composing, configurable: true })
    emit(wrappers().map((el) => ({ target: el, isIntersecting: true })))
    runFrames()
    expect(visible()).toEqual([])
    expect(frames.size).toBe(1)
    composing = false
    runFrames()
    expect(visible()).toEqual([0, 5])
  })

  it('skips detached elements instead of throwing', () => {
    const { wrappers, visible } = mount([para('aaa'), para('bbb')])
    const stranger = document.createElement('div')
    emit([
      { target: wrappers()[0], isIntersecting: true },
      { target: stranger, isIntersecting: true },
    ])
    runFrames()
    expect(visible()).toEqual([0])
  })
})

describe('blockPosOf', () => {
  it('maps a depth-1 position to its top-level block start', () => {
    const { view } = mount([para('aaa'), para('bbb')])
    const stub = { state: view.state, posAtDOM: () => 6 } as unknown as EditorView
    expect(blockPosOf(stub, document.createElement('div'))).toBe(5)
  })
})
