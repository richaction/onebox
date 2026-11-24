import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { createComponent } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { blockEditCommands, insertCommands, slashTrigger } from '../src/core/blockCommands'
import { createEditor, type EditorHandle } from '../src/core/editor'
import { visibilityKey } from '../src/core/viewport/visibility'
import EditorShell from '../src/ui/EditorShell'
import { ai, type AiEvent } from '../src/io/ai'
import { ListRowsSelection } from '../src/core/listSelection'

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

it('opens the in-document AI editor on first click and applies only after approval', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const onQuoteSelection = vi.fn()
  let receive!: (event: AiEvent) => void
  const mocks = [
    vi.spyOn(ai, 'events').mockImplementation(async (callback) => { receive = callback; return () => {} }),
    vi.spyOn(ai, 'account').mockResolvedValue({ email: '', plan: 'test' }),
    vi.spyOn(ai, 'models').mockResolvedValue([{ model: 'test' }]),
    vi.spyOn(ai, 'newThread').mockResolvedValue('thread'),
    vi.spyOn(ai, 'closeThread').mockResolvedValue(undefined),
  ]
  const send = vi.spyOn(ai, 'start').mockResolvedValue('turn')
  let mounted!: EditorHandle
  const dispose = render(() => createComponent(EditorShell, {
    markdown: 'onebox sample text', onReady: (value) => { mounted = value },
    onUpdate: vi.fn(), onQuoteSelection, inlineAi: true,
  }), host)
  try {
    const view = mounted.editor.view
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 7)))
    const paragraph = view.dom.querySelector('p')!
    const text = paragraph.firstChild!
    const rects = vi.fn(() => [new DOMRect(20, 60, 60, 20)])
    const nativeSelection = {
      anchorNode: text, focusNode: text, rangeCount: 1, isCollapsed: false,
      getRangeAt: () => ({ getClientRects: rects }),
    } as unknown as globalThis.Selection
    const native = vi.spyOn(window, 'getSelection').mockReturnValue(nativeSelection)
    const focus = vi.spyOn(view, 'hasFocus').mockReturnValue(true)
    const hover = (x: number, buttons = 0) => paragraph.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerType: 'mouse', clientX: x, clientY: 70, buttons,
    }))
    const menu = () => document.querySelector<HTMLElement>('.editor-selection-menu')
    const aiButton = () => menu()?.querySelector<HTMLButtonElement>('.selection-toolbar-ai')
    try {
      hover(40, 1)
      hover(100)
      expect(menu()).toBeNull()
      hover(40)
      expect(menu()?.textContent).toContain('使用 AI 编辑')
      expect(rects).toHaveBeenCalledOnce()
      const scroll = host.querySelector('.editor-scroll')!
      vi.useFakeTimers()
      try {
        scroll.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }))
        vi.advanceTimersByTime(400)
        expect(menu()).not.toBeNull()
      } finally {
        vi.useRealTimers()
      }
      native.mockRestore()
      const contentBounds = vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(56, 24, 708, 180))
      const scrollBounds = vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 820, 220))
      vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 20, right: 80, top: 60, bottom: 80 })
      const retryFocus = vi.spyOn(HTMLTextAreaElement.prototype, 'focus').mockImplementationOnce(() => {})
      try {
        const button = aiButton()!
        button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }))
        scroll.dispatchEvent(new Event('scroll'))
        expect(aiButton()).toBe(button)
        button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 }))
        // A layout event and a native caret update can follow pointerup before click.
        scroll.dispatchEvent(new Event('scroll'))
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 12)))
        expect(button.isConnected).toBe(true)
        button.click()
        await vi.waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('修改要求'))
        expect(retryFocus.mock.calls.length).toBeGreaterThan(1)
      } finally { retryFocus.mockRestore() }
      const input = document.querySelector<HTMLTextAreaElement>('[aria-label="修改要求"]')!
      const panel = input.closest<HTMLElement>('.editor-inline-ai')!
      expect(input).not.toBeNull()
      expect(document.activeElement).toBe(input)
      expect(view.state.selection.from).toBe(7)
      input.blur()
      panel.querySelector('.editor-inline-ai-spark')!.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0,
      }))
      expect(document.activeElement).toBe(input)
      const sendButton = panel.querySelector<HTMLButtonElement>('[aria-label="发送修改要求"]')!
      expect(sendButton.disabled).toBe(true)
      input.value = '   '
      input.dispatchEvent(new Event('input', { bubbles: true }))
      expect(sendButton.disabled).toBe(true)
      expect(panel.style.left).toBe('56px')
      expect(panel.style.width).toBe('708px')
      expect(panel.style.top).toBe('86px')
      contentBounds.mockReturnValue(new DOMRect(22, 24, 276, 180))
      scrollBounds.mockReturnValue(new DOMRect(0, 0, 320, 220))
      window.dispatchEvent(new Event('resize'))
      await vi.waitFor(() => expect(panel.style.width).toBe('276px'))
      expect(panel.style.left).toBe('22px')
      expect(document.querySelector('.editor-inline-ai-dismiss')).toBeNull()
      expect(onQuoteSelection).not.toHaveBeenCalled()
      expect(menu()).toBeNull()
      input.value = '改为 Onebox'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      expect(sendButton.disabled).toBe(false)
      sendButton.click()
      expect(document.body.textContent).toContain('正在工作')
      expect(panel.style.width).toBe('276px')
      expect(document.querySelector('.editor-inline-ai-loading')).not.toBeNull()
      expect(document.querySelector('[aria-label="停止生成"]')?.textContent).toBe('')
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
      const payload = JSON.parse(send.mock.calls[0][1])
      expect(payload.references).toEqual([{ number: 1, markdown: 'onebox' }])
      receive({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn',
        item: { id: 'answer', type: 'agentMessage', text: JSON.stringify({
          answer: '已调整大小写', revision: { markdown: 'Onebox', reference: 1 },
        }) } } })
      receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } })
      expect(document.querySelector('.editor-inline-ai-loading')).toBeNull()
      expect(document.querySelector('[aria-label="确认修改"]')).not.toBeNull()
      expect(panel.style.width).toBe('276px')
      expect(view.dom.querySelector('.editor-ai-added')?.textContent).toBe('O')
      expect(view.dom.querySelector('.editor-ai-removed')?.textContent).toBe('o')
      expect(mounted.toMarkdown()).toBe('onebox sample text')
      host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      expect(view.dom.querySelector('.editor-ai-added')?.textContent).toBe('O')
      document.querySelector<HTMLButtonElement>('.editor-inline-ai-apply')!.click()
      expect(mounted.toMarkdown()).toBe('Onebox sample text')
      expect(document.querySelector('.editor-inline-ai')).toBeNull()
      expect(mounted.editor.commands.undo()).toBe(true)
      expect(mounted.toMarkdown()).toBe('onebox sample text')

      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 7)))
      const restoredText = view.dom.querySelector('p')!.firstChild!
      const restoredNative = vi.spyOn(window, 'getSelection').mockReturnValue({
        ...nativeSelection, anchorNode: restoredText, focusNode: restoredText,
      })
      try {
        scroll.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, pointerType: 'mouse', clientX: 87, clientY: 75, button: 0,
        }))
        await vi.waitFor(() => expect(menu()).not.toBeNull())
      } finally { restoredNative.mockRestore() }
      aiButton()!.click()
      expect(document.querySelector('.editor-inline-ai')).not.toBeNull()
      const outsideClick = vi.fn()
      host.addEventListener('click', outsideClick)
      expect(host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))).toBe(true)
      expect(document.querySelector('.editor-inline-ai')).toBeNull()
      host.click()
      expect(outsideClick).toHaveBeenCalledOnce()
    } finally {
      native.mockRestore()
      focus.mockRestore()
    }
  } finally {
    dispose()
    host.remove()
    for (const mock of [...mocks, send]) mock.mockRestore()
  }
})

