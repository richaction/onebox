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

// happy-dom has no layout. Stub rectangles while retaining the real editor and node views.
let nextFrameId = 0
const frames = new Map<number, FrameRequestCallback>()

function runFrames() {
  const pending = [...frames.values()]
  frames.clear()
  for (const callback of pending) callback(0)
}

const para = (text: string) => schema.node('paragraph', null, [schema.text(text)])
const mounted: { view: EditorView; root: HTMLElement; observer: ViewportObserver }[] = []

function mount(blocks: Node[]) {
  const root = document.createElement('div')
  const element = document.createElement('div')
  root.appendChild(element)
  document.body.appendChild(root)

  let observer: ViewportObserver | null = null
  const heights = new HeightCache()
  const view = new EditorView(element, {
    state: EditorState.create({
      doc: schema.node('doc', null, blocks),
      plugins: [createVisibilityPlugin()],
    }),
    nodeViews: blockNodeViews(heights, () => observer),
  })
  let top = 0
  let bottom = 99
  root.getBoundingClientRect = () => new DOMRect(0, top, 500, bottom - top)
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const index = Array.from(view.dom.children).indexOf(this)
      return new DOMRect(0, index * 100, 500, 100)
    })
  observer = createViewportObserver(view, root, 0)
  for (const child of view.dom.children) observer.observe(child)

  const entry = { view, root, observer }
  mounted.push(entry)
  return {
    ...entry,
    visible: () => [...visibilityKey.getState(view.state)!.visible].sort((a, b) => a - b),
    scroll(from: number, to: number) {
      top = from
      bottom = to
      root.dispatchEvent(new Event('scroll'))
    },
    measure,
  }
}

beforeEach(() => {
  nextFrameId = 0
  frames.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrameId, callback)
    return nextFrameId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})

afterEach(() => {
  for (const { view, root, observer } of mounted.splice(0)) {
    observer.disconnect()
    view.destroy()
    root.remove()
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('createViewportObserver', () => {
  it('dispatches the visible blocks as visibilityKey metadata', () => {
    const { scroll, visible } = mount([para('aaa'), para('bbb'), para('ccc')])
    scroll(0, 299)
    runFrames()
    expect(visible()).toEqual([0, 5, 10])
  })

  it('deduplicates unchanged positions even when node views were replaced', () => {
    const { view, scroll } = mount([para('aaa'), para('bbb')])
    scroll(0, 199)
    runFrames()
    const settled = view.state
    scroll(0, 199)
    runFrames()
    expect(view.state).toBe(settled)
  })

  it('coalesces scroll events and measures the latest viewport', () => {
    const { scroll, visible } = mount([para('aaa'), para('bbb')])
    scroll(1, 95)
    scroll(101, 195)
    expect(frames.size).toBe(1)
    runFrames()
    expect(visible()).toEqual([5])
    runFrames()
    expect(frames.size).toBe(0)
  })

  it('resyncs with plugin state after an equal-size delete and insert', () => {
    const { view, scroll, visible } = mount([para('aaa'), para('bb'), para('ccc')])
    scroll(0, 299)
    runFrames()
    expect(visible()).toEqual([0, 5, 9])

    view.dispatch(view.state.tr.delete(5, 9))
    view.dispatch(view.state.tr.insert(5, para('bb')))
    expect(visible()).toEqual([0, 9])

    scroll(0, 299)
    runFrames()
    expect(visible()).toEqual([0, 5, 9])
  })

  it('defers viewport changes until IME composition ends', () => {
    const { view, scroll, visible } = mount([para('aaa'), para('bbb')])
    let composing = true
    Object.defineProperty(view, 'composing', { get: () => composing, configurable: true })
    scroll(0, 199)
    runFrames()
    expect(visible()).toEqual([])
    expect(frames.size).toBe(1)

    composing = false
    runFrames()
    expect(visible()).toEqual([0, 5])
  })

  it('binary-searches a large stack with few geometry reads', () => {
    const { scroll, visible, measure } = mount(Array.from({ length: 1000 }, () => para('abc')))
    scroll(50_001, 50_200)
    runFrames()
    expect(visible()).toEqual([2500, 2505, 2510])
    expect(measure.mock.calls.length).toBeLessThan(30)
  })

  it('ignores an unmounted editor', () => {
    const { root, scroll, visible } = mount([para('aaa'), para('bbb')])
    root.remove()
    scroll(0, 199)
    runFrames()
    expect(visible()).toEqual([])
  })
})

describe('blockPosOf', () => {
  it('maps a depth-1 position to its top-level block start', () => {
    const { view } = mount([para('aaa'), para('bbb')])
    const stub = { state: view.state, posAtDOM: () => 6 } as unknown as EditorView
    expect(blockPosOf(stub, document.createElement('div'))).toBe(5)
  })
})
