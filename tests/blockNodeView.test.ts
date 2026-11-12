import { describe, expect, it } from 'vitest'
import type { Node } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { schema } from '../src/core/schema'
import { HeightCache } from '../src/core/viewport/heights'
import { createVisibilityPlugin, visibilityKey } from '../src/core/viewport/visibility'
import { blockNodeViews, createBlockNodeView } from '../src/core/viewport/blockNodeView'

// block1 pos=0, block2 pos=5；选区放在 block2，使 block1 可被隐藏
function makeView(visible: number[]) {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('aaa')]),
    schema.node('paragraph', null, [schema.text('bbb')]),
  ])
  let state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 6),
    plugins: [createVisibilityPlugin()],
  })
  state = state.apply(state.tr.setMeta(visibilityKey, { visible: new Set(visible) }))
  return { state } as unknown as EditorView
}

// 单块文档，选区落在块内 pos 1，可见集含 pos 0
function singleBlockView(block: Node) {
  const doc = schema.node('doc', null, [block])
  let state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1),
    plugins: [createVisibilityPlugin()],
  })
  state = state.apply(state.tr.setMeta(visibilityKey, { visible: new Set([0]) }))
  return { state } as unknown as EditorView
}

describe('createBlockNodeView', () => {
  it('renders contentDOM when visible', () => {
    const heights = new HeightCache()
    const view = makeView([0])
    const nv = createBlockNodeView(view.state.doc.child(0), view, () => 0, heights, () => null)
    expect(nv.contentDOM).toBeDefined()
    expect(nv.dom.dataset.visible).toBe('true')
    expect(nv.dom.contains(nv.contentDOM!)).toBe(true)
  })

  it('renders a height-sized placeholder when hidden', () => {
    const heights = new HeightCache()
    const view = makeView([])
    const block = view.state.doc.child(0)
    heights.set(block, 123)
    const nv = createBlockNodeView(block, view, () => 0, heights, () => null)
    expect(nv.contentDOM).toBeUndefined()
    expect(nv.dom.dataset.visible).toBe('false')
    expect(nv.dom.style.height).toBe('123px')
  })

  it('falls back to estimateHeight when unmeasured', () => {
    const view = makeView([])
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => null,
    )
    expect(nv.dom.style.height).toBe('28px')
  })

  it('renders the selection-bearing block even when absent from the visible set', () => {
    // 这条专门咬住「必须用 isBlockVisible 而非直读 state.visible」：
    // 选区在 block2、可见集为空时，block2 仍须有 contentDOM
    const view = makeView([])
    const nv = createBlockNodeView(
      view.state.doc.child(1), view, () => 5, new HeightCache(), () => null,
    )
    expect(nv.dom.dataset.visible).toBe('true')
    expect(nv.contentDOM).toBeDefined()
  })

  it('falls back to the estimate when the cached height is zero', () => {
    const view = makeView([])
    const block = view.state.doc.child(0)
    const heights = new HeightCache()
    heights.set(block, 0)
    const nv = createBlockNodeView(block, view, () => 0, heights, () => null)
    expect(nv.dom.style.height).toBe('28px')
  })

  it('preserves heading semantics', () => {
    const view = singleBlockView(schema.node('heading', { level: 2 }, [schema.text('h')]))
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => null,
    )
    expect(nv.dom.querySelector('h2')).not.toBeNull()
    expect(nv.contentDOM?.tagName).toBe('H2')
  })

  it('preserves code block semantics and language class', () => {
    const view = singleBlockView(schema.node('codeBlock', { language: 'ts' }, [schema.text('x')]))
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => null,
    )
    expect(nv.dom.querySelector('pre > code.language-ts')).not.toBeNull()
    expect(nv.contentDOM?.tagName).toBe('CODE')
  })

  it('gives a leaf horizontalRule no contentDOM', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('a')]),
      schema.node('horizontalRule'),
    ])
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1),
      plugins: [createVisibilityPlugin()],
    })
    state = state.apply(state.tr.setMeta(visibilityKey, { visible: new Set([5]) }))
    const view = { state } as unknown as EditorView
    const nv = createBlockNodeView(state.doc.child(1), view, () => 5, new HeightCache(), () => null)
    expect(nv.dom.querySelector('hr')).not.toBeNull()
    expect(nv.contentDOM).toBeUndefined()
  })

  it('returns false from update when visibility flips', () => {
    const heights = new HeightCache()
    const view = makeView([0])
    const nv = createBlockNodeView(view.state.doc.child(0), view, () => 0, heights, () => null)
    view.state = view.state.apply(
      view.state.tr.setMeta(visibilityKey, { visible: new Set<number>() }),
    )
    expect(nv.update!(view.state.doc.child(0), [], undefined as never)).toBe(false)
  })

  it('returns true from update when visibility is unchanged', () => {
    const view = makeView([0])
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => null,
    )
    expect(nv.update!(view.state.doc.child(0), [], undefined as never)).toBe(true)
  })

  it('registers and unregisters with the observer', () => {
    const seen: string[] = []
    const observer = {
      observe: () => seen.push('observe'),
      unobserve: () => seen.push('unobserve'),
      disconnect: () => {},
    }
    const view = makeView([0])
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => observer,
    )
    expect(seen).toEqual(['observe'])
    nv.destroy!()
    expect(seen).toEqual(['observe', 'unobserve'])
  })

  it('ignores mutations outside contentDOM', () => {
    const view = makeView([0])
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => null,
    )
    expect(nv.ignoreMutation!({ target: nv.dom } as never)).toBe(true)
    expect(nv.ignoreMutation!({ target: nv.contentDOM } as never)).toBe(false)
  })
})

describe('blockNodeViews', () => {
  it('registers every top-level type but not listItem', () => {
    const views = blockNodeViews(new HeightCache(), () => null)
    expect(Object.keys(views).sort()).toEqual(
      ['blockquote', 'bulletList', 'codeBlock', 'heading', 'horizontalRule', 'orderedList', 'paragraph'],
    )
    expect(views.listItem).toBeUndefined()
  })
})
