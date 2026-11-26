import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { CellSelection, tableEditingKey } from '@tiptap/pm/tables'
import { createComponent } from 'solid-js'
import { render } from '@solidjs/web'
import { afterUiEvent } from './uiEvents'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { blockEditCommands, chartCommands, insertCommands, slashTrigger } from '../src/core/blockCommands'
import { createEditor, type EditorHandle } from '../src/core/editor'
import { enableButtonClickTolerance } from '../src/core/buttonClickTolerance'
import { visibilityKey } from '../src/core/viewport/visibility'
import EditorShell from '../src/ui/EditorShell'
import { ai, type AiEvent } from '../src/io/ai'

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

function clickEditorGutter(clientX: number, clientY: number) {
  for (const type of ['mousedown', 'mouseup']) {
    afterUiEvent(() => scrollRoot!.dispatchEvent(new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true })))
  }
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
    onUpdate: vi.fn(), onQuoteSelection, inlineAi: true, showSelectionToolbar: true,
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
    const hover = (x: number, buttons = 0) => afterUiEvent(() => paragraph.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerType: 'mouse', clientX: x, clientY: 70, buttons,
    })))
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
        afterUiEvent(() => scroll.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' })))
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
        afterUiEvent(() => button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 })))
        afterUiEvent(() => scroll.dispatchEvent(new Event('scroll')))
        expect(aiButton()).toBe(button)
        afterUiEvent(() => button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 })))
        // A layout event and a native caret update can follow pointerup before click.
        afterUiEvent(() => scroll.dispatchEvent(new Event('scroll')))
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 12)))
        expect(button.isConnected).toBe(true)
        afterUiEvent(() => button.click())
        await vi.waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('修改要求'))
        expect(retryFocus.mock.calls.length).toBeGreaterThan(1)
      } finally { retryFocus.mockRestore() }
      const input = document.querySelector<HTMLTextAreaElement>('[aria-label="修改要求"]')!
      const panel = input.closest<HTMLElement>('.editor-inline-ai')!
      expect(input).not.toBeNull()
      expect(document.activeElement).toBe(input)
      expect(view.state.selection.from).toBe(7)
      input.blur()
      afterUiEvent(() => panel.querySelector('.editor-inline-ai-spark')!.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0,
      })))
      expect(document.activeElement).toBe(input)
      const sendButton = panel.querySelector<HTMLButtonElement>('[aria-label="发送修改要求"]')!
      expect(sendButton.disabled).toBe(true)
      input.value = '   '
      afterUiEvent(() => input.dispatchEvent(new Event('input', { bubbles: true })))
      expect(sendButton.disabled).toBe(true)
      expect(panel.style.left).toBe('56px')
      expect(panel.style.width).toBe('708px')
      expect(panel.style.top).toBe('86px')
      contentBounds.mockReturnValue(new DOMRect(22, 24, 276, 180))
      scrollBounds.mockReturnValue(new DOMRect(0, 0, 320, 220))
      afterUiEvent(() => window.dispatchEvent(new Event('resize')))
      await vi.waitFor(() => expect(panel.style.width).toBe('276px'))
      expect(panel.style.left).toBe('22px')
      expect(document.querySelector('.editor-inline-ai-dismiss')).toBeNull()
      expect(onQuoteSelection).not.toHaveBeenCalled()
      expect(menu()).toBeNull()
      input.value = '改为 Onebox'
      afterUiEvent(() => input.dispatchEvent(new Event('input', { bubbles: true })))
      expect(sendButton.disabled).toBe(false)
      afterUiEvent(() => sendButton.click())
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
      afterUiEvent(() => receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } }))
      expect(document.querySelector('.editor-inline-ai-loading')).toBeNull()
      expect(document.querySelector('[aria-label="确认修改"]')).not.toBeNull()
      expect(panel.style.width).toBe('276px')
      expect(view.dom.querySelector('.editor-ai-added')?.textContent).toBe('O')
      expect(view.dom.querySelector('.editor-ai-removed')?.textContent).toBe('o')
      expect(mounted.toMarkdown()).toBe('onebox sample text')
      afterUiEvent(() => host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
      expect(view.dom.querySelector('.editor-ai-added')?.textContent).toBe('O')
      afterUiEvent(() => document.querySelector<HTMLButtonElement>('.editor-inline-ai-apply')!.click())
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
        afterUiEvent(() => scroll.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, pointerType: 'mouse', clientX: 87, clientY: 75, button: 0,
        })))
        await vi.waitFor(() => expect(menu()).not.toBeNull())
      } finally { restoredNative.mockRestore() }
      afterUiEvent(() => aiButton()!.click())
      expect(document.querySelector('.editor-inline-ai')).not.toBeNull()
      const outsideClick = vi.fn()
      host.addEventListener('click', outsideClick)
      expect(afterUiEvent(() => host.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, isPrimary: true,
      })))).toBe(true)
      expect(document.querySelector('.editor-inline-ai')).toBeNull()
      afterUiEvent(() => host.click())
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
    afterUiEvent(() => view.dom.querySelector('p')!.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true })))
    const item = [...document.querySelectorAll<HTMLButtonElement>('.block-menu-item')]
      .find((button) => button.textContent?.includes('一级标题'))!
    afterUiEvent(() => item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 })))
    const scroll = host.querySelector('.editor-scroll')!
    afterUiEvent(() => scroll.dispatchEvent(new Event('scroll')))
    expect(item.isConnected).toBe(true)
    afterUiEvent(() => item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 })))
    afterUiEvent(() => scroll.dispatchEvent(new Event('scroll')))
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.firstChild!.nodeSize + 1)))
    expect(item.isConnected).toBe(true)
    afterUiEvent(() => item.click())
    expect(mounted.toMarkdown()).toBe('# paragraph\n\nsecond')
  } finally {
    dispose()
    host.remove()
  }
})

it('identifies the current heading independently of right-click menu navigation', () => {
  const host = document.createElement('div')
  document.body.append(host)
  let mounted!: EditorHandle
  const dispose = render(() => createComponent(EditorShell, {
    markdown: '### 标题', onReady: (value) => { mounted = value }, onUpdate: vi.fn(),
  }), host)
  try {
    const { view } = mounted.editor
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 })
    afterUiEvent(() => view.dom.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true })))
    const headings = Array.from(document.querySelectorAll('[role="option"]'))
      .filter((option) => /^H[1-6]/u.test(option.textContent ?? ''))
    expect(headings.map((option) => option.querySelector('.block-menu-icon')?.textContent)).toEqual(['H1', 'H2', 'H3', 'H4', 'H5'])
    expect(headings.every((option) => !option.querySelector('kbd'))).toBe(true)
    const current = document.querySelector('[role="option"][aria-current="true"]')!
    expect(current.textContent).toContain('三级标题')
    expect(current.querySelector('.block-menu-check')?.textContent).toBe('✓')
    expect(current.getAttribute('aria-selected')).toBe('true')
    afterUiEvent(() => view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
    expect(current.getAttribute('aria-current')).toBe('true')
    expect(current.getAttribute('aria-selected')).toBe('false')
  } finally {
    dispose()
    host.remove()
  }
})

it('opens the existing AI box from the compact context menu using the original selection', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const events = vi.spyOn(ai, 'events').mockResolvedValue(() => {})
  const onQuoteSelection = vi.fn()
  let mounted!: EditorHandle
  const dispose = render(() => createComponent(EditorShell, {
    markdown: 'example paragraph', onReady: (value) => { mounted = value },
    onUpdate: vi.fn(), onQuoteSelection, inlineAi: true,
  }), host)
  try {
    const { view } = mounted.editor
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 })
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 20, right: 80, top: 60, bottom: 80 })
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(32, 16, 600, 160))
    vi.spyOn(host.querySelector('.editor-scroll')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 700, 240))
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 8)))
    afterUiEvent(() => view.dom.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true })))
    const menu = document.querySelector('.block-menu-compact')!
    expect(menu.textContent).toContain('引用到侧栏')
    expect(menu.textContent).not.toMatch(/区块操作|复制区块|删除区块/)
    const aiIcons = menu.querySelectorAll('[aria-label="AI"] .block-menu-icon svg path')
    expect(aiIcons).toHaveLength(2)
    expect(aiIcons[0].getAttribute('d')).not.toBe(aiIcons[1].getAttribute('d'))
    const edit = Array.from(menu.querySelectorAll('button')).find((button) => button.textContent?.includes('正文编辑'))!
    afterUiEvent(() => edit.click())
    expect(document.querySelector('.block-menu-popup')).toBeNull()
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('修改要求'))
    expect(view.dom.querySelector('.editor-ai-source')?.textContent).toBe('example')
  } finally {
    dispose()
    host.remove()
    events.mockRestore()
  }
})