it('keeps a block-menu item mounted and applies it to the block where the menu opened', () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  let mounted!: EditorHandle
  const dispose = render(() => createComponent(EditorShell, {
    markdown: 'paragraph\n\nsecond', onReady: (value) => { mounted = value }, onUpdate: vi.fn(),
  }), host)
  try {
    const { view } = mounted.editor
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 1, inside: 0 })
    view.dom.querySelector('p')!.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true }))
    const item = [...document.querySelectorAll<HTMLButtonElement>('.block-menu-item')]
      .find((button) => button.textContent?.includes('一级标题'))!
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }))
    const scroll = host.querySelector('.editor-scroll')!
    scroll.dispatchEvent(new Event('scroll'))
    expect(item.isConnected).toBe(true)
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 }))
    scroll.dispatchEvent(new Event('scroll'))
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.firstChild!.nodeSize + 1)))
    expect(item.isConnected).toBe(true)
    item.click()
    expect(mounted.toMarkdown()).toBe('# paragraph\n\nsecond')
  } finally {
    dispose()
    host.remove()
  }
})

it('keeps the toolbar after formatting so AI edit and block conversion can follow', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  let mounted!: EditorHandle
  const dispose = render(() => createComponent(EditorShell, {
    markdown: 'example', onReady: (value) => { mounted = value }, onUpdate: vi.fn(), inlineAi: true,
  }), host)
  const { view } = mounted.editor
  const focus = vi.spyOn(view, 'hasFocus').mockReturnValue(true)
  const coords = vi.spyOn(view, 'coordsAtPos').mockImplementation((pos) =>
    pos === 1 ? { left: 20, right: 20, top: 60, bottom: 80 } : { left: 100, right: 100, top: 104, bottom: 124 })
  const menu = () => document.querySelector<HTMLElement>('.editor-selection-menu')!
  const open = () => {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8, 1)))
    const paragraph = view.dom.querySelector('p')!
    const text = paragraph.querySelector('u')?.firstChild ?? paragraph.firstChild
    const native = vi.spyOn(window, 'getSelection').mockReturnValue({ anchorNode: text, focusNode: text, rangeCount: 1, isCollapsed: false,
      getRangeAt: () => ({ getClientRects: () => [new DOMRect(20, 60, 80, 20)] }),
    } as unknown as globalThis.Selection)
    try {
      paragraph.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: 40, clientY: 70 }))
    } finally { native.mockRestore() }
  }
  try {
    open()
    expect(menu().lastElementChild?.textContent).toContain('使用 AI 编辑')
    expect(menu().textContent).not.toMatch(/评论|技能/)
    const toolbar = menu()
    const aiButton = toolbar.querySelector<HTMLButtonElement>('.selection-toolbar-ai')!
    vi.spyOn(host.querySelector('.editor-scroll')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(80, 40, 650, 400))
    const underline = toolbar.querySelector<HTMLButtonElement>('[aria-label="下划线"]')!
    underline.click()
    expect(mounted.toMarkdown()).toBe('<u>example</u>')
    expect(menu()).toBe(toolbar)
    expect(underline.getAttribute('aria-pressed')).toBe('true')

    const bold = toolbar.querySelector<HTMLButtonElement>('[aria-label="粗体"]')!
    bold.click()
    expect(menu()).toBe(toolbar)
    expect(bold.getAttribute('aria-pressed')).toBe('true')
    const italic = toolbar.querySelector<HTMLButtonElement>('[aria-label="斜体"]')!
    for (const button of [italic, bold, italic, bold]) button.click()
    expect(bold.getAttribute('aria-pressed')).toBe('true')
    expect(italic.getAttribute('aria-pressed')).toBe('false')
    expect(mounted.editor.state.selection.anchor).toBe(8)
    expect(mounted.editor.state.selection.head).toBe(1)
    expect(menu().querySelector('.selection-toolbar-ai')).toBe(aiButton)
    const formatted = mounted.toMarkdown()
    aiButton.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 110, clientY: 190 }))
    const input = document.querySelector<HTMLTextAreaElement>('[aria-label="修改要求"]')!
    expect(input).not.toBeNull()
    const panel = input.closest<HTMLElement>('.editor-inline-ai')!
    expect(panel.style.top).toBe('130px')
    expect(panel.style.left).toBe('80px')
    expect(panel.style.width).toBe('650px')
    const repeat = { bubbles: true, cancelable: true, detail: 2, clientX: 113, clientY: 191 }
    expect(host.dispatchEvent(new PointerEvent('pointerdown', repeat))).toBe(false)
    expect(host.dispatchEvent(new MouseEvent('click', repeat))).toBe(false)
    expect(input.isConnected).toBe(true)
    expect(document.activeElement).toBe(input)
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    host.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    vi.spyOn(panel, 'offsetHeight', 'get').mockReturnValue(44)
    coords.mockReturnValue({ left: 100, right: 100, top: 550, bottom: 570 })
    window.dispatchEvent(new Event('resize'))
    await vi.waitFor(() => expect(panel.style.top).toBe('500px'))
    expect(input.isConnected).toBe(true)
    expect(mounted.toMarkdown()).toBe(formatted)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    open()
    menu().querySelector<HTMLButtonElement>('[aria-label="粗体"]')!.click()
    expect(mounted.toMarkdown()).toBe('<u>example</u>')
    menu().querySelector<HTMLButtonElement>('[aria-label="转换区块"]')!.click()
    const blocks = menu().querySelector('[aria-label="区块类型"]')!
    const fold = [...blocks.querySelectorAll('button')].find((button) => button.textContent?.includes('折叠标题 2'))!
    fold.click()
    const folded = view.dom.querySelector('.editor-fold-block')!
    const heading = folded.querySelector('h2')!
    const toggle = folded.querySelector('button')!
    expect(heading.textContent).toBe('example')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    toggle.click()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(folded.hasAttribute('data-folded')).toBe(true)
    expect(mounted.toMarkdown()).toContain('## <u>example</u>')
  } finally {
    focus.mockRestore()
    dispose()
    host.remove()
  }
})

