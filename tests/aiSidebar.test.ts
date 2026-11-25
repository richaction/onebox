import { createComponent, createSignal } from 'solid-js'
import { render } from '@solidjs/web'
import { afterUiEvent } from './uiEvents'
import { expect, it, vi } from 'vitest'
import { captureAiReference } from '../src/core/aiDocument'
import { createEditor } from '../src/core/editor'
import { enableButtonClickTolerance } from '../src/core/buttonClickTolerance'
import { ai, type AiEvent } from '../src/io/ai'
import AiSidebar, { type AiConversationHistory } from '../src/ui/AiSidebar'
import AiSidebarToggle from '../src/ui/AiSidebarToggle'
import AiComposerMenu from '../src/ui/AiComposerMenu'
import WorkspaceResizeHandle, { initialSidebarWidth } from '../src/ui/WorkspaceResizeHandle'

it.each([
  { reference: 1, marker: '.editor-ai-added', reopen: '预览替换', result: 'Onebox 文档' },
  { reference: null, marker: '.editor-ai-draft', reopen: '预览插入', result: 'onebox 文档\n\nOnebox' },
])('previews a sidebar revision before saving (reference $reference)', async ({ reference, marker, reopen, result }) => {
  let receive!: (event: AiEvent) => void
  const mocks = [
    vi.spyOn(ai, 'events').mockImplementation(async (callback) => { receive = callback; return () => {} }),
    vi.spyOn(ai, 'account').mockResolvedValue({ email: '', plan: 'test' }),
    vi.spyOn(ai, 'usage').mockResolvedValue({}),
    vi.spyOn(ai, 'models').mockResolvedValue([{ model: 'test' }]),
    vi.spyOn(ai, 'newThread').mockResolvedValue('thread'),
    vi.spyOn(ai, 'closeThread').mockResolvedValue(undefined),
  ]
  const start = vi.spyOn(ai, 'start').mockResolvedValue('turn')
  const host = document.createElement('div')
  const page = document.createElement('div')
  document.body.append(host, page)
  const onUpdate = vi.fn()
  const markdown = 'onebox 文档'
  const handle = createEditor({ element: page, scrollRoot: page, markdown, onUpdate })
  handle.editor.commands.setTextSelection({ from: 1, to: 7 })
  const quote = reference ? captureAiReference(handle.editor, 'selection', '样例.md') : undefined
  const dispose = render(() => createComponent(AiSidebar, {
    open: true, loading: false, title: '样例.md',
    history: { active: 0, next: 0, conversations: [] },
    editor: () => handle.editor, quote, pickReference: async () => undefined,
    onClose: () => {}, onQuoteConsumed: () => {},
  }), host)
  const action = (label: string) => Array.from(host.querySelectorAll('button'))
    .find((button) => button.getAttribute('aria-label') === label || button.textContent === label)
  try {
    const input = host.querySelector<HTMLTextAreaElement>('[aria-label="向 AI 提问"]')!
    input.value = '改成 Onebox'
    afterUiEvent(() => input.dispatchEvent(new Event('input', { bubbles: true })))
    await vi.waitFor(() => expect(action('发送')?.disabled).toBe(false))
    afterUiEvent(() => action('发送')!.click())
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    receive({ method: 'item/completed', params: {
      threadId: 'thread', turnId: 'turn',
      item: { id: 'revision', type: 'agentMessage', text: JSON.stringify({
        answer: '已生成建议', revision: { reference, markdown: 'Onebox' },
      }) },
    } })
    afterUiEvent(() => receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } }))
    expect(page.querySelector(marker)).not.toBeNull()
    expect(handle.toMarkdown()).toBe(markdown)
    expect(onUpdate).not.toHaveBeenCalled()

    afterUiEvent(() => action('撤销预览')!.click())
    expect(page.querySelector(marker)).toBeNull()
    expect(onUpdate).not.toHaveBeenCalled()
    afterUiEvent(() => action(reopen)!.click())
    afterUiEvent(() => action('✓ 确认')!.click())
    expect(page.querySelector(marker)).toBeNull()
    expect(handle.toMarkdown()).toBe(result)
    expect(onUpdate).toHaveBeenCalledOnce()
    afterUiEvent(() => action('撤销')!.click())
    expect(handle.toMarkdown()).toBe(markdown)
    if (reference) {
      afterUiEvent(() => action('查看建议')!.click())
      afterUiEvent(() => action(reopen)!.click())
      afterUiEvent(() => handle.editor.view.dispatch(handle.editor.state.tr.insertText('x', 2)))
      expect(page.querySelector(marker)).toBeNull()
      expect(action('✓ 确认')).toBeUndefined()
      expect(handle.toMarkdown()).toBe('oxnebox 文档')
    }
  } finally {
    dispose()
    handle.destroy()
    host.remove()
    page.remove()
    for (const mock of [...mocks, start]) mock.mockRestore()
  }
})

