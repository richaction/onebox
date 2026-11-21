import { afterEach, describe, expect, it, vi } from 'vitest'
import { blockEditCommands, insertCommands, slashTrigger } from '../src/core/blockCommands'
import { createEditor, type EditorHandle } from '../src/core/editor'
import { visibilityKey } from '../src/core/viewport/visibility'

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

  it('places the caret from the page gutter without changing document content', () => {
    const { handle, onUpdate } = mount()
    const view = handle.editor.view
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 200))
    const posAtCoords = vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 })
    scrollRoot!.dispatchEvent(new MouseEvent('mousedown', { clientX: 15, clientY: 35, bubbles: true }))
    expect(posAtCoords).toHaveBeenCalledWith({ left: 41, top: 35 })
    expect(view.state.selection.head).toBe(2)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('continues from the blank space under a final code block without adding a second paragraph on repeat', () => {
    const { handle } = mount()
    const view = handle.editor.view
    handle.loadBlocks([{ type: 'codeBlock', content: [{ type: 'text', text: 'code' }] }], true)
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 100))
    const clickBelow = () => scrollRoot!.dispatchEvent(new MouseEvent('mousedown', {
      clientX: 110, clientY: 175, bubbles: true, cancelable: true,
    }))
    handle.editor.setEditable(false, false)
    clickBelow()
    expect(view.state.doc.firstChild?.childCount).toBe(1)

    handle.editor.setEditable(true, false)
    clickBelow()
    clickBelow()
    expect(view.state.doc.firstChild?.childCount).toBe(2)
    expect(view.state.selection.$head.parent.type.name).toBe('paragraph')
    expect(view.state.doc.firstChild?.firstChild?.textContent).toBe('code')
  })

  it('picks the visually nearer text line when a gutter click lands between blocks', () => {
    const { handle } = mount()
    handle.loadMarkdown('first\n\nsecond')
    const view = handle.editor.view
    const gap = view.state.doc.firstChild!.nodeSize
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 100))
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: gap, inside: -1 })
    vi.spyOn(view, 'coordsAtPos').mockImplementation((pos) => pos < gap
      ? { left: 50, right: 50, top: 20, bottom: 38 } : { left: 40, right: 40, top: 62, bottom: 80 })
    scrollRoot!.dispatchEvent(new MouseEvent('mousedown', { clientX: 15, clientY: 56, bubbles: true }))
    expect(view.state.selection.$head.parent.textContent).toBe('second')
  })

  it('opens a new paragraph below an isolated display formula', () => {
    const { handle } = mount()
    handle.loadMarkdown('$$a+b$$')
    const view = handle.editor.view
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 100))
    scrollRoot!.dispatchEvent(new MouseEvent('mousedown', { clientX: 110, clientY: 175, bubbles: true }))
    expect(view.state.doc.childCount).toBe(2)
    expect(view.state.selection.$head.parent.textContent).toBe('')
  })

  it('updates display formula paragraph layout when the surrounding text changes', () => {
    const { handle, element } = mount()
    handle.loadMarkdown('$$a+b$$\n\nInline $a+b$')
    const { view } = handle.editor
    const paragraph = element.querySelector('p')!
    expect([...element.querySelectorAll('p[data-display-math]')]).toEqual([paragraph])

    view.dispatch(view.state.tr.insertText('Before ', 1))
    expect(paragraph.hasAttribute('data-display-math')).toBe(false)

    view.dispatch(view.state.tr.delete(1, 8))
    expect(paragraph.hasAttribute('data-display-math')).toBe(true)
  })

  it('keeps the inline formula preview mounted while editing its LaTeX and committing a change', () => {
    const { handle, element } = mount()
    handle.loadMarkdown('before $r^2$ after')
    const formula = element.querySelector<HTMLElement>('.markdown-math')!
    const preview = formula.querySelector('button')!
    preview.dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true }))
    const source = formula.querySelector('textarea')!
    expect(formula.dataset.mathEdit).toBe('source')
    expect(preview.hidden).toBe(false)
    source.value = 'r^3'
    source.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(element.querySelector('.markdown-math > button')).toBe(preview)
    expect(formula.dataset.mathEdit).toBeUndefined()
    expect(handle.toMarkdown()).toBe('before $r^3$ after')
  })

  it('opens the line below a code block and reuses a following paragraph across viewport groups', () => {
    const { handle, element, onUpdate } = mount()
    handle.loadBlocks([{ type: 'codeBlock', content: [{ type: 'text', text: 'code' }] }], true)
    handle.appendBlocks([{ type: 'paragraph', content: [{ type: 'text', text: 'next' }] }])
    element.querySelector<HTMLButtonElement>('.code-continue')!.click()

    const { selection, doc } = handle.editor.state
    expect(selection.$head.parent.textContent).toBe('next')
    expect(selection.$head.parentOffset).toBe(0)
    expect(doc.firstChild?.childCount).toBe(1)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('keeps editor-only code and table controls outside exported content', () => {
    const { handle, element } = mount()
    handle.loadMarkdown('> ```python\n> print("hello")\n> ```')

    const code = element.querySelector('.code-frame')!
    expect(code.querySelector<HTMLSelectElement>('.code-language')?.value).toBe('python')
    expect(code.querySelector('pre > code')?.textContent).toBe('print("hello")')
    expect(code.querySelector('pre > code')?.getAttribute('spellcheck')).toBe('false')
    expect(handle.editor.view.dom.getAttribute('autocorrect')).toBe('off')
    expect(Array.from(code.querySelectorAll('.code-toolbar button'), (button) => button.textContent)).toEqual(['复制'])
    expect(handle.editor.getHTML()).not.toMatch(/code-frame|code-toolbar/)

    handle.loadMarkdown('| Name | Count |\n| --- | ---: |\n| A | 42 |')
    const table = element.querySelector('.table-scroll > table')
    expect(table).not.toBeNull()
    expect(table!.querySelector('th')?.getAttribute('scope')).toBe('col')
    expect(table!.querySelector<HTMLElement>('td:last-child')?.style.textAlign).toBe('right')
    expect(handle.editor.getHTML()).not.toContain('table-scroll')
  })

  it('edits Mermaid in its existing Markdown fence and remembers the caret when switching panes', () => {
    const { handle, element, onUpdate } = mount()
    handle.loadMarkdown('# Other\n\n```mermaid\nflowchart LR\nA --> B\n```')
    const { editor } = handle
    editor.view.dispatch(editor.state.tr.setMeta(visibilityKey, {
      visible: new Set([0, editor.state.doc.firstChild!.nodeSize]),
    }))
    const frame = element.querySelector<HTMLElement>('[data-rich="mermaid"]')!
    const edit = frame.querySelector<HTMLButtonElement>('.code-toolbar button')!
    const source = frame.querySelector<HTMLPreElement>('pre')!
    const preview = frame.querySelector('.rich-preview')!
    const [sourceTab, previewTab] = frame.querySelectorAll<HTMLButtonElement>('.mermaid-tabs button')
    expect(edit.textContent).toBe('编辑')
    expect(source.hidden).toBe(true)

    edit.click()
    expect(edit.textContent).toBe('完成')
    expect(source.hidden).toBe(false)
    expect(handle.editor.state.selection.$head.parent.type.name).toBe('codeBlock')
    expect(handle.editor.state.selection.$head.parentOffset).toBe(0)
    expect(preview.parentElement).toBe(source.parentElement)

    editor.commands.setTextSelection(editor.state.selection.head + 'flowchart LR\nA --> B'.length)
    previewTab.click()
    expect(previewTab.getAttribute('aria-pressed')).toBe('true')
    editor.commands.setTextSelection(1)
    sourceTab.click()
    expect(editor.state.selection.$head.parentOffset).toBe('flowchart LR\nA --> B'.length)
    expect(onUpdate).not.toHaveBeenCalled()

    editor.view.dispatch(editor.state.tr.insertText('[Ready]'))
    edit.click()
    expect(frame.querySelector('.rich-preview')).toBe(preview)
    expect(source.hidden).toBe(true)
    expect(handle.toMarkdown()).toBe('# Other\n\n```mermaid\nflowchart LR\nA --> B[Ready]\n```')
    expect(onUpdate).toHaveBeenCalledOnce()
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

    choose('rust')
    expect(select().value).toBe('rust')
    expect(select().closest('.code-frame')?.getAttribute('data-language')).toBe('rust')
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

  it('inserts editable chart and LaTeX templates from slash commands', () => {
    const { handle } = mount()
    handle.loadMarkdown('')
    const { editor } = handle
    const line = insertCommands.find((item) => item.label === '折线图')!
    const formula = insertCommands.find((item) => item.label === '公式')!
    expect(line.run(editor.chain()).run()).toBe(true)
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph' })
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    expect(formula.run(editor.chain()).run()).toBe(true)
    expect(handle.toMarkdown()).toContain('```echarts')
    expect(handle.toMarkdown()).toContain(String.raw`$$\displaystyle \sum_{k=1}^{n} k`)
    expect(editor.state.doc.firstChild?.attrs.language).toBe('echarts')
    expect(editor.state.doc.lastChild?.firstChild?.type.name).toBe('math')
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