it.each([
  { label: 'paragraph', block: 'first', inside: 0 },
  { label: 'code block', block: '```js\nconsole.log(1)\n```', inside: 0 },
  { label: 'display formula', block: '$$a+b$$', inside: 1 },
])('moves a $label from its gutter handle and keeps the move undoable', ({ block, inside }) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  let mounted!: EditorHandle
  const dispose = render(() => createComponent(EditorShell, {
    markdown: `${block}\n\nsecond\n\nthird`,
    onReady: (value) => { mounted = value }, onUpdate: vi.fn(),
  }), host)
  try {
    const view = mounted.editor.view
    const original = mounted.toMarkdown()
    const scroll = host.querySelector('.editor-scroll')!
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 280, 220))
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 100))
    vi.spyOn(view.nodeDOM(0) as HTMLElement, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 30))
    const last = view.state.doc.lastChild!
    const lastPos = view.state.doc.content.size - last.nodeSize
    vi.spyOn(view.nodeDOM(lastPos) as HTMLElement, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 85, 200, 30))
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 2, inside })
    scroll.dispatchEvent(new MouseEvent('mousedown', { clientX: 15, clientY: 35, bubbles: true }))
    expect(view.state.selection).toBeInstanceOf(NodeSelection)
    const grip = document.querySelector<HTMLButtonElement>('.editor-block-grip')!
    Object.defineProperty(grip, 'setPointerCapture', { value: vi.fn() })
    const pointer = (type: string, clientY: number) => grip.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerType: 'mouse', pointerId: 1, button: 0, clientX: 16, clientY,
    }))
    pointer('pointerdown', 35)
    pointer('pointermove', 160)
    expect(document.querySelector('.editor-block-drop')).not.toBeNull()
    pointer('pointercancel', 160)
    expect(document.querySelector('.editor-block-drop')).toBeNull()
    expect(mounted.toMarkdown()).toBe(original)
    pointer('pointerdown', 35)
    pointer('pointermove', 41)
    pointer('pointerup', 41)
    grip.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(document.querySelector('.block-menu-popup')).not.toBeNull()
    pointer('pointerdown', 35)
    pointer('pointermove', 160)
    pointer('pointerup', 160)
    expect(mounted.toMarkdown()).toBe(`second\n\nthird\n\n${original.split('\n\n')[0]}`)
    expect(mounted.editor.commands.undo()).toBe(true)
    expect(mounted.toMarkdown()).toBe(original)
  } finally {
    dispose()
    host.remove()
  }
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

  it('places the caret from the right page gutter without changing document content', () => {
    const { handle, onUpdate } = mount()
    const view = handle.editor.view
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 200))
    const posAtCoords = vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 })
    scrollRoot!.dispatchEvent(new MouseEvent('mousedown', { clientX: 255, clientY: 35, bubbles: true }))
    expect(posAtCoords).toHaveBeenCalledWith({ left: 239, top: 35 })
    expect(view.state.selection.head).toBe(2)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('selects a single task from the left gutter, including in a grouped document', () => {
    const { handle, onUpdate } = mount()
    handle.loadBlocks([{
      type: 'bulletList',
      content: ['first', 'second', 'third'].map((text) => ({
        type: 'listItem', attrs: { checked: false },
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      })),
    }], true)
    const view = handle.editor.view
    let targetPos = 0
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'listItem' && node.textContent === 'second') targetPos = pos
    })
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 200))
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: targetPos + 2, inside: targetPos + 1 })
    scrollRoot!.dispatchEvent(new MouseEvent('mousedown', { clientX: 15, clientY: 65, bubbles: true }))
    const selection = view.state.selection as NodeSelection
    expect(selection).toBeInstanceOf(NodeSelection)
    expect(selection.from).toBe(targetPos)
    expect(selection.node.textContent).toBe('second')
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('accepts a click with slight movement inside a task checkbox', () => {
    const { handle, element } = mount()
    handle.loadMarkdown('- [ ] first')
    const button = element.querySelector<HTMLButtonElement>('[data-task-toggle]')!
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 40 }))
    button.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 46, buttons: 1 }))
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 46 }))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 46, detail: 1 }))
    expect(element.querySelector('[data-task-toggle]')?.getAttribute('aria-checked')).toBe('true')
  })

  it('selects whole rows from a left-gutter drag and clears the selection on one click in the text', () => {
    const { handle, element } = mount()
    handle.loadMarkdown('- [ ] first\n- [x] second\n- [ ] third')
    const view = handle.editor.view
    const { doc } = view.state
    const items: number[] = []
    doc.descendants((node, pos) => {
      if (node.type.name === 'listItem') items.push(pos)
    })
    const rows = () => Array.from(element.querySelectorAll('li[data-list-row-selected]'), (item) => item.textContent)
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 200))
    const point = vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: items[0] + 2, inside: items[0] })
    scrollRoot!.dispatchEvent(new MouseEvent('mousedown', { clientX: 15, clientY: 35, bubbles: true, cancelable: true }))
    point.mockReturnValue({ pos: items[2] + 3, inside: items[2] })
    document.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: 15, clientY: 95, bubbles: true }))
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 15, clientY: 95, bubbles: true }))
    expect(view.state.selection).toBeInstanceOf(ListRowsSelection)
    expect(rows()).toEqual(['first', 'second', 'third'])
    const third = view.dom.querySelectorAll('li p')[2]
    third.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }))
    expect(rows()).toEqual(['first', 'second', 'third'])
    third.dispatchEvent(new MouseEvent('mousedown', { clientX: 75, clientY: 95, bubbles: true }))
    third.dispatchEvent(new MouseEvent('mouseup', { clientX: 75, clientY: 95, bubbles: true }))
    third.dispatchEvent(new MouseEvent('click', { detail: 1, clientX: 75, clientY: 95, bubbles: true }))
    expect(view.state.selection.empty).toBe(true)
    expect(view.state.selection.from).toBe(items[2] + 3)
    expect(rows()).toEqual([])
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, items[0] + 3, items[2] + 3)))
    expect(rows()).toEqual([])
  })

  it('paints text ranges alone when dragging through tasks on the text side', () => {
    const highlight = new Map<string, Set<globalThis.Range>>()
    vi.stubGlobal('Highlight', class extends Set<globalThis.Range> {})
    vi.stubGlobal('CSS', { highlights: highlight })
    try {
      const { handle, element } = mount()
      handle.loadMarkdown('Intro\n\n- [ ] first\n- [x] sec`on`d\n- [ ] third')
      const view = handle.editor.view
      const starts: number[] = []
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'listItem') starts.push(pos + 2)
      })
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, starts[2] + 2)))
      const ranges = Array.from(highlight.values())[0]
      expect(Array.from(ranges, (range) => range.toString())).toEqual(['ntro', 'first', 'sec', 'on', 'd', 'th'])
      expect(Array.from(ranges).every((range) =>
        range.startContainer instanceof Text && range.startContainer === range.endContainer)).toBe(true)
      expect(view.dom.hasAttribute('data-list-text-highlights')).toBe(true)
      expect(element.querySelector('[data-list-row-selected]')).toBeNull()
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, starts[2] + 2, 2)))
      expect(Array.from(highlight.values())[0].size).toBe(ranges.size)
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, starts[0])))
      expect(highlight.size).toBe(0)
      expect(view.dom.hasAttribute('data-list-text-highlights')).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('uses clipped text rectangles when custom highlights are unavailable', async () => {
    vi.stubGlobal('Highlight', undefined)
    const rects = vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([
      new DOMRect(34, 20, 24, 15),
    ] as unknown as DOMRectList)
    try {
      const { handle } = mount()
      handle.loadMarkdown('- [ ] first\n- [ ] second')
      const view = handle.editor.view
      vi.spyOn(scrollRoot!, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 0, 200, 80))
      vi.spyOn(scrollRoot!, 'clientWidth', 'get').mockReturnValue(200)
      vi.spyOn(scrollRoot!, 'clientHeight', 'get').mockReturnValue(80)
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4, 16)))
      const layer = scrollRoot!.querySelector('.editor-list-selection-layer')!
      await vi.waitFor(() => expect(layer.children).toHaveLength(2))
      expect(view.dom.hasAttribute('data-list-text-highlights')).toBe(true)
      expect((layer.firstElementChild as HTMLElement).style.left).toBe('40px')
      expect((layer.firstElementChild as HTMLElement).style.width).toBe('18px')
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4)))
      expect(layer.children).toHaveLength(0)
      expect(view.dom.hasAttribute('data-list-text-highlights')).toBe(false)
    } finally {
      rects.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it.each([
    { markdown: '```js\nconsole.log(1)\n```', type: 'codeBlock', inside: 0 },
    { markdown: '$$a+b$$', type: 'paragraph', inside: 1 },
  ])('selects $markdown as a whole from its left edge', ({ markdown, type, inside }) => {
    const { handle } = mount()
    handle.loadMarkdown(`${markdown}\n\nnext`)
    const view = handle.editor.view
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 200))
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: view.state.doc.content.size - 2, inside })
    scrollRoot!.dispatchEvent(new MouseEvent('mousedown', { clientX: 15, clientY: 35, bubbles: true }))
    const selection = view.state.selection as NodeSelection
    expect(selection).toBeInstanceOf(NodeSelection)
    expect(selection.from).toBe(0)
    expect(selection.node.type.name).toBe(type)
  })

  it('collapses an ordinary click inside selected text to the clicked position', () => {
    const { handle, onUpdate } = mount()
    handle.loadMarkdown('onebox sample text')
    const view = handle.editor.view
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 14)))
    const click = (position: number, options?: MouseEventInit) =>
      view.someProp('handleClick', (handler) => handler(view, position, new MouseEvent('mouseup', options)))
    expect(click(6, { shiftKey: true })).toBeUndefined()
    expect(click(6, { button: 2 })).toBeUndefined()
    expect(view.state.selection.empty).toBe(false)
    expect(click(6)).toBe(true)
    expect(view.state.selection.from).toBe(6)
    expect(view.state.selection.empty).toBe(true)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('keeps the native text selection when the drag release also fires a click', () => {
    const { handle } = mount()
    handle.loadMarkdown('onebox sample text')
    const view = handle.editor.view
    const paragraph = view.dom.querySelector('p')!
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 7, inside: 0 })
    paragraph.dispatchEvent(new MouseEvent('mousedown', { clientX: 50, clientY: 30, bubbles: true }))
    paragraph.dispatchEvent(new MouseEvent('mousemove', { clientX: 80, clientY: 30, bubbles: true, buttons: 1 }))
    // Window selection geometry is supplied by the native browser during this gesture.
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 7)))
    paragraph.dispatchEvent(new MouseEvent('mouseup', { clientX: 80, clientY: 30, bubbles: true }))
    paragraph.dispatchEvent(new MouseEvent('click', { detail: 1, clientX: 80, clientY: 30, bubbles: true }))
    expect(view.state.selection.from).toBe(1)
    expect(view.state.selection.to).toBe(7)
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

  it('selects the visually nearer block when a left gutter click lands between blocks', () => {
    const { handle } = mount()
    handle.loadMarkdown('first\n\nsecond')
    const view = handle.editor.view
    const gap = view.state.doc.firstChild!.nodeSize
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 100))
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: gap, inside: -1 })
    vi.spyOn(view, 'coordsAtPos').mockImplementation((pos) => pos < gap
      ? { left: 50, right: 50, top: 20, bottom: 38 } : { left: 40, right: 40, top: 62, bottom: 80 })
    scrollRoot!.dispatchEvent(new MouseEvent('mousedown', { clientX: 15, clientY: 56, bubbles: true }))
    expect(view.state.selection).toBeInstanceOf(NodeSelection)
    expect((view.state.selection as NodeSelection).node.textContent).toBe('second')
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

  it('inserts a paragraph between adjacent code blocks only when their gap is clicked', () => {
    const { handle, element } = mount()
    handle.loadMarkdown('```js\na\n```\n\n```js\nb\n```')
    const { view } = handle.editor
    expect(view.state.doc.childCount).toBe(2)
    const gap = element.querySelector<HTMLButtonElement>('.code-continue')!
    expect(gap.tabIndex).toBe(-1)
    gap.click()
    expect(view.state.doc.childCount).toBe(3)
    expect(view.state.doc.child(1).type.name).toBe('paragraph')
    expect(view.state.selection.$head.parent).toBe(view.state.doc.child(1))
  })

  it('keeps editor-only code and table controls outside exported content', () => {
    const { handle, element } = mount()
    handle.loadMarkdown('> ```python\n> print("hello")\n> ```')

    const code = element.querySelector('.code-frame')!
    expect(code.querySelector<HTMLButtonElement>('.code-language')?.dataset.languageId).toBe('python')
    expect(code.querySelector('pre > code')?.textContent).toBe('print("hello")')
    expect(code.querySelector('pre > code')?.getAttribute('spellcheck')).toBe('false')
    expect(handle.editor.view.dom.getAttribute('autocorrect')).toBe('off')
    expect(code.querySelector('.code-copy')?.getAttribute('aria-label')).toBe('复制代码')
    expect(code.querySelector('.code-next')?.getAttribute('aria-label')).toBe('在代码块后继续写正文')
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
    const edit = frame.querySelector<HTMLButtonElement>('.code-toolbar .code-actions button[aria-expanded]')!
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
    const select = () => element.querySelector<HTMLButtonElement>('.code-language')!
    const choose = (value: string) => {
      select().click()
      const search = document.querySelector<HTMLInputElement>('[aria-label="搜索语言"]')
      if (!search) return
      expect(document.activeElement).toBe(search)
      search.value = value || '纯文本'
      search.dispatchEvent(new Event('input', { bubbles: true }))
      const options = document.querySelectorAll<HTMLButtonElement>('.code-language-options [role="option"]')
      expect(options).toHaveLength(1)
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
    expect(select().dataset.languageId).toBe('custom')
    expect(handle.toMarkdown()).toBe(input)

    handle.editor.setEditable(false, false)
    expect(select().disabled).toBe(true)
    choose('rust')
    expect(handle.toMarkdown()).toBe(input)
    handle.editor.setEditable(true, false)
    expect(select().disabled).toBe(false)

    choose('rust')
    expect(select().dataset.languageId).toBe('rust')
    expect(select().closest('.code-frame')?.getAttribute('data-language')).toBe('rust')
    expect(handle.toMarkdown()).toBe('> ```rust title=demo\n> fn main() {}\n> ```')
    expect(onUpdate).toHaveBeenCalledOnce()
    expect(handle.editor.commands.undo()).toBe(true)
    expect(handle.toMarkdown()).toBe(input)

    choose('')
    expect(select().dataset.languageId).toBe('')
    expect(handle.toMarkdown()).toBe('> ```text title=demo\n> fn main() {}\n> ```')
  })

  it('preserves a pressed language option across search focus loss and editor scrolling', async () => {
    const { handle, element } = mount()
    handle.loadMarkdown('```java\nexample\n```')
    element.querySelector<HTMLButtonElement>('.code-language')!.click()
    const search = document.querySelector<HTMLInputElement>('[aria-label="搜索语言"]')!
    const option = document.querySelector<HTMLButtonElement>('.code-language-options [data-language-id="python"]')!
    option.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }))
    expect(option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))).toBe(false)
    search.blur()
    await Promise.resolve()
    scrollRoot!.dispatchEvent(new Event('scroll'))
    expect(option.isConnected).toBe(true)
    option.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 }))
    scrollRoot!.dispatchEvent(new Event('scroll'))
    expect(option.isConnected).toBe(true)
    option.click()
    expect(handle.toMarkdown()).toBe('```python\nexample\n```')
    const trigger = element.querySelector<HTMLButtonElement>('.code-language')!
    trigger.click()
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }))
    document.querySelector<HTMLInputElement>('[aria-label="搜索语言"]')!.blur()
    await Promise.resolve()
    trigger.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 }))
    trigger.click()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
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