it('applies inline formats to selected text from the context menu', () => {
  const host = document.createElement('div')
  document.body.append(host)
  let mounted!: EditorHandle
  const dispose = render(() => createComponent(EditorShell, {
    markdown: 'before example after', onReady: (value) => { mounted = value }, onUpdate: vi.fn(), onQuoteSelection: vi.fn(),
  }), host)
  try {
    const { view } = mounted.editor
    vi.spyOn(host.querySelector('.editor-scroll')!, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 700, 240))
    const point = vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 })
    const rightClick = () => afterUiEvent(() => view.dom.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2, clientX: 90, clientY: 60,
    })))
    const group = () => document.querySelector('[role="group"][aria-label="行内格式"]')
    const buttons = () => Array.from(group()!.querySelectorAll<HTMLButtonElement>('[role="option"]'))
    rightClick()
    expect(group()).toBeNull()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8, 15)))
    point.mockReturnValue({ pos: 9, inside: 0 })
    expect(document.querySelector('.editor-selection-menu')).toBeNull()
    rightClick()
    expect(Array.from(document.querySelectorAll('.block-menu-results [role="group"]'), (el) => el.getAttribute('aria-label')).slice(0, 3))
      .toEqual(['AI', '行内格式', '转换区块'])
    expect(buttons().map((button) => button.title)).toEqual(['高亮', '粗体', '斜体', '下划线', '删除线'])
    afterUiEvent(() => buttons()[1].click())
    expect(mounted.toMarkdown()).toBe('before **example** after')
    expect(buttons()[1].getAttribute('aria-label')).toBe('粗体，已应用')
    afterUiEvent(() => buttons()[1].click())
    expect(mounted.toMarkdown()).toBe('before example after')
    afterUiEvent(() => buttons()[0].click())
    expect(mounted.toMarkdown()).toBe('before <mark>example</mark> after')
    afterUiEvent(() => view.dom.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })))
    expect(group()).toBeNull()
  } finally {
    dispose()
    host.remove()
  }
})

it('opens slash commands for typed slash and never from a caret placed beside existing text', () => {
  const host = document.createElement('div')
  document.body.append(host)
  let mounted!: EditorHandle
  const dispose = render(() => createComponent(EditorShell, {
    markdown: 'Existing `/`，example\n\nNew ', onReady: (value) => { mounted = value }, onUpdate: vi.fn(),
  }), host)
  try {
    const { view } = mounted.editor
    view.focus()
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 20, right: 20, top: 60, bottom: 80 })
    const menu = () => document.querySelector('.block-menu-popup')
    const setCaret = (pos: number) => afterUiEvent(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos))))
    // Place the caret both after the existing slash and at the end of its surrounding text.
    setCaret('Existing /'.length + 1)
    setCaret(view.state.doc.firstChild!.nodeSize - 1)
    expect(menu()).toBeNull()
    const from = view.state.doc.firstChild!.nodeSize + 1
    setCaret(from)
    view.dispatch(view.state.tr.insertText('/table'))
    expect(menu()).toBeNull()
    view.dispatch(view.state.tr.delete(from, view.state.selection.from))
    afterUiEvent(() => view.someProp('handleTextInput', (input) => input(view, from, from, '/', () => view.state.tr.insertText('/'))))
    expect(menu()?.querySelector('.block-menu-query')).not.toBeNull()
    afterUiEvent(() => view.dispatch(view.state.tr.insertText('table')))
    expect(menu()?.querySelector('.block-menu-query')?.textContent).toBe('/table')
    setCaret(1)
    expect(menu()).toBeNull()
    setCaret(from + '/table'.length)
    expect(menu()).toBeNull()
  } finally {
    dispose()
    host.remove()
  }
})

it('keeps the slash menu open while browsing and selecting a chart', () => {
  const host = document.createElement('div')
  document.body.append(host)
  let mounted!: EditorHandle
  const dispose = render(() => createComponent(EditorShell, {
    markdown: '', onReady: (value) => { mounted = value }, onUpdate: vi.fn(),
  }), host)
  try {
    const { view } = mounted.editor
    view.focus()
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 20, right: 20, top: 60, bottom: 80 })
    afterUiEvent(() => view.someProp('handleTextInput', (input) => input(view, 1, 1, '/', () => view.state.tr.insertText('/'))))
    const parent = document.querySelector('[aria-label="区块命令"]')!
    const openGroup = () => afterUiEvent(() => parent.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!.click())
    const menu = () => document.querySelector('[role="listbox"][aria-label="ECharts 图表"]')
    const press = (key: string) => afterUiEvent(() => view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
    openGroup()
    const icons = Array.from(menu()!.querySelectorAll('.block-menu-icon svg path'), (icon) => icon.getAttribute('d'))
    expect(icons).toHaveLength(chartCommands.length)
    expect(new Set(icons).size).toBe(chartCommands.length)
    expect(parent.textContent).toContain('Mermaid 图')
    expect(menu()?.textContent).not.toMatch(/Mermaid|流程图/)
    press('Escape')
    afterUiEvent(() => view.dispatch(view.state.tr.insertText('折线图')))
    openGroup()
    expect(parent.isConnected).toBe(true)
    expect(menu()?.querySelectorAll('[role="option"]')).toHaveLength(1)
    press('Escape')
    expect(parent.isConnected).toBe(true)
    expect(menu()).toBeNull()
    press('ArrowRight')
    press('Enter')
    expect(mounted.toMarkdown()).toContain('echarts')
    expect(mounted.toMarkdown()).not.toContain('/折线图')
    expect(parent.isConnected).toBe(false)
  } finally {
    dispose()
    host.remove()
  }
})

it('reads pasted image files from clipboard items and captures the insertion range', () => {
  const host = document.createElement('div')
  document.body.append(host)
  let mounted!: EditorHandle
  const onInsertFiles = vi.fn()
  const dispose = render(() => createComponent(EditorShell, {
    markdown: 'text', onReady: (value) => { mounted = value }, onUpdate: vi.fn(), onInsertFiles,
  }), host)
  try {
    const { view } = mounted.editor
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 4)))
    const file = new File(['bytes'], 'clipboard', { type: 'image/png' })
    const event = {
      clipboardData: { files: [], items: [{ kind: 'file', getAsFile: () => file }] },
    } as unknown as ClipboardEvent
    expect(view.someProp('handlePaste', (paste) => paste(view, event, view.state.selection.content()))).toBe(true)
    expect(onInsertFiles).toHaveBeenCalledWith([file], { from: 2, to: 4 })
  } finally {
    dispose()
    host.remove()
  }
})

