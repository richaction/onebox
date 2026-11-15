import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditor, type EditorHandle } from '../src/core/editor'

const SAMPLE = '# 标题\n\n段落 **粗体**\n\n- 甲\n- 乙\n'
let scrollRoot: HTMLElement | undefined
let handle: EditorHandle | undefined

function mount(onUpdate = vi.fn()) {
  scrollRoot = document.createElement('div')
  const element = document.createElement('div')
  scrollRoot.appendChild(element)
  document.body.appendChild(scrollRoot)
  handle = createEditor({ element, scrollRoot, markdown: SAMPLE, onUpdate })
  return { handle, element, onUpdate }
}

afterEach(() => {
  handle?.destroy()
  scrollRoot?.remove()
})

describe('createEditor', () => {
  it('loads markdown and serializes it back', () => {
    const { handle } = mount()
    expect(handle.toMarkdown()).toContain('# 标题')
    expect(handle.toMarkdown()).toContain('**粗体**')
  })

  it('loads a different file without marking it dirty or keeping the former file in undo history', () => {
    const { handle, onUpdate } = mount()
    handle.editor.commands.insertContent('编辑')
    expect(onUpdate).toHaveBeenCalledOnce()

    handle.loadMarkdown('## 换掉了\n')
    expect(handle.toMarkdown()).toBe('## 换掉了')
    expect(handle.editor.commands.undo()).toBe(false)
    expect(onUpdate).toHaveBeenCalledOnce()
  })

  it('renders one wrapper per top-level block', () => {
    const { element } = mount()
    expect(element.querySelectorAll('.onebox-block')).toHaveLength(3)
    expect(element.querySelector('.onebox-block-content')?.tagName).toBe('H1')
  })
})
