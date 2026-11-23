import { createComponent, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { expect, it, vi } from 'vitest'
import { ai } from '../src/io/ai'
import AiSidebar, { type AiConversationHistory } from '../src/ui/AiSidebar'
import AiComposerMenu from '../src/ui/AiComposerMenu'
import WorkspaceResizeHandle, { initialSidebarWidth } from '../src/ui/WorkspaceResizeHandle'

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
  const toggleList = () => host.querySelector<HTMLButtonElement>('[aria-label="会话列表"]')!.click()
  const latestDraft = '这是下一条问题。'
  try {
    draft().value = latestDraft
    draft().dispatchEvent(new Event('input', { bubbles: true }))
    host.querySelector<HTMLButtonElement>('[aria-label="新会话"]')!.click()
    expect(draft().value).toBe('')
    expect(host.textContent).not.toContain('大纲已整理。')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('可以开始新会话。')
    const newConversationId = history.active
    host.querySelector<HTMLButtonElement>('[aria-label="新会话"]')!.click()
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
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(options()).toHaveLength(1)
    options()[0].click()
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
    host.querySelector<HTMLButtonElement>('[aria-label="添加引用"]')!.click()
    expect(host.querySelector<HTMLButtonElement>('.ai-quote-popup button')?.disabled).toBe(true)
    const usage = host.querySelector<HTMLButtonElement>('.ai-usage-trigger')!
    const usageMenu = usage.parentElement!
    usageMenu.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }))
    expect(host.querySelector('.ai-usage-popup')).not.toBeNull()
    usage.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(host.querySelector('.ai-usage-popup')).not.toBeNull()
    usageMenu.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }))
    expect(host.querySelector('.ai-usage-popup')).toBeNull()
    usage.click()
    expect(host.querySelector('.ai-usage-popup')).not.toBeNull()
    expect(host.querySelector<HTMLButtonElement>('[aria-label="发送"]')?.disabled).toBe(true)
    host.querySelector<HTMLButtonElement>('[aria-label="收起对话"]')!.click()
    expect(onClose).toHaveBeenCalledTimes(1)
  } finally {
    dispose()
    host.remove()
    stopListening.mockRestore()
    account.mockRestore()
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
    button.click()
    expect(host.textContent).toContain('模型列表')

    button.parentElement!.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }))
    vi.advanceTimersByTime(250)
    expect(host.textContent).toContain('模型列表')

    button.click()
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
    const press = (key: string) => handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
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
