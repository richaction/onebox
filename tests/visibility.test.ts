import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { DecorationSet } from '@tiptap/pm/view'
import { schema } from '../src/core/schema'
import {
  createVisibilityPlugin,
  forcedVisiblePositions,
  isBlockVisible,
  visibilityKey,
} from '../src/core/viewport/visibility'

// doc: 两个段落 "aaa" / "bbb"。block1 pos=0（nodeSize 5），block2 pos=5。
function makeState(selectionPos = 6) {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('aaa')]),
    schema.node('paragraph', null, [schema.text('bbb')]),
  ])
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, selectionPos),
    plugins: [createVisibilityPlugin()],
  })
}

const setVisible = (state: EditorState, visible: number[]) =>
  state.apply(state.tr.setMeta(visibilityKey, { visible: new Set(visible) }))

// PluginKey.get() 的类型是 Plugin | undefined（prosemirror-state 1.4.4），故需 `!`；
// props.decorations 的类型带 this: Plugin（prosemirror-view 1.42.9），故用 .call(plugin, state)。
// 实现不读 this，与 PM 自身的 f(view.state) 调用等价。断言未作任何改动。
describe('visibility plugin', () => {
  it('starts with an empty visible set', () => {
    expect(visibilityKey.getState(makeState())?.visible.size).toBe(0)
  })

  it('applies meta updates', () => {
    const next = setVisible(makeState(), [0])
    expect([...visibilityKey.getState(next)!.visible]).toEqual([0])
  })

  it('keeps the visible set across unrelated transactions', () => {
    const state = setVisible(makeState(), [0])
    const next = state.apply(state.tr.insertText('x', 1))
    expect([...visibilityKey.getState(next)!.visible]).toEqual([0])
  })

  it('forces the selection block visible even when not in the set', () => {
    const state = makeState(6)
    expect([...forcedVisiblePositions(state)]).toEqual([5])
    expect(isBlockVisible(state, 5)).toBe(true)
    expect(isBlockVisible(state, 0)).toBe(false)
  })

  it('marks decorations with data-visible', () => {
    const state = setVisible(makeState(6), [])
    const plugin = visibilityKey.get(state)!
    const decos = plugin.props.decorations!.call(plugin, state) as DecorationSet
    const found = decos.find()
    expect(found.length).toBe(2)
    expect(found.map((d) => d.spec.visible)).toEqual([false, true])
    // attrs（第 3 参数）才是驱动 PM 销毁重建的那一半，必须单独断言：
    // 只测 spec 的话，删掉 attrs 参数仍然全绿，而整个架构会失效。
    // 公开 d.ts 只暴露 from/to/spec，attrs 在运行时挂在 type 上。
    expect(
      found.map(
        (d) => (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs['data-visible'],
      ),
    ).toEqual(['false', 'true'])
  })

  it('maps visible positions through document changes', () => {
    const state = setVisible(makeState(6), [5])
    const next = state.apply(state.tr.insertText('x', 1))
    expect([...visibilityKey.getState(next)!.visible]).toEqual([6])
  })

  it('drops visible positions whose block was deleted', () => {
    const state = setVisible(makeState(6), [0, 5])
    const next = state.apply(state.tr.delete(0, 5))
    expect([...visibilityKey.getState(next)!.visible]).toEqual([0])
  })

  it('forces every block in a range selection visible', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('aaa')]),
      schema.node('paragraph', null, [schema.text('bbb')]),
      schema.node('paragraph', null, [schema.text('ccc')]),
    ])
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 12),
      plugins: [createVisibilityPlugin()],
    })
    expect([...forcedVisiblePositions(state)].sort((a, b) => a - b)).toEqual([0, 5, 10])
  })

  it('rebuilds decorations when the visible set changes', () => {
    const state = setVisible(makeState(6), [0])
    const plugin = visibilityKey.get(state)!
    const a = plugin.props.decorations!.call(plugin, state)
    const next = setVisible(state, [5])
    const b = plugin.props.decorations!.call(plugin, next)
    expect(a).not.toBe(b)
  })

  it('memoizes decorations when nothing changed', () => {
    const state = setVisible(makeState(6), [0])
    const plugin = visibilityKey.get(state)!
    const a = plugin.props.decorations!.call(plugin, state)
    const b = plugin.props.decorations!.call(plugin, state)
    expect(a).toBe(b)
  })

  it('rebuilds decorations when the doc changes', () => {
    const state = setVisible(makeState(6), [0])
    const plugin = visibilityKey.get(state)!
    const a = plugin.props.decorations!.call(plugin, state)
    const next = state.apply(state.tr.insertText('x', 1))
    const b = plugin.props.decorations!.call(plugin, next)
    expect(a).not.toBe(b)
  })
})
