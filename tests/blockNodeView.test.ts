import { describe, expect, it } from 'vitest'
import type { Node } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { schema } from '../src/core/schema'
import { HeightCache } from '../src/core/viewport/heights'
import { createVisibilityPlugin, visibilityKey } from '../src/core/viewport/visibility'
import { blockNodeViews, createBlockNodeView, type ViewportObserver } from '../src/core/viewport/blockNodeView'

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
    // 位置：paragraph('a') nodeSize=3 → hr 在 pos 3，doc content size=4
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('a')]),
      schema.node('horizontalRule'),
    ])
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1),
      plugins: [createVisibilityPlugin()],
    })
    state = state.apply(state.tr.setMeta(visibilityKey, { visible: new Set([3]) }))
    const view = { state } as unknown as EditorView
    const nv = createBlockNodeView(state.doc.child(1), view, () => 3, new HeightCache(), () => null)
    expect(nv.dom.querySelector('hr')).not.toBeNull()
    expect(nv.contentDOM).toBeUndefined()
  })

  it('renders a paragraph nested in a list item normally, not as a placeholder', () => {
    // nodeViews 按类型名注册，对所有深度生效。嵌套段落 pos=2、depth>0，
    // 若走占位分支会把整个列表项的内容销毁（li.textContent 变成空）。
    const list = schema.node('bulletList', null, [
      schema.node('listItem', null, [schema.node('paragraph', null, [schema.text('item')])]),
    ])
    const doc = schema.node('doc', null, [list])
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3),
      plugins: [createVisibilityPlugin()],
    })
    state = state.apply(state.tr.setMeta(visibilityKey, { visible: new Set([0]) }))
    const view = { state } as unknown as EditorView
    const nested = state.doc.child(0).child(0).child(0)
    const nv = createBlockNodeView(nested, view, () => 2, new HeightCache(), () => null)
    expect(nv.contentDOM).toBeDefined()
    expect(nv.dom.tagName).toBe('P')
    // 语义元素自身就是内容容器，PM 才会把文字渲染进 <p>；套一层 div 就不相等了
    expect(nv.contentDOM).toBe(nv.dom)
  })

  it('renders a paragraph nested in a blockquote normally', () => {
    const quote = schema.node('blockquote', null, [
      schema.node('paragraph', null, [schema.text('q')]),
    ])
    const doc = schema.node('doc', null, [quote])
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 2),
      plugins: [createVisibilityPlugin()],
    })
    state = state.apply(state.tr.setMeta(visibilityKey, { visible: new Set([0]) }))
    const view = { state } as unknown as EditorView
    const nested = state.doc.child(0).child(0)
    const nv = createBlockNodeView(nested, view, () => 1, new HeightCache(), () => null)
    expect(nv.contentDOM).toBeDefined()
    expect(nv.dom.tagName).toBe('P')
  })

  it('recreates when heading level changes', () => {
    const view = singleBlockView(schema.node('heading', { level: 2 }, [schema.text('h')]))
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => null,
    )
    const next = schema.node('heading', { level: 3 }, [schema.text('h')])
    expect(nv.update!(next, [], undefined as never)).toBe(false)
  })

  it('recreates when code block language changes', () => {
    const view = singleBlockView(schema.node('codeBlock', { language: 'ts' }, [schema.text('x')]))
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => null,
    )
    const next = schema.node('codeBlock', { language: 'js' }, [schema.text('x')])
    expect(nv.update!(next, [], undefined as never)).toBe(false)
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

  it('unobserves through the current observer when none existed at construction', () => {
    // Task 9 的 createEditor 先建 EditorView 再建 observer：首批 nodeView 构造时
    // getObserver() 返回 null，由 createEditor 对 view.dom.children 补挂。若 destroy
    // 用构造时捕获的 null，补挂进去的外壳永远注销不掉，states 与 IO 会随每次翻转
    // 累积脱离文档的元素（2 万块滚一遍即 2 万条，每帧 flush 都遍历，IO 强引用不回收）。
    const seen: string[] = []
    const observer = {
      observe: () => seen.push('observe'),
      unobserve: () => seen.push('unobserve'),
      disconnect: () => {},
    }
    let current: ViewportObserver | null = null
    const view = makeView([0])
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => current,
    )
    expect(seen).toEqual([])
    current = observer
    current.observe(nv.dom)
    seen.length = 0
    nv.destroy!()
    expect(seen).toEqual(['unobserve'])
  })

  it('ignores mutations outside contentDOM', () => {
    const view = makeView([0])
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => null,
    )
    expect(nv.ignoreMutation!({ target: nv.dom } as never)).toBe(true)
    expect(nv.ignoreMutation!({ target: nv.contentDOM } as never)).toBe(false)
    // PM 渲染进 contentDOM 的后代文本节点同样不能被忽略
    const text = document.createTextNode('aaa')
    nv.contentDOM!.appendChild(text)
    expect(nv.ignoreMutation!({ target: text } as never)).toBe(false)
  })

  it('never ignores selection mutations', () => {
    // PM 默认实现（view dist:1125）对 selection mutation 恒返回 false；
    // 吞掉它 PM 就不再从 DOM 回读选区。占位块（无 contentDOM）也一样。
    const view = makeView([0])
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => null,
    )
    expect(nv.ignoreMutation!({ type: 'selection', target: nv.dom } as never)).toBe(false)

    const hidden = makeView([])
    const placeholder = createBlockNodeView(
      hidden.state.doc.child(0), hidden, () => 0, new HeightCache(), () => null,
    )
    expect(placeholder.contentDOM).toBeUndefined()
    expect(
      placeholder.ignoreMutation!({ type: 'selection', target: placeholder.dom } as never),
    ).toBe(false)
  })

  it('does not register nested blocks with the observer', () => {
    // 嵌套段落若也进 observer，观测目标数会随文档嵌套深度成倍增长
    const seen: string[] = []
    const observer = {
      observe: () => seen.push('observe'),
      unobserve: () => seen.push('unobserve'),
      disconnect: () => {},
    }
    const list = schema.node('bulletList', null, [
      schema.node('listItem', null, [schema.node('paragraph', null, [schema.text('item')])]),
    ])
    const doc = schema.node('doc', null, [list])
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3),
      plugins: [createVisibilityPlugin()],
    })
    state = state.apply(state.tr.setMeta(visibilityKey, { visible: new Set([0]) }))
    const view = { state } as unknown as EditorView
    const nested = state.doc.child(0).child(0).child(0)
    const nv = createBlockNodeView(nested, view, () => 2, new HeightCache(), () => observer)
    expect(seen).toEqual([])
    // 嵌套块不注册观测，也没有需要清理的东西，故不提供 destroy
    expect(nv.destroy).toBeUndefined()
  })

  it('recomputes a hidden placeholder height when its content changes', () => {
    const view = makeView([])
    const block = view.state.doc.child(0)
    const heights = new HeightCache()
    heights.set(block, 123)
    const nv = createBlockNodeView(block, view, () => 0, heights, () => null)
    expect(nv.dom.style.height).toBe('123px')
    // 200 字符 → ceil(200/80)=3 行 → 72px；新节点无缓存，走 estimateHeight
    const taller = schema.node('paragraph', null, [schema.text('x'.repeat(200))])
    expect(nv.update!(taller, [], undefined as never)).toBe(true)
    expect(nv.dom.style.height).toBe('72px')
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