it('opens a fresh conversation and restores the previous transcript and draft', () => {
  const stopListening = vi.spyOn(ai, 'events').mockResolvedValue(() => {})
  const account = vi.spyOn(ai, 'account').mockResolvedValue(null)
  const request = { text: '整理文档大纲', references: [], insertion: 1 }
  const earlier = new Date()
  earlier.setDate(earlier.getDate() - 10)
  const history: AiConversationHistory = {
    active: 0, next: 1, conversations: [{
      id: 0, draft: '', references: [], messages: [
        { role: 'user', text: request.text, request },
        { role: 'assistant', text: '大纲已整理。', status: 'done', request },
      ],
    }, { id: 1, draft: '翻译注释', references: [], messages: [], updatedAt: earlier.getTime() }],
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const mount = () => render(() => createComponent(AiSidebar, {
    open: true, loading: false, title: '样例.md', history,
    editor: () => undefined, quote: undefined, pickReference: async () => undefined,
    onClose: () => {}, onQuoteConsumed: () => {},
  }), host)
  let dispose = mount()
  const draft = () => host.querySelector<HTMLTextAreaElement>('[aria-label="向 AI 提问"]')!
  const toggleList = () => afterUiEvent(() => host.querySelector<HTMLButtonElement>('[aria-label="会话列表"]')!.click())
  const latestDraft = '这是下一条问题。'
  try {
    draft().value = latestDraft
    afterUiEvent(() => draft().dispatchEvent(new Event('input', { bubbles: true })))
    afterUiEvent(() => host.querySelector<HTMLButtonElement>('[aria-label="新会话"]')!.click())
    expect(draft().value).toBe('')
    expect(host.textContent).not.toContain('大纲已整理。')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('可以开始新会话。')
    const newConversationId = history.active
    afterUiEvent(() => host.querySelector<HTMLButtonElement>('[aria-label="新会话"]')!.click())
    expect(history.active).toBe(newConversationId)
    expect(history.next).toBe(newConversationId)
    expect(document.activeElement).toBe(draft())
    toggleList()
    const options = () => [...host.querySelectorAll<HTMLButtonElement>('.ai-conversation-option')]
    expect(options().map((option) => option.querySelector('span')!.textContent)).toEqual(['新会话', request.text, '翻译注释'])
    expect(options()[0].getAttribute('aria-current')).toBe('true')
    expect(host.querySelector('[aria-label="过去 30 天"] time')?.textContent).toContain('月')
    const search = host.querySelector<HTMLInputElement>('[aria-label="搜索会话"]')!
    search.value = '大纲'
    afterUiEvent(() => search.dispatchEvent(new Event('input', { bubbles: true })))
    expect(options()).toHaveLength(1)
    afterUiEvent(() => options()[0].click())
    expect(draft().value).toBe(latestDraft)
    expect(host.textContent).toContain('大纲已整理。')
    dispose()
    dispose = mount()
    expect(draft().value).toBe(latestDraft)
    expect(host.textContent).toContain('大纲已整理。')
  } finally {
    dispose()
    host.remove()
    stopListening.mockRestore()
    account.mockRestore()
  }
})

it('opens composer menus while a document loads', () => {
  const stopListening = vi.spyOn(ai, 'events').mockResolvedValue(() => {})
  const account = vi.spyOn(ai, 'account').mockResolvedValue(null)
  const host = document.createElement('div')
  const onClose = vi.fn()
  document.body.append(host)
  const dispose = render(() => createComponent(AiSidebar, {
    open: true, loading: true, title: '样例.md',
    history: { active: 0, next: 0, conversations: [] },
    editor: () => undefined, quote: undefined, pickReference: async () => undefined,
    onClose, onQuoteConsumed: () => {},
  }), host)
  try {
    expect(host.querySelector('.ai-compose')?.hasAttribute('inert')).toBe(false)
    afterUiEvent(() => host.querySelector<HTMLButtonElement>('[aria-label="添加引用"]')!.click())
    expect(host.querySelector<HTMLButtonElement>('.ai-quote-popup button')?.disabled).toBe(true)
    const usage = host.querySelector<HTMLButtonElement>('.ai-usage-trigger')!
    const usageMenu = usage.parentElement!
    afterUiEvent(() => usageMenu.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' })))
    expect(host.querySelector('.ai-quote-popup')).not.toBeNull()
    afterUiEvent(() => host.querySelector<HTMLButtonElement>('[aria-label="添加引用"]')!.click())
    afterUiEvent(() => usageMenu.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' })))
    expect(host.querySelector('.ai-usage-popup')).toBeNull()
    afterUiEvent(() => usage.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })))
    const popup = host.querySelector('.ai-usage-popup')!
    expect(usage.getAttribute('aria-expanded')).toBe('true')
    const canceledPress = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse' })
    canceledPress.preventDefault()
    afterUiEvent(() => document.body.dispatchEvent(canceledPress))
    expect(popup.isConnected).toBe(true)
    afterUiEvent(() => host.querySelector('.ai-model-trigger')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })))
    expect(popup.isConnected).toBe(true)
    afterUiEvent(() => popup.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })))
    afterUiEvent(() => usageMenu.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' })))
    expect(popup.isConnected).toBe(true)
    afterUiEvent(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })))
    expect(popup.isConnected).toBe(false)
    expect(usage.getAttribute('aria-expanded')).toBe('false')
    afterUiEvent(() => usage.click())
    afterUiEvent(() => usage.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })))
    expect(host.querySelector('.ai-usage-popup')).toBeNull()
    afterUiEvent(() => usage.click())
    expect(host.querySelector('.ai-usage-popup')).not.toBeNull()
    expect(host.querySelector<HTMLButtonElement>('[aria-label="发送"]')?.disabled).toBe(true)
    const sidebar = host.querySelector<HTMLElement>('[aria-label="Onebox AI"]')!
    afterUiEvent(() => sidebar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(host.querySelector('.ai-usage-popup')).toBeNull()
    afterUiEvent(() => sidebar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(onClose).toHaveBeenCalledTimes(1)
    afterUiEvent(() => sidebar.querySelector<HTMLButtonElement>('.ai-sidebar-collapse')!.click())
    expect(onClose).toHaveBeenCalledTimes(2)
  } finally {
    dispose()
    host.remove()
    stopListening.mockRestore()
    account.mockRestore()
  }
})