it.each([
  ['hides the floating toolbar by default', undefined],
  ['keeps the enabled toolbar open across formatting and block conversion', true],
] as const)('%s', async (_label, showSelectionToolbar) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  let mounted!: EditorHandle
  const dispose = render(() => createComponent(EditorShell, {
    markdown: 'example', onReady: (value) => { mounted = value }, onUpdate: vi.fn(), inlineAi: true, showSelectionToolbar,
  }), host)
  const { view } = mounted.editor
  const stopMouse = enableButtonClickTolerance(document)
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
      afterUiEvent(() => paragraph.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: 40, clientY: 70 })))
    } finally { native.mockRestore() }
  }
  try {
    open()
    if (!showSelectionToolbar) {
      expect(menu()).toBeNull()
      expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe('example')
      return
    }
    expect(menu().lastElementChild?.textContent).toContain('使用 AI 编辑')
    expect(menu().textContent).not.toMatch(/评论|技能/)
    const toolbar = menu()
    const aiButton = toolbar.querySelector<HTMLButtonElement>('.selection-toolbar-ai')!
    vi.spyOn(host.querySelector('.editor-scroll')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(80, 40, 650, 400))
    const underline = toolbar.querySelector<HTMLButtonElement>('[aria-label="下划线"]')!
    afterUiEvent(() => underline.click())
    expect(mounted.toMarkdown()).toBe('<u>example</u>')
    expect(menu()).toBe(toolbar)
    expect(underline.getAttribute('aria-pressed')).toBe('true')

    const bold = toolbar.querySelector<HTMLButtonElement>('[aria-label="粗体"]')!
    afterUiEvent(() => bold.click())
    expect(menu()).toBe(toolbar)
    expect(bold.getAttribute('aria-pressed')).toBe('true')
    const italic = toolbar.querySelector<HTMLButtonElement>('[aria-label="斜体"]')!
    for (const button of [italic, bold, italic, bold]) afterUiEvent(() => button.click())
    expect(bold.getAttribute('aria-pressed')).toBe('true')
    expect(italic.getAttribute('aria-pressed')).toBe('false')
    expect(mounted.editor.state.selection.anchor).toBe(8)
    expect(mounted.editor.state.selection.head).toBe(1)
    expect(menu().querySelector('.selection-toolbar-ai')).toBe(aiButton)
    const mouse = (target: HTMLElement, type: string, x: number, y: number, timeStamp: number) => {
      const event = new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, pointerId: 1,
        pointerType: 'mouse', button: 0, clientX: x, clientY: y, detail: type === 'click' ? 1 : 0 })
      Object.defineProperty(event, 'timeStamp', { value: timeStamp })
      return afterUiEvent(() => target.dispatchEvent(event))
    }
    mouse(italic, 'pointerup', 74, 93, 101)
    mouse(italic, 'click', 74, 93, 101)
    mouse(italic, 'pointerdown', 70, 90, 100)
    expect(italic.getAttribute('aria-pressed')).toBe('true')
    expect(view.dom.querySelector('em')?.textContent).toBe('example')
    const formatted = mounted.toMarkdown()
    mouse(aiButton, 'pointerdown', 107, 187, 200)
    mouse(italic, 'click', 74, 93, 101)
    expect(mounted.toMarkdown()).toBe(formatted)
    mouse(aiButton, 'pointerup', 110, 190, 201)
    // WebKit may target the editor once the original AI button has disappeared.
    expect(mouse(host, 'click', 110, 190, 201)).toBe(false)
    const input = document.querySelector<HTMLTextAreaElement>('[aria-label="修改要求"]')!
    expect(input).not.toBeNull()
    const panel = input.closest<HTMLElement>('.editor-inline-ai')!
    expect(panel.style.top).toBe('130px')
    expect(panel.style.left).toBe('80px')
    expect(panel.style.width).toBe('650px')
    expect(input.isConnected).toBe(true)
    expect(document.activeElement).toBe(input)
    mouse(input, 'pointerdown', 102, 135, 205)
    mouse(input, 'pointerup', 102, 135, 206)
    mouse(host, 'click', 102, 135, 206)
    vi.spyOn(panel, 'offsetHeight', 'get').mockReturnValue(44)
    coords.mockReturnValue({ left: 100, right: 100, top: 550, bottom: 570 })
    afterUiEvent(() => window.dispatchEvent(new Event('resize')))
    await vi.waitFor(() => expect(panel.style.top).toBe('500px'))
    expect(input.isConnected).toBe(true)
    expect(mounted.toMarkdown()).toBe(formatted)
    // A real next press near the old toolbar location must reach the editor.
    expect(mouse(host, 'pointerdown', 113, 191, 220)).toBe(true)
    expect(mouse(host, 'click', 113, 191, 221)).toBe(true)
    expect(input.isConnected).toBe(false)

    open()
    afterUiEvent(() => menu().querySelector<HTMLButtonElement>('[aria-label="斜体"]')!.click())
    afterUiEvent(() => menu().querySelector<HTMLButtonElement>('[aria-label="粗体"]')!.click())
    expect(mounted.toMarkdown()).toBe('<u>example</u>')
    afterUiEvent(() => menu().querySelector<HTMLButtonElement>('[aria-label="转换区块"]')!.click())
    const blocks = menu().querySelector('[aria-label="区块类型"]')!
    expect(blocks.textContent).not.toContain('折叠')
    const heading = [...blocks.querySelectorAll('button')].find((button) => button.textContent?.includes('二级标题'))!
    afterUiEvent(() => heading.click())
    expect(view.dom.querySelector('h2')?.textContent).toBe('example')
    expect(mounted.toMarkdown()).toContain('## <u>example</u>')
  } finally {
    stopMouse()
    focus.mockRestore()
    dispose()
    host.remove()
  }
})

it('opens the explicit context menu without selecting the block or showing a drag handle', () => {
  const host = document.createElement('div')
  document.body.append(host)
  let mounted!: EditorHandle
  const dispose = render(() => createComponent(EditorShell, {
    showSelectionToolbar: true,
    markdown: 'first\n\nsecond', onReady: (value) => { mounted = value }, onUpdate: vi.fn(),
  }), host)
  vi.useFakeTimers()
  try {
    const { view } = mounted.editor
    const scroll = host.querySelector('.editor-scroll')!
    const toolbar = () => document.querySelector('.editor-selection-menu')
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 100))
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 280, 220))
    vi.spyOn(view, 'hasFocus').mockReturnValue(true)
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 })
    afterUiEvent(() => scroll.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 15, clientY: 35 })))
    expect(view.state.selection.empty).toBe(true)
    afterUiEvent(() => view.dom.querySelector('p')!.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerType: 'mouse', clientX: 50, clientY: 35,
    })))
    afterUiEvent(() => scroll.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 15, clientY: 35 })))
    vi.advanceTimersByTime(40)
    expect(toolbar()).toBeNull()
    afterUiEvent(() => view.dom.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 50, clientY: 35 })))
    expect(document.querySelector('.block-menu-popup')).not.toBeNull()
    expect(view.state.selection.empty).toBe(true)
    expect(document.querySelector('.editor-block-grip')).toBeNull()
    expect(toolbar()).toBeNull()
    const escape = () => afterUiEvent(() => view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    escape()
    expect(document.querySelector('.block-menu-popup')).toBeNull()
    expect(view.state.selection.empty).toBe(true)
  } finally {
    vi.useRealTimers()
    dispose()
    host.remove()
  }
})

