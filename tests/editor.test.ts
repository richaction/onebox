import { afterEach, describe, expect, it, vi } from 'vitest'
import { blockEditCommands, slashTrigger } from '../src/core/blockCommands'
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

  it('keeps editor-only code and table controls outside exported content', () => {
    const { handle, element } = mount()
    handle.loadMarkdown('> ```python\n> print("hello")\n> ```')

    const code = element.querySelector('.code-frame')!
    expect(code.querySelector<HTMLSelectElement>('.code-language')?.value).toBe('python')
    expect(code.querySelector('pre > code')?.textContent).toBe('print("hello")')
    expect(code.querySelector('pre > code')?.getAttribute('spellcheck')).toBe('false')
    expect(handle.editor.view.dom.getAttribute('autocorrect')).toBe('off')
    const beforeWrap = handle.toMarkdown()
    code.querySelector<HTMLButtonElement>('button')!.click()
    expect(code.hasAttribute('data-wrap')).toBe(true)
    expect(handle.toMarkdown()).toBe(beforeWrap)
    expect(handle.editor.getHTML()).not.toMatch(/code-frame|code-toolbar/)

    handle.loadMarkdown('| Name | Count |\n| --- | ---: |\n| A | 42 |')
    const table = element.querySelector('.table-scroll > table')
    expect(table).not.toBeNull()
    expect(table!.querySelector('th')?.getAttribute('scope')).toBe('col')
    expect(table!.querySelector<HTMLElement>('td:last-child')?.style.textAlign).toBe('right')
    expect(handle.editor.getHTML()).not.toContain('table-scroll')
  })

  it('changes the fence language through the dropdown and preserves its contents and metadata', () => {
    const { handle, element, onUpdate } = mount()
    const input = '> ```custom title=demo\n> fn main() {}\n> ```'
    handle.loadMarkdown(input)
    const select = () => element.querySelector<HTMLSelectElement>('.code-language')!
    const choose = (value: string) => {
      select().value = value
      select().dispatchEvent(new Event('change', { bubbles: true }))
    }
    expect(select().value).toBe('custom')
    expect(handle.toMarkdown()).toBe(input)

    handle.editor.setEditable(false, false)
    expect(select().disabled).toBe(true)
    choose('rust')
    expect(handle.toMarkdown()).toBe(input)
    handle.editor.setEditable(true, false)
    expect(select().disabled).toBe(false)

    element.querySelector<HTMLButtonElement>('.code-actions button')!.click()
    choose('rust')
    expect(select().value).toBe('rust')
    expect(select().closest('.code-frame[data-wrap]')?.getAttribute('data-language')).toBe('rust')
    expect(handle.toMarkdown()).toBe('> ```rust title=demo\n> fn main() {}\n> ```')
    expect(onUpdate).toHaveBeenCalledOnce()
    expect(handle.editor.commands.undo()).toBe(true)
    expect(handle.toMarkdown()).toBe(input)

    choose('')
    expect(select().value).toBe('')
    expect(handle.toMarkdown()).toBe('> ```text title=demo\n> fn main() {}\n> ```')
  })

  it('appends viewport groups and exports the underlying Markdown blocks', () => {
    const { handle, onUpdate, element } = mount()
    handle.loadBlocks([{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }], true)
    handle.appendBlocks([{ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'next' }] }])

    expect(element.querySelectorAll('.onebox-block')).toHaveLength(2)
    expect(handle.editor.state.doc.firstChild?.type.name).toBe('viewportGroup')
    expect(handle.toMarkdown()).toBe('first\n\n### next')
    expect(onUpdate).not.toHaveBeenCalled()
    expect(handle.editor.commands.undo()).toBe(false)
  })

  it('duplicates and deletes a block inside a large-document group', () => {
    const { handle } = mount()
    handle.loadBlocks([{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }], true)
    const [duplicate, remove] = blockEditCommands

    expect(duplicate.run(handle.editor.chain()).run()).toBe(true)
    expect(handle.toMarkdown()).toBe('first\n\nfirst')
    expect(remove.run(handle.editor.chain()).run()).toBe(true)
    expect(handle.toMarkdown()).toBe('first')
    expect(remove.run(handle.editor.chain()).run()).toBe(true)
    expect(handle.editor.state.doc.childCount).toBeGreaterThan(0)
    expect(handle.toMarkdown()).toBe('')
  })

  it('matches a slash command after a delimiter in a long paragraph', () => {
    const { handle } = mount()
    const command = 'x'.repeat(32)
    const prefix = '文'.repeat(10_000)
    handle.loadMarkdown(`${prefix}/${command}`)
    handle.editor.commands.setTextSelection(handle.editor.state.doc.content.size - 1)
    expect(slashTrigger(handle.editor.state)).toBeNull()
    handle.loadMarkdown(`${prefix} /${command}`)
    handle.editor.commands.setTextSelection(handle.editor.state.doc.content.size - 1)
    expect(slashTrigger(handle.editor.state)?.query).toBe(command)
  })

  it('joins paragraphs across a viewport group with a single Backspace', () => {
    const { handle } = mount()
    handle.loadBlocks([{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }], true)
    handle.appendBlocks([{ type: 'paragraph', content: [{ type: 'text', text: 'next' }] }])
    handle.editor.commands.setTextSelection(handle.editor.state.doc.firstChild!.nodeSize + 2)
    handle.editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace', bubbles: true, cancelable: true,
    }))

    expect(handle.toMarkdown()).toBe('firstnext')
    expect(handle.editor.commands.undo()).toBe(true)
    expect(handle.toMarkdown()).toBe('first\n\nnext')
  })
})