it('uses the same AI toggle on initial open, close, and rapid reopen', () => {
  const [open, setOpen] = createSignal(false)
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => createComponent(AiSidebarToggle, {
    get open() { return open() }, onOpen: () => setOpen(true), onClose: () => setOpen(false),
  }), host)
  const stop = enableButtonClickTolerance(document)
  const button = host.querySelector('button')!
  let hasCapture = false
  Object.assign(button, {
    hasPointerCapture: () => hasCapture,
    setPointerCapture: () => { hasCapture = true },
    releasePointerCapture: () => { hasCapture = false },
  })
  const pointer = (type: string, timeStamp: number, clientX: number) => {
    const event = new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, button: 0, isPrimary: true, pointerType: 'mouse', clientX,
    })
    Object.defineProperty(event, 'timeStamp', { value: timeStamp })
    afterUiEvent(() => button.dispatchEvent(event))
  }
  const lateClick = (timeStamp: number, clientX: number) => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX })
    Object.defineProperty(event, 'timeStamp', { value: timeStamp })
    afterUiEvent(() => button.dispatchEvent(event))
  }
  try {
    pointer('pointerup', 101, 22)
    pointer('pointerdown', 100, 19)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('button')).toBe(button)
    expect(button.textContent).toContain('AI')
    lateClick(101, 24)
    expect(open()).toBe(true)

    pointer('pointerdown', 125, 22)
    pointer('pointerup', 126, 26)
    expect(open()).toBe(false)
    expect(host.querySelector('button')).toBe(button)
    lateClick(126, 27)
    expect(open()).toBe(false)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.textContent).toContain('AI')

    pointer('pointerdown', 150, 23)
    pointer('pointerup', 151, 24)
    expect(open()).toBe(true)
    afterUiEvent(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(open()).toBe(false)
  } finally {
    stop()
    dispose()
    host.remove()
  }
})