describe('createEditor', () => {
  it('selects the image on a lightweight tap without selecting it when the pointer enters', () => {
    const { handle, element, onUpdate } = mount()
    handle.loadMarkdown('![山雾](assets/mountain.jpg)')
    const image = element.querySelector('.editor-image img')!
    const send = (type: string, time: number) => {
      const event = new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0 })
      Object.defineProperty(event, 'timeStamp', { value: time })
      afterUiEvent(() => image.dispatchEvent(event))
    }
    send('pointerover', 50)
    expect(handle.editor.state.selection).not.toBeInstanceOf(NodeSelection)
    send('pointerup', 102)
    send('pointerdown', 101)
    expect(handle.editor.state.selection).toBeInstanceOf(NodeSelection)
    expect(element.querySelector('.editor-image')?.classList.contains('ProseMirror-selectednode')).toBe(true)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('reserves the image dimensions before a resized block remounts', () => {
    const { handle, element, onUpdate } = mount()
    handle.loadMarkdown('![山雾](assets/mountain.jpg)\n\n下一段')
    const { view } = handle.editor
    const original = element.querySelector('.editor-image img')!
    Object.defineProperties(original, {
      naturalWidth: { value: 1200 },
      naturalHeight: { value: 680 },
    })
    original.dispatchEvent(new Event('load'))
    const grip = element.querySelector('[data-side="right"]')!
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    const imageBlock = view.state.doc.firstChild!
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, imageBlock.nodeSize + 1)))
    expect(element.querySelector('.editor-image img')).toBeNull()
    view.dispatch(view.state.tr.setMeta(visibilityKey, { visible: new Set([0]) }))
    const next = element.querySelector('.editor-image img')!
    expect(next).not.toBe(original)
    expect(next.getAttribute('width')).toBe('1200')
    expect(next.getAttribute('height')).toBe('680')
    expect(handle.toMarkdown()).toContain('<!--onebox-image-width:95-->')
    expect(onUpdate).toHaveBeenCalledOnce()
  })

  it('keeps the selected image at its original width when dragging its body', () => {
    const { handle, element, onUpdate } = mount()
    const markdown = '![山雾](assets/mountain.jpg)\n\n后面的段落'
    handle.loadMarkdown(markdown)
    const { view } = handle.editor
    const picture = element.querySelector<HTMLElement>('.editor-image')!
    const image = picture.querySelector('img')!
    vi.spyOn(image.closest('p')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 200))
    const capture = vi.fn()
    Object.defineProperty(image, 'setPointerCapture', { value: capture })
    const pointer = (type: string, clientX: number) => image.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX,
    }))
    image.click()
    expect(view.state.selection).toBeInstanceOf(NodeSelection)
    pointer('pointerdown', 200)
    expect(image.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }))).toBe(false)
    pointer('pointermove', 250)
    expect(picture.hasAttribute('data-resizing')).toBe(false)
    expect(picture.querySelector('.editor-image-ratio')?.textContent).toBe('90%')
    pointer('pointerup', 250)
    expect(capture).not.toHaveBeenCalled()
    expect(view.state.selection).toBeInstanceOf(NodeSelection)
    expect(handle.toMarkdown()).toBe(markdown)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('opens a loaded image in the expanded preview without changing its saved width', () => {
    const { handle, element, onUpdate } = mount()
    const markdown = '![山雾](assets/mountain.jpg)'
    handle.loadMarkdown(markdown)
    const wrapper = element.querySelector<HTMLElement>('.editor-image')!
    const image = wrapper.querySelector('img')!
    const expand = wrapper.querySelector<HTMLButtonElement>('.editor-image-expand')!
    Object.defineProperties(image, { naturalWidth: { value: 1200 }, naturalHeight: { value: 680 } })
    image.dispatchEvent(new Event('load'))

    afterUiEvent(() => expand.click())
    expect(document.querySelector('dialog')).toBeNull()
    afterUiEvent(() => image.click())
    expect(handle.editor.state.selection).toBeInstanceOf(NodeSelection)
    expect(document.querySelector('dialog')).toBeNull()
    afterUiEvent(() => expand.click())
    const preview = document.querySelector('dialog')!
    expect(preview.querySelector('img')?.alt).toBe('山雾')
    expect(preview.open).toBe(true)
    preview.querySelector<HTMLButtonElement>('[aria-label="关闭放大预览"]')!.click()

    expect(document.querySelector('dialog')).toBeNull()
    expect(document.activeElement).toBe(expand)
    expect(wrapper.style.getPropertyValue('--editor-image-width')).toBe('90%')
    expect(handle.toMarkdown()).toBe(markdown)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('resizes a standalone image from its edges and stores one undoable width change', () => {
    const { handle, element, onUpdate } = mount()
    handle.loadMarkdown('![山雾](assets/mountain.jpg)')
    const paragraph = element.querySelector('p[data-standalone-image]')!
    const image = paragraph.querySelector<HTMLElement>('.editor-image')!
    const grip = image.querySelector<HTMLButtonElement>('[data-side="right"]')!
    vi.spyOn(paragraph, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 200))
    Object.defineProperty(grip, 'setPointerCapture', { value: vi.fn() })
    const drag = (type: string, x: number) => afterUiEvent(() => grip.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, cancelable: true, bubbles: true,
    })))
    expect(image.style.getPropertyValue('--editor-image-width')).toBe('90%')
    drag('pointerdown', 475)
    drag('pointermove', 425)
    expect(image.style.getPropertyValue('--editor-image-width')).toBe('70%')
    expect(image.querySelector('.editor-image-ratio')?.textContent).toBe('70%')
    expect(onUpdate).not.toHaveBeenCalled()
    drag('pointerup', 425)
    expect(handle.toMarkdown()).toBe('![山雾](assets/mountain.jpg)<!--onebox-image-width:70-->')
    expect(onUpdate).toHaveBeenCalledOnce()
    expect(handle.editor.commands.undo()).toBe(true)
    expect(image.style.getPropertyValue('--editor-image-width')).toBe('90%')
    expect(handle.toMarkdown()).toBe('![山雾](assets/mountain.jpg)')
    expect(handle.editor.commands.redo()).toBe(true)
    const leftGrip = image.querySelector<HTMLButtonElement>('[data-side="left"]')!
    afterUiEvent(() => leftGrip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })))
    expect(handle.toMarkdown()).toBe('![山雾](assets/mountain.jpg)')
    expect(image.style.getPropertyValue('--editor-image-width')).toBe('90%')
    expect(handle.editor.commands.undo()).toBe(true)
    expect(image.style.getPropertyValue('--editor-image-width')).toBe('70%')
  })

  it.each([false, true])('resets a resized image from two trackpad taps without a dblclick (release first=%s)', (releaseFirst) => {
    const disableClickTolerance = enableButtonClickTolerance(document)
    const { handle, element, onUpdate } = mount()
    const markdown = '![山雾](assets/mountain.jpg)'
    handle.loadMarkdown(markdown + '<!--onebox-image-width:55-->')
    const paragraph = element.querySelector('p[data-standalone-image]')!
    const image = paragraph.querySelector<HTMLElement>('.editor-image')!
    const grip = image.querySelector<HTMLButtonElement>('[data-side="right"]')!
    vi.spyOn(paragraph, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 200))
    const capture = vi.fn()
    Object.defineProperty(grip, 'setPointerCapture', { value: capture })
    const tap = (x: number, time: number) => {
      for (const type of releaseFirst ? ['pointerup', 'pointerdown'] : ['pointerdown', 'pointerup']) {
        const down = type === 'pointerdown'
        const event = new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true,
          pointerType: 'mouse', pointerId: 1, button: 0, buttons: down ? 1 : 0, clientX: x + Number(!down) })
        Object.defineProperty(event, 'timeStamp', { value: time + Number(!down) })
        afterUiEvent(() => grip.dispatchEvent(event))
      }
    }
    try {
      tap(385, 100)
      expect(image.style.getPropertyValue('--editor-image-width')).toBe('55%')
      expect(onUpdate).not.toHaveBeenCalled()
      tap(388, 260)
      expect(handle.toMarkdown()).toBe(markdown)
      expect(image.style.getPropertyValue('--editor-image-width')).toBe('90%')
      expect(image.hasAttribute('data-resizing')).toBe(false)
      expect(capture).toHaveBeenCalledTimes(releaseFirst ? 0 : 2)
      expect(onUpdate).toHaveBeenCalledOnce()
      expect(handle.editor.commands.undo()).toBe(true)
      expect(image.style.getPropertyValue('--editor-image-width')).toBe('55%')
    } finally {
      disableClickTolerance()
    }
  })

  it('renders existing fold markup expanded and preserves it when saving', () => {
    const { handle, element } = mount()
    handle.loadMarkdown('> [!NOTE]-\n>\n> ## 旧标题\n>\n> 旧正文')
    const quote = element.querySelector('blockquote')!
    expect(quote.querySelector('h2')?.textContent).toBe('旧标题')
    expect(quote.querySelector('p')?.textContent).toBe('旧正文')
    expect(element.querySelector('button[aria-expanded]')).toBeNull()
    expect(handle.toMarkdown()).toContain('> [!NOTE]-')
  })

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
    clickEditorGutter(255, 35)
    expect(posAtCoords).toHaveBeenCalledWith({ left: 239, top: 35 })
    expect(view.state.selection.head).toBe(2)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('lets a gutter press become a text selection before placing a caret', () => {
    const { handle } = mount()
    handle.loadMarkdown('- [ ] first\n- [ ] second')
    const { view } = handle.editor
    const [first, second] = Array.from(view.dom.querySelectorAll('li p'))
    const gutter = scrollRoot!
    const press = new MouseEvent('mousedown', { clientX: 250, clientY: 80, bubbles: true, cancelable: true })
    expect(afterUiEvent(() => gutter.dispatchEvent(press))).toBe(true)
    const native = document.getSelection()!
    const range = document.createRange()
    range.setStart(first.firstChild!, 0)
    range.setEnd(second.firstChild!, 3)
    native.removeAllRanges()
    native.addRange(range)
    try {
      afterUiEvent(() => gutter.dispatchEvent(new MouseEvent('mouseup', { clientX: 253, clientY: 80, bubbles: true, cancelable: true })))
      expect(native.isCollapsed).toBe(false)
    } finally { native.removeAllRanges() }
  })

  it.each([false, true])('keeps a new task drag active when the preceding tap is late (early pointerup=%s)', (earlyPointerUp) => {
    const { handle } = mount()
    handle.loadMarkdown('- [ ] first\n- [ ] second')
    const { view } = handle.editor
    const [first, second] = Array.from(view.dom.querySelectorAll('li p'))
    const send = (type: string, timeStamp: number, target: Element, clientY = 35) => {
      const options = { bubbles: true, cancelable: true, button: 0, clientX: 90, clientY, detail: 1 }
      const event = type.startsWith('pointer')
        ? new PointerEvent(type, { ...options, isPrimary: true, pointerType: 'mouse', pointerId: 1 })
        : new MouseEvent(type, options)
      Object.defineProperty(event, 'timeStamp', { value: timeStamp })
      afterUiEvent(() => target.dispatchEvent(event))
      return event
    }
    send('pointerdown', 100, first)
    send('mousedown', 100, first)
    if (earlyPointerUp) send('pointerup', 101, first)
    send('pointerdown', 160, first)
    send('mousedown', 160, first)
    if (!earlyPointerUp) expect(send('pointerup', 101, first).defaultPrevented).toBe(true)
    expect(send('mouseup', 101, first).defaultPrevented).toBe(true)
    expect(send('click', 101, first).defaultPrevented).toBe(true)
    send('pointermove', 170, second, 75)
    const { doc } = view.state
    const range = TextSelection.create(doc, view.posAtDOM(first, 0), view.posAtDOM(second, 0) + 3)
    view.dispatch(view.state.tr.setSelection(range))
    send('pointerup', 180, second, 75)
    send('mouseup', 180, second, 75)
    expect(view.state.selection.eq(range)).toBe(true)
  })

  it('uses the clicked task line end when WebKit maps its right-hand whitespace to the line start', () => {
    const { handle, onUpdate } = mount()
    handle.loadMarkdown('- [ ] first\n- [ ] second')
    const { view } = handle.editor
    const paragraph = view.dom.querySelectorAll('li p')[1]
    const start = view.posAtDOM(paragraph, 0)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(paragraph)
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 120, right: 120, top: 70, bottom: 90 })
    try {
      const event = new MouseEvent('mouseup', { clientX: 170, clientY: 80, bubbles: true })
      expect(view.someProp('handleClick', (click) => click(view, start, event))).toBe(true)
      expect(view.state.selection.from).toBe(start + 'second'.length)
      expect(onUpdate).not.toHaveBeenCalled()
    } finally { vi.mocked(document.elementFromPoint).mockRestore() }
  })

  it.each([0, 1])('extends a backward text selection from task line-end whitespace (buttons=%s)', (buttons) => {
    const { handle, onUpdate } = mount()
    handle.loadMarkdown('- [ ] first\n- [ ] second')
    const { view } = handle.editor
    const [first, last] = Array.from(view.dom.querySelectorAll('li p'))
    const anchor = view.posAtDOM(last, 0) + 'second'.length
    const head = view.posAtDOM(first, 0) + 2
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, head)))
    const hit = vi.spyOn(document, 'elementFromPoint').mockImplementation((_x, y) => y >= 70 ? last : null)
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 120, right: 120, top: 72, bottom: 90 })
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: head, inside: 0 })
    const send = (type: string, x: number, y: number, target: Element, held: number) =>
      afterUiEvent(() => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true,
        pointerType: 'mouse', pointerId: 1, button: 0, buttons: held, clientX: x, clientY: y })))
    try {
      send('pointerdown', 160, 80, last, buttons)
      send('pointerup', 160, 80, last, 0)
      expect(view.state.selection.head).toBe(anchor)
      send('pointerdown', 160, 80, last, buttons)
      if (!buttons) afterUiEvent(() => last.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 160, clientY: 80 })))
      send('pointermove', 155, 80, last, buttons)
      expect(view.state.selection.empty).toBe(true)
      send('pointermove', 80, 40, first, buttons)
      expect(view.state.selection.anchor).toBe(anchor)
      expect(view.state.selection.head).toBe(head)
      send('pointerup', 80, 40, first, 0)
      afterUiEvent(() => first.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 80, clientY: 40 })))
      expect(view.state.selection.anchor).toBe(anchor)
      expect(view.state.selection.head).toBe(head)
      expect(onUpdate).not.toHaveBeenCalled()
    } finally { hit.mockRestore() }
  })

  it.each(['mouse movement', 'mouse only', 'pointer only', 'page margin'])('can select again immediately after collapsing a task range (%s)', (stream) => {
    const { handle, onUpdate } = mount()
    handle.loadMarkdown('- [ ] 第一行待办\n- [ ] 第二行待办')
    const { view } = handle.editor
    const [first, last] = Array.from(view.dom.querySelectorAll('li p'))
    const anchor = view.posAtDOM(last, 0) + last.textContent!.length
    const head = view.posAtDOM(first, 0) + 2
    const margin = stream === 'page margin'
    const start = margin ? scrollRoot! : last
    const x = margin ? 260 : 180
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 100))
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 120, right: 120, top: 72, bottom: 90 })
    vi.spyOn(view, 'posAtCoords').mockImplementation(({ top }) => ({ pos: top < 70 ? head : anchor, inside: 0 }))
    const hit = vi.spyOn(document, 'elementFromPoint').mockImplementation((_x, y) => y >= 70 ? start : null)
    const send = (type: string, target: Element, clientX: number, clientY: number) => {
      const init = { bubbles: true, cancelable: true, button: 0, buttons: 0, clientX, clientY, detail: 1 }
      const event = type.startsWith('pointer')
        ? new PointerEvent(type, { ...init, pointerId: 1, isPrimary: true, pointerType: 'mouse' })
        : new MouseEvent(type, init)
      afterUiEvent(() => target.dispatchEvent(event))
    }
    try {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, head, anchor)))
      send('pointerdown', start, x, 80)
      send('pointerup', start, x, 80)
      expect(view.state.selection.empty).toBe(true)
      expect(view.state.selection.head).toBe(anchor)
      if (stream !== 'mouse only') send('pointerdown', start, x, 80)
      if (stream !== 'pointer only') send('mousedown', start, x, 80)
      const move = stream === 'pointer only' ? 'pointermove' : 'mousemove'
      send(move, start, x - 3, 80)
      expect(view.state.selection.empty).toBe(true)
      send(move, first, 80, 40)
      expect(view.state.selection.anchor).toBe(anchor)
      expect(view.state.selection.head).toBe(head)
      if (stream !== 'mouse only') send('pointerup', first, 80, 40)
      send('mouseup', first, 80, 40)
      send('click', first, 80, 40)
      send('mousemove', last, x, 80)
      expect(view.state.selection.anchor).toBe(anchor)
      expect(view.state.selection.head).toBe(head)
      expect(onUpdate).not.toHaveBeenCalled()
    } finally { hit.mockRestore() }
  })

  it.each([false, true])('drags forward from task text after a tap (native selection=%s)', (nativeSelection) => {
    const { handle, onUpdate } = mount()
    handle.loadMarkdown('- [ ] 打开 Word 或 PowerPoint，验证右侧直接显示分页预览。\n- [ ] 打开多页 PDF\n- [ ] 确认滚动与保存正常。')
    const { view } = handle.editor
    const [first, , last] = Array.from(view.dom.querySelectorAll('li p'))
    const anchorOffset = first.textContent!.indexOf('验证') + 1
    const headOffset = last.textContent!.indexOf('保存') + 1
    const anchor = view.posAtDOM(first, 0) + anchorOffset
    const head = view.posAtDOM(last, 0) + headOffset
    const native = TextSelection.create(view.state.doc, anchor, head - 1)
    const hit = vi.spyOn(document, 'elementFromPoint').mockImplementation((_x, y) => y < 50 ? first : last)
    const rects = vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      return [new DOMRect(30, first.contains(this.startContainer) ? 20 : 70, 200, 20)] as unknown as DOMRectList
    })
    vi.spyOn(view, 'coordsAtPos').mockImplementation((pos) => ({ left: 230, right: 230,
      top: pos < head ? 20 : 70, bottom: pos < head ? 40 : 90 }))
    const previous = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
    Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: (_x: number, y: number) =>
      y < 50 ? { offsetNode: first.firstChild, offset: anchorOffset } : { offsetNode: last.firstChild, offset: headOffset } })
    const send = (type: string, row: Element, clientX: number, clientY: number) =>
      afterUiEvent(() => row.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
        pointerType: 'mouse', isPrimary: true, pointerId: 1, buttons: 0, clientX, clientY })))
    try {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor - 5, head)))
      send('pointerdown', first, 130, 30)
      send('pointerup', first, 130, 30)
      expect(view.state.selection.head).toBe(anchor)
      expect(view.state.selection.empty).toBe(true)

      send('pointerdown', first, 130, 30)
      send('pointermove', first, 133, 30)
      expect(view.state.selection.empty).toBe(true)
      if (nativeSelection) view.dispatch(view.state.tr.setSelection(native))
      send('pointermove', last, 180, 80)
      expect(view.state.selection.anchor).toBe(anchor)
      expect(view.state.selection.head).toBe(nativeSelection ? native.head : head)
      send('pointerup', last, 180, 80)
      expect(view.state.selection.head).toBe(nativeSelection ? native.head : head)
      expect(onUpdate).not.toHaveBeenCalled()
    } finally {
      if (previous) Object.defineProperty(document, 'caretPositionFromPoint', previous)
      else Reflect.deleteProperty(document, 'caretPositionFromPoint')
      hit.mockRestore()
      rects.mockRestore()
    }
  })

  it('starts a new text drag on the first held move following a reversed trackpad tap', () => {
    const { handle, onUpdate } = mount()
    handle.loadMarkdown('一段正文用于测试反复选择和点击')
    const view = handle.editor.view
    const row = view.dom.querySelector('p')!
    const hit = vi.spyOn(view, 'posAtCoords').mockImplementation(({ left }) => ({ pos: left < 490 ? 3 : left < 700 ? 7 : 12, inside: 0 }))
    const send = (type: string, x: number, time: number, buttons: number) => {
      const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse',
        pointerId: 1, isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons, clientX: x, clientY: 40 })
      Object.defineProperty(event, 'timeStamp', { value: time })
      afterUiEvent(() => row.dispatchEvent(event))
    }
    try {
      for (let round = 0; round < 5; round++) {
        const time = round * 3000
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 12)))
        send('pointerup', 684, time + 619, 0)
        // Compatibility mouseup can collapse the selection before the delayed down.
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7)))
        send('pointerdown', 684, time + 618, 0)
        send('pointermove', 762, time + 955, 0)
        expect(view.state.selection.empty).toBe(true)
        send('pointermove', 762, time + 1152, 1)
        send('pointermove', 760, time + 1160, 1)
        expect(view.state.selection.empty).toBe(true)
        send('pointermove', 484, time + 1600, 1)
        expect([view.state.selection.anchor, view.state.selection.head]).toEqual([12, 3])
        send('pointerup', 484, time + 1800, 0)
        send('pointermove', 684, time + 1900, 0)
        expect([view.state.selection.anchor, view.state.selection.head]).toEqual([12, 3])
      }
      expect(onUpdate).not.toHaveBeenCalled()
    } finally { hit.mockRestore() }
  })

  it('keeps the horizontal click position when a task padding hit is reported at the line start', () => {
    const { handle } = mount()
    handle.loadMarkdown('- [ ] previous\n- [ ] 播放音视频，重新播放。')
    const { view } = handle.editor
    const paragraph = view.dom.querySelectorAll('li p')[1]
    const start = view.posAtDOM(paragraph, 0)
    const hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(paragraph.closest('li'))
    const rects = vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([new DOMRect(70, 83, 130, 20)] as unknown as DOMRectList)
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 200, right: 200, top: 83, bottom: 103 })
    const native = vi.fn(() => ({ offsetNode: paragraph.firstChild, offset: 7 }))
    const previous = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
    Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: native })
    try {
      const click = new MouseEvent('mouseup', { clientX: 150, clientY: 80, bubbles: true })
      expect(view.someProp('handleClick', (handleClick) => handleClick(view, start, click))).toBe(true)
      expect(native).toHaveBeenCalledWith(150, 93)
      expect(view.state.selection.from).toBe(start + 7)
    } finally {
      if (previous) Object.defineProperty(document, 'caretPositionFromPoint', previous)
      else Reflect.deleteProperty(document, 'caretPositionFromPoint')
      hit.mockRestore()
      rects.mockRestore()
    }
  })

  it.each(['row end', 'page gutter'])('clears a task text selection from a light tap at the %s', (target) => {
    const { handle, onUpdate } = mount()
    handle.loadMarkdown('- [ ] first\n- [ ] second\n\n## Next heading')
    const { view } = handle.editor
    const [first, second] = Array.from(view.dom.querySelectorAll('li p'))
    const start = view.posAtDOM(first, 0)
    const end = view.posAtDOM(second, 0) + 'second'.length
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start, end - 1)))
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 160))
    const hit = vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: end, inside: -1 })
    const gutter = target === 'page gutter'
    const surface = gutter ? scrollRoot! : second
    const x = gutter ? 260 : 210
    const send = (type: string, timeStamp: number, clientX: number) => {
      const event = new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0,
        clientX, clientY: 80,
      })
      Object.defineProperty(event, 'timeStamp', { value: timeStamp })
      afterUiEvent(() => surface.dispatchEvent(event))
    }
    send('pointerup', 101, x + 3)
    send('pointerdown', 100, x)
    expect(hit).toHaveBeenCalledWith({ left: gutter ? 239 : 213, top: 80 })
    expect(view.state.selection.empty).toBe(true)
    expect(view.state.selection.from).toBe(end)
    expect(view.dom.hasAttribute('data-list-text-highlights')).toBe(false)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('keeps gutter double-click and drag from selecting entire blocks', () => {
    const { handle, element } = mount()
    handle.loadMarkdown('first\n\nsecond')
    const view = handle.editor.view
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 100))
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 })
    const gutter = scrollRoot!
    afterUiEvent(() => gutter.dispatchEvent(new MouseEvent('mousedown', { clientX: 15, clientY: 35, bubbles: true, cancelable: true })))
    afterUiEvent(() => gutter.dispatchEvent(new MouseEvent('dblclick', { clientX: 15, clientY: 35, bubbles: true })))
    for (const [type, clientY] of [['pointerdown', 35], ['pointermove', 95], ['pointerup', 95]] as const) {
      afterUiEvent(() => gutter.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
        isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: 15, clientY })))
    }
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    expect(view.state.selection.empty).toBe(true)
    expect(element.querySelector('[data-block-range-selected]')).toBeNull()
  })

  it('requires a held drag across cells and puts the caret back on a single tap', () => {
    const { handle, onUpdate } = mount()
    handle.loadMarkdown('| header |\n| --- |\n| first |\n| second |')
    const view = handle.editor.view
    const [first, second] = Array.from(view.dom.querySelectorAll('td'))
    const positions = [first, second].map((cell) => view.posAtDOM(cell.querySelector('p')!, 0) + 1)
    vi.spyOn(view, 'posAtCoords').mockImplementation(({ top }) => ({ pos: positions[top < 40 ? 0 : 1], inside: -1 }))
    const pointer = (type: string, target: Element, y: number, buttons: number) => afterUiEvent(() => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, pointerId: 1,
      clientX: 50, clientY: y, button: 0, buttons,
    })))

    // A delayed compatibility mousedown must not arm a drag after release.
    pointer('pointerup', first, 38, 0)
    afterUiEvent(() => first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 50, clientY: 38 })))
    afterUiEvent(() => second.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 55, buttons: 0 })))
    expect(view.state.selection).not.toBeInstanceOf(CellSelection)

    pointer('pointerdown', first, 38, 1)
    pointer('pointermove', second, 42, 1)
    expect(view.state.selection).not.toBeInstanceOf(CellSelection)
    pointer('pointermove', second, 55, 1)
    expect(view.state.selection).toBeInstanceOf(CellSelection)
    pointer('pointerup', second, 55, 0)
    expect(tableEditingKey.getState(view.state)).toBeNull()
    pointer('pointermove', first, 38, 0)
    expect(view.dom.querySelectorAll('.selectedCell')).toHaveLength(2)
    pointer('pointerdown', second, 55, 1)
    pointer('pointerup', second, 56, 0)
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    expect(view.state.selection.from).toBe(positions[1])
    expect(view.dom.querySelector('.selectedCell')).toBeNull()
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('accepts a click with slight movement inside a task checkbox', () => {
    const { handle, element } = mount()
    handle.loadMarkdown('- [ ] first')
    const button = element.querySelector<HTMLButtonElement>('[data-task-toggle]')!
    afterUiEvent(() => button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 40 })))
    afterUiEvent(() => button.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 46, buttons: 1 })))
    afterUiEvent(() => button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 46 })))
    afterUiEvent(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 46, detail: 1 })))
    expect(element.querySelector('[data-task-toggle]')?.getAttribute('aria-checked')).toBe('true')
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
    afterUiEvent(() => paragraph.dispatchEvent(new MouseEvent('mousedown', { clientX: 50, clientY: 30, bubbles: true })))
    afterUiEvent(() => paragraph.dispatchEvent(new MouseEvent('mousemove', { clientX: 80, clientY: 30, bubbles: true, buttons: 1 })))
    // Window selection geometry is supplied by the native browser during this gesture.
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 7)))
    afterUiEvent(() => paragraph.dispatchEvent(new MouseEvent('mouseup', { clientX: 80, clientY: 30, bubbles: true })))
    afterUiEvent(() => paragraph.dispatchEvent(new MouseEvent('click', { detail: 1, clientX: 80, clientY: 30, bubbles: true })))
    expect(view.state.selection.from).toBe(1)
    expect(view.state.selection.to).toBe(7)
  })

  it.each(['ordered tap', 'reordered tap', 'drag returning near the press'])('handles %s inside selected text without a click event', (gesture) => {
    const { handle, onUpdate } = mount()
    handle.loadMarkdown('onebox sample text')
    const view = handle.editor.view
    const paragraph = view.dom.querySelector('p')!
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 14)))
    const coords = vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 7, inside: 0 })
    const send = (type: string, x: number, timestamp: number) => {
      const event = new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, pointerId: 1,
        clientX: x, clientY: 30,
      })
      Object.defineProperty(event, 'timeStamp', { value: timestamp })
      afterUiEvent(() => paragraph.dispatchEvent(event))
      return event
    }
    if (gesture === 'reordered tap') {
      send('pointerup', 54, 101)
      expect(view.state.selection.empty).toBe(false)
      expect(send('pointerdown', 50, 100).defaultPrevented).toBe(true)
    } else {
      send('pointerdown', 50, 100)
      if (gesture.startsWith('drag')) send('pointermove', 80, 101)
      send('pointerup', 54, 102)
    }
    expect(view.state.selection.to).toBe(gesture.startsWith('drag') ? 14 : 7)
    expect(view.state.selection.from).toBe(gesture.startsWith('drag') ? 1 : 7)
    if (!gesture.startsWith('drag')) expect(coords).toHaveBeenCalledWith({ left: 54, top: 30 })
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('continues from the blank space under a final code block without adding a second paragraph on repeat', () => {
    const { handle } = mount()
    const view = handle.editor.view
    handle.loadBlocks([{ type: 'codeBlock', content: [{ type: 'text', text: 'code' }] }], true)
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 100))
    const clickBelow = () => clickEditorGutter(110, 175)
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

  it('opens a new paragraph below an isolated display formula', () => {
    const { handle } = mount()
    handle.loadMarkdown('$$a+b$$')
    const view = handle.editor.view
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 100))
    clickEditorGutter(110, 175)
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
    const disableClickTolerance = enableButtonClickTolerance(document)
    const { handle, element } = mount()
    try {
      handle.loadMarkdown('before $r^2$ after')
      const formula = element.querySelector<HTMLElement>('.markdown-math')!
      const preview = formula.querySelector('button')!
      Object.defineProperty(preview, 'setPointerCapture', { value: vi.fn() })
      for (const type of ['pointerdown', 'pointerup']) {
        preview.dispatchEvent(new PointerEvent(type, { altKey: true, bubbles: true, cancelable: true,
          pointerType: 'mouse', isPrimary: true, pointerId: 1, buttons: type === 'pointerdown' ? 1 : 0 }))
      }
      const source = formula.querySelector('textarea')!
      expect(formula.dataset.mathEdit).toBe('source')
      expect(preview.hidden).toBe(false)
      source.value = 'r^3'
      afterUiEvent(() => source.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
      expect(element.querySelector('.markdown-math > button')).toBe(preview)
      expect(formula.dataset.mathEdit).toBeUndefined()
      expect(handle.toMarkdown()).toBe('before $r^3$ after')
    } finally {
      disableClickTolerance()
    }
  })

  it('opens the line below a code block and reuses a following paragraph across viewport groups', () => {
    const { handle, element, onUpdate } = mount()
    handle.loadBlocks([{ type: 'codeBlock', content: [{ type: 'text', text: 'code' }] }], true)
    handle.appendBlocks([{ type: 'paragraph', content: [{ type: 'text', text: 'next' }] }])
    afterUiEvent(() => element.querySelector<HTMLButtonElement>('.code-continue')!.click())

    const { selection, doc } = handle.editor.state
    expect(selection.$head.parent.textContent).toBe('next')
    expect(selection.$head.parentOffset).toBe(0)
    expect(doc.firstChild?.childCount).toBe(1)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('restores an unused gap between code blocks and saves only typed content', () => {
    const { handle, element, onUpdate } = mount()
    const markdown = '```js\na\n```\n\n```js\nb\n```'
    handle.loadMarkdown(markdown)
    const { view } = handle.editor
    expect(view.state.doc.childCount).toBe(2)
    const gap = element.querySelector<HTMLButtonElement>('.code-continue')!
    expect(gap.tabIndex).toBe(-1)
    afterUiEvent(() => gap.click())
    expect(view.state.doc.childCount).toBe(3)
    expect(view.state.doc.child(1).type.name).toBe('paragraph')
    expect(view.state.selection.$head.parent).toBe(view.state.doc.child(1))
    expect(handle.toMarkdown()).toBe(markdown)
    expect(onUpdate).not.toHaveBeenCalled()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    expect(view.state.doc.childCount).toBe(2)
    expect(onUpdate).not.toHaveBeenCalled()

    afterUiEvent(() => element.querySelector<HTMLButtonElement>('.code-continue')!.click())
    expect(view.state.selection.$head.parent.type.name).toBe('paragraph')
    view.dispatch(view.state.tr.insertText('新的正文'))
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    expect(view.state.doc.childCount).toBe(3)
    expect(handle.toMarkdown()).toBe(markdown.replace('\n\n', '\n\n新的正文\n\n'))
    expect(onUpdate).toHaveBeenCalledOnce()
  })

  it('closes an empty line below a formula when focus leaves the editor', async () => {
    const { handle, onUpdate } = mount()
    const markdown = '$$a+b$$'
    handle.loadMarkdown(markdown)
    const { view } = handle.editor
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 200, 100))
    clickEditorGutter(110, 175)
    expect(view.state.doc.childCount).toBe(2)
    const outside = document.createElement('button')
    document.body.append(outside)
    try {
      outside.focus()
      await Promise.resolve()
      expect(view.state.doc.childCount).toBe(1)
      expect(handle.toMarkdown()).toBe(markdown)
      expect(onUpdate).not.toHaveBeenCalled()
    } finally { outside.remove() }
  })

  it('alternates between heading whitespace and the code gap with reversed trackpad taps', () => {
    const disableClickTolerance = enableButtonClickTolerance(document)
    const { handle, element, onUpdate } = mount()
    const markdown = '## 代码与公式\n\n```\na\n```\n\n```\nb\n```'
    handle.loadBlocks([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '代码与公式' }] },
      { type: 'codeBlock', content: [{ type: 'text', text: 'a' }] },
      { type: 'codeBlock', content: [{ type: 'text', text: 'b' }] },
    ], true)
    const { view } = handle.editor
    const coords = vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 170, right: 170, top: 20, bottom: 45 })
    const tap = (target: Element, x: number, y: number, time: number) => {
      for (const type of ['pointerup', 'pointerdown']) {
        const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse',
          isPrimary: true, pointerId: 1, clientX: x, clientY: y })
        Object.defineProperty(event, 'timeStamp', { value: time + Number(type === 'pointerup') })
        afterUiEvent(() => target.dispatchEvent(event))
      }
    }
    const replayStarted = performance.now() - 3_000
    try {
      for (let i = 0; i < 4; i++) {
        tap(element.querySelector('.code-continue')!, 65, 80, replayStarted + i * 600 + 100)
        expect(view.state.selection.$head.parent.type.name).toBe('paragraph')
        expect(view.state.doc.firstChild?.childCount).toBe(4)
        tap(element.querySelector('h2')!, 350, 32, replayStarted + i * 600 + 400)
        expect(view.state.selection.$head.parent.type.name).toBe('heading')
        expect(view.state.selection.$head.parentOffset).toBe('代码与公式'.length)
        expect(view.state.doc.firstChild?.childCount).toBe(3)
      }
      expect(handle.toMarkdown()).toBe(markdown)
      expect(onUpdate).not.toHaveBeenCalled()
    } finally {
      coords.mockRestore()
      disableClickTolerance()
    }
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
    expect(code.querySelector('.code-next')).toBeNull()
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
    expect(frame.querySelector('.code-toolbar :is(.code-expand, .code-next)')).toBeNull()
    expect(frame.querySelector('.code-language')).toBeNull()
    expect(preview.getAttribute('aria-label')).toBe('放大Mermaid 图')
    expect(edit.textContent).toBe('编辑')
    expect(source.hidden).toBe(true)

    afterUiEvent(() => edit.click())
    expect(edit.textContent).toBe('完成')
    expect(source.hidden).toBe(false)
    expect(handle.editor.state.selection.$head.parent.type.name).toBe('codeBlock')
    expect(handle.editor.state.selection.$head.parentOffset).toBe(0)
    expect(preview.parentElement).toBe(source.parentElement)

    editor.commands.setTextSelection(editor.state.selection.head + 'flowchart LR\nA --> B'.length)
    afterUiEvent(() => previewTab.click())
    expect(previewTab.getAttribute('aria-pressed')).toBe('true')
    editor.commands.setTextSelection(1)
    afterUiEvent(() => sourceTab.click())
    expect(editor.state.selection.$head.parentOffset).toBe('flowchart LR\nA --> B'.length)
    expect(onUpdate).not.toHaveBeenCalled()

    editor.view.dispatch(editor.state.tr.insertText('[Ready]'))
    afterUiEvent(() => edit.click())
    expect(frame.querySelector('.rich-preview')).toBe(preview)
    expect(source.hidden).toBe(true)
    expect(handle.toMarkdown()).toBe('# Other\n\n```mermaid\nflowchart LR\nA --> B[Ready]\n```')
    expect(onUpdate).toHaveBeenCalledOnce()
  })

  it('pastes a fenced Mermaid snippet as source inside the existing code block', () => {
    const { handle, element, onUpdate } = mount()
    const body = 'flowchart LR\n  A --> B'
    handle.loadMarkdown('```mermaid\n' + body + '\n```')
    const { editor } = handle
    const frame = element.querySelector<HTMLElement>('[data-rich="mermaid"]')!
    afterUiEvent(() => frame.querySelector<HTMLButtonElement>('.code-actions button[aria-expanded]')!.click())
    editor.commands.setTextSelection({ from: 1, to: body.length + 1 })
    const updated = 'flowchart TD\n  B --> C'
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => '```mermaid\n' + updated + '\n```', files: [] } })
    expect(afterUiEvent(() => frame.querySelector('pre code')!.dispatchEvent(paste))).toBe(false)
    expect(handle.toMarkdown()).toBe('```mermaid\n' + updated + '\n```')
    expect(onUpdate).toHaveBeenCalledOnce()
  })

  it('closes an edited Mermaid block on trackpad release without toggling it twice', () => {
    const disableClickTolerance = enableButtonClickTolerance(document)
    const { handle, element, onUpdate } = mount()
    const source = 'flowchart LR\nA --> B'
    handle.loadMarkdown('```mermaid\n' + source + '\n```')
    const { editor } = handle
    const button = element.querySelector<HTMLButtonElement>('[data-rich="mermaid"] .code-actions button[aria-expanded]')!
    const pre = element.querySelector('pre')!
    Object.defineProperty(button, 'setPointerCapture', { value: vi.fn() })
    const tap = (time: number, releaseFirst: boolean) => {
      for (const type of releaseFirst ? ['pointerup', 'pointerdown'] : ['pointerdown', 'pointerup']) {
        const release = type === 'pointerup'
        const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse',
          isPrimary: true, pointerId: 1, button: 0, buttons: release ? 0 : 1, clientX: release ? 43 : 40 })
        Object.defineProperty(event, 'timeStamp', { value: time + Number(release) })
        afterUiEvent(() => button.dispatchEvent(event))
      }
    }
    const time = performance.now() - 1_000
    try {
      for (const [index, reversed] of [false, true, false, true].entries()) {
        const started = time + index * 200
        afterUiEvent(() => button.click())
        expect(button.textContent).toBe('完成')
        editor.commands.setTextSelection(source.length + index + 1)
        editor.view.dispatch(editor.state.tr.insertText(' '))
        expect(editor.view.hasFocus()).toBe(true)
        tap(started, reversed)
        expect(pre.hidden).toBe(true)
        expect(button.textContent).toBe('编辑')
        const lateClick = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: 43 })
        Object.defineProperty(lateClick, 'timeStamp', { value: started + 1 })
        expect(afterUiEvent(() => button.dispatchEvent(lateClick))).toBe(false)
        expect(pre.hidden).toBe(true)
      }
      expect(onUpdate).toHaveBeenCalledTimes(4)
      expect(handle.toMarkdown()).toBe('```mermaid\n' + source + '    \n```')
    } finally {
      disableClickTolerance()
    }
  })

  it('changes the fence language through the dropdown and preserves its contents and metadata', () => {
    const { handle, element, onUpdate } = mount()
    const input = '> ```custom title=demo\n> fn main() {}\n> ```'
    handle.loadMarkdown(input)
    const select = () => element.querySelector<HTMLButtonElement>('.code-language')!
    const choose = (value: string) => {
      afterUiEvent(() => select().click())
      const search = document.querySelector<HTMLInputElement>('[aria-label="搜索语言"]')
      if (!search) return
      expect(document.activeElement).toBe(search)
      const firstOption = document.querySelector<HTMLButtonElement>('.code-language-options [role="option"]')
      expect(firstOption?.dataset.languageId).toBe(select().dataset.languageId)
      expect(firstOption?.getAttribute('aria-selected')).toBe('true')
      expect(document.querySelector('.code-language-options')?.textContent).not.toMatch(/自动识别|纯文本/)
      search.value = value || 'TXT'
      afterUiEvent(() => search.dispatchEvent(new Event('input', { bubbles: true })))
      const options = document.querySelectorAll<HTMLButtonElement>('.code-language-options [role="option"]')
      expect(options).toHaveLength(1)
      afterUiEvent(() => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
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
    afterUiEvent(() => element.querySelector<HTMLButtonElement>('.code-language')!.click())
    const search = document.querySelector<HTMLInputElement>('[aria-label="搜索语言"]')!
    const option = document.querySelector<HTMLButtonElement>('.code-language-options [data-language-id="python"]')!
    afterUiEvent(() => option.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 })))
    expect(afterUiEvent(() => option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })))).toBe(false)
    search.blur()
    await Promise.resolve()
    afterUiEvent(() => scrollRoot!.dispatchEvent(new Event('scroll')))
    expect(option.isConnected).toBe(true)
    afterUiEvent(() => option.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 })))
    afterUiEvent(() => scrollRoot!.dispatchEvent(new Event('scroll')))
    expect(option.isConnected).toBe(true)
    afterUiEvent(() => option.click())
    expect(handle.toMarkdown()).toBe('```python\nexample\n```')
    const trigger = element.querySelector<HTMLButtonElement>('.code-language')!
    afterUiEvent(() => trigger.click())
    afterUiEvent(() => trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 })))
    document.querySelector<HTMLInputElement>('[aria-label="搜索语言"]')!.blur()
    await Promise.resolve()
    afterUiEvent(() => trigger.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 })))
    afterUiEvent(() => trigger.click())
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
    const line = chartCommands.find((item) => item.label === '折线图')!
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
    afterUiEvent(() => handle.editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace', bubbles: true, cancelable: true,
    })))

    expect(handle.toMarkdown()).toBe('firstnext')
    expect(handle.editor.commands.undo()).toBe(true)
    expect(handle.toMarkdown()).toBe('first\n\nnext')
  })
})