it('keeps the model dropdown open while the pointer crosses the space above its button', () => {
  const [open, setOpen] = createSignal(false)
  const host = document.createElement('div')
  document.body.appendChild(host)
  vi.useFakeTimers()
  const dispose = render(() => createComponent(AiComposerMenu, {
    kind: 'model', label: 'AI 模型', get open() { return open() }, trigger: '当前模型',
    children: '模型列表', onToggle: () => setOpen(!open()), onDismiss: () => setOpen(false),
  }), host)
  try {
    const button = host.querySelector('button')!
    afterUiEvent(() => button.click())
    expect(host.textContent).toContain('模型列表')

    afterUiEvent(() => button.parentElement!.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' })))
    vi.advanceTimersByTime(250)
    expect(host.textContent).toContain('模型列表')

    afterUiEvent(() => button.click())
    expect(host.textContent).not.toContain('模型列表')
  } finally {
    dispose()
    vi.useRealTimers()
    host.remove()
  }
})

it('resizes the right sidebar in the opposite direction and keeps its own width preference', () => {
  const aiKey = 'onebox:ai-sidebar-width'
  const workspaceKey = 'onebox:workspace-width'
  const originalAi = localStorage.getItem(aiKey)
  const originalWorkspace = localStorage.getItem(workspaceKey)
  localStorage.setItem(aiKey, '300')
  localStorage.setItem(workspaceKey, '252')
  const [width, setWidth] = createSignal(initialSidebarWidth('ai'))
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => createComponent(WorkspaceResizeHandle, {
    sidebar: 'ai', get width() { return width() }, onWidth: setWidth, onResize: () => {},
  }), host)
  try {
    const handle = host.querySelector('[role="separator"]')!
    const press = (key: string) => afterUiEvent(() => handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
    press('ArrowLeft')
    expect(width()).toBe(316)
    expect(initialSidebarWidth('ai')).toBe(316)
    press('Home')
    expect(width()).toBe(180)
    press('End')
    expect(width()).toBe(Number(handle.getAttribute('aria-valuemax')))
    expect(initialSidebarWidth('workspace')).toBe(252)
  } finally {
    dispose()
    host.remove()
    if (originalAi === null) localStorage.removeItem(aiKey)
    else localStorage.setItem(aiKey, originalAi)
    if (originalWorkspace === null) localStorage.removeItem(workspaceKey)
    else localStorage.setItem(workspaceKey, originalWorkspace)
  }
})

it('saves and closes the menu immediately on a reasoning or model choice', async () => {
  const model = {
    model: 'test-three-tiers', defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((reasoningEffort) => ({ reasoningEffort })),
  }
  const alternative = { ...model, model: 'test-alternative' }
  const modelKey = 'onebox.ai.model'
  const previousModel = localStorage.getItem(modelKey)
  const key = `onebox.ai.effort.${model.model}`
  const previous = localStorage.getItem(key)
  localStorage.setItem(key, 'xhigh')
  localStorage.setItem(modelKey, model.model)
  const mocks = [
    vi.spyOn(ai, 'events').mockResolvedValue(() => {}),
    vi.spyOn(ai, 'account').mockResolvedValue({ email: '', plan: 'pro' }),
    vi.spyOn(ai, 'models').mockResolvedValue([model, alternative]),
    vi.spyOn(ai, 'usage').mockResolvedValue({}),
  ]
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => createComponent(AiSidebar, {
    open: true, loading: false, title: '样例.md', history: { active: 0, next: 0, conversations: [] },
    editor: () => undefined, quote: undefined, pickReference: async () => undefined, onClose: () => {}, onQuoteConsumed: () => {},
  }), host)
  try {
    const trigger = host.querySelector<HTMLButtonElement>('.ai-model-trigger')!
    await vi.waitFor(() => expect(trigger.getAttribute('aria-label')).toContain('思考强度 高'))
    afterUiEvent(() => trigger.click())
    const tiers = [...host.querySelectorAll<HTMLButtonElement>('.ai-effort-options button')]
    expect(tiers.map((button) => button.textContent)).toEqual(['低', '中', '高'])
    expect(tiers[2].getAttribute('aria-pressed')).toBe('true')
    afterUiEvent(() => tiers[0].click())
    expect(host.querySelector('.ai-model-popup')).toBeNull()
    expect(document.activeElement).toBe(host.querySelector('textarea'))
    expect(localStorage.getItem(key)).toBe('low')
    expect(trigger.getAttribute('aria-label')).toContain('思考强度 低')

    afterUiEvent(() => trigger.click())
    afterUiEvent(() => host.querySelectorAll<HTMLButtonElement>('.ai-model-option')[1].click())
    expect(host.querySelector('.ai-model-popup')).toBeNull()
    expect(document.activeElement).toBe(host.querySelector('textarea'))
    expect(localStorage.getItem(modelKey)).toBe(alternative.model)
    expect(trigger.textContent).toContain(alternative.model)
  } finally {
    dispose()
    host.remove()
    if (previous === null) localStorage.removeItem(key)
    else localStorage.setItem(key, previous)
    if (previousModel === null) localStorage.removeItem(modelKey)
    else localStorage.setItem(modelKey, previousModel)
    mocks.forEach((mock) => mock.mockRestore())
  }
})
