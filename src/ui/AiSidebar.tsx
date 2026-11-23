import type { Editor } from '@tiptap/core'
import { batch, createEffect, createMemo, createSignal, For, Index, on, onCleanup, onMount, Show } from 'solid-js'
import { createStore } from 'solid-js/store'
import { aiAnswerHtml, aiChangeText, decodeAiAnswer, partialAiAnswer } from '../core/aiAnswer'
import {
  applyAiRevision, captureAiInsertion, captureAiReference, clearAiAnchors, jumpToAiReference, undoAiRevision,
  type AiReference, type AiRevision, type AiUndo,
} from '../core/aiDocument'
import { ai, type AiAccount, type AiEvent, type AiModel, type AiNetwork, type AiUsage } from '../io/ai'
import AiComposerControls from './AiComposerControls'
import AiComposerMenu, { type ComposerMenu } from './AiComposerMenu'
import AiConversationMenu from './AiConversationMenu'
import WorkspaceResizeHandle, { initialSidebarWidth } from './WorkspaceResizeHandle'
import './aiSidebar.css'

type Request = { text: string; references: readonly AiReference[]; insertion: number }
type Message = {
  role: 'user' | 'assistant'
  text: string
  request: Request
  status?: 'working' | 'done' | 'stopped' | 'failed'
  revision?: AiRevision
  undo?: AiUndo
  change?: 'applied' | 'dismissed' | 'undone'
  error?: string
  reviewing?: boolean
}
type Conversation = { id: number; messages: Message[]; draft: string; references: AiReference[]; updatedAt?: number }
export type AiConversationHistory = { active: number; next: number; conversations: Conversation[] }
type Job = {
  index: number
  thread?: string
  turn?: string
  stopping?: boolean
  items: Map<string, string>
  final?: string
  latest?: string
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const excerpt = (text: string) => text.replace(/\s+/gu, ' ').slice(0, 70)
const NEW_CONVERSATION_READY = '可以开始新会话。'

function ChangeExcerpt(props: { before: string; after: string; side: 'before' | 'after' }) {
  const diff = createMemo(() => aiChangeText(props.before, props.after))
  return <pre>{diff().prefix}<mark>{props.side === 'before' ? diff().removed : diff().added}</mark>{diff().suffix}</pre>
}

export default function AiSidebar(props: {
  open: boolean
  loading: boolean
  title: string
  history: AiConversationHistory
  editor: () => Editor | undefined
  quote: AiReference | undefined
  pickReference: () => Promise<AiReference | undefined>
  onClose: () => void
  onQuoteConsumed: () => void
}) {
  const [sidebarWidth, setSidebarWidth] = createSignal(initialSidebarWidth('ai'))
  const [resizingSidebar, setResizingSidebar] = createSignal(false)
  const initial = props.history.conversations.find(({ id }) => id === props.history.active)
  const [conversationId, setConversationId] = createSignal(props.history.active)
  const [conversationUpdatedAt, setConversationUpdatedAt] = createSignal(initial?.updatedAt)
  const [conversations, setConversations] = createSignal(props.history.conversations)
  const [account, setAccount] = createSignal<AiAccount | null>()
  const [usage, setUsage] = createSignal<AiUsage>()
  const [models, setModels] = createSignal<AiModel[]>([])
  const [preferredModel, setPreferredModel] = createSignal(localStorage.getItem('onebox.ai.model'))
  const selectedModel = createMemo(() => models().find((model) => model.model === preferredModel())
    ?? models().find((model) => model.isDefault) ?? models()[0])
  const [efforts, setEfforts] = createStore<Record<string, string | undefined>>({})
  const selectedEffort = createMemo(() => {
    const model = selectedModel()
    return model?.supportedReasoningEfforts?.find((option) => option.reasoningEffort === efforts[model.model])?.reasoningEffort
  })
  const [menu, setMenu] = createSignal<ComposerMenu | 'conversations'>()
  const composerMenu = () => {
    const current = menu()
    return current === 'conversations' ? undefined : current
  }
  const [network, setNetwork] = createSignal<AiNetwork>()
  const [accountError, setAccountError] = createSignal('')
  const [modelError, setModelError] = createSignal('')
  const [usageError, setUsageError] = createSignal('')
  const [networkError, setNetworkError] = createSignal('')
  const [loadingAccount, setLoadingAccount] = createSignal(false)
  const [loadingModels, setLoadingModels] = createSignal(false)
  const [loadingUsage, setLoadingUsage] = createSignal(false)
  const [savingNetwork, setSavingNetwork] = createSignal(false)
  const [login, setLogin] = createSignal<string>()
  const [signingIn, setSigningIn] = createSignal(false)
  const [draft, setDraft] = createSignal(initial?.draft ?? '')
  const [references, setReferences] = createSignal<AiReference[]>(initial?.references ?? [])
  const [sourcePreview, setSourcePreview] = createSignal<AiReference>()
  const [notice, setNotice] = createSignal('')
  const [working, setWorking] = createSignal(false)
  const [stopping, setStopping] = createSignal(false)
  const [messages, setMessages] = createStore<Message[]>(initial?.messages.map((message) => ({ ...message })) ?? [])
  const savedConversations = createMemo(() => conversations().filter(({ id }) => id !== conversationId()).map((conversation) => ({
    id: conversation.id,
    title: excerpt(conversation.messages[0]?.text || conversation.draft) || '未发送的引用',
    updatedAt: conversation.updatedAt,
  })))
  const canSend = () => !working() && !savingNetwork() && !!props.editor()
    && !!account() && !!selectedModel() && !!draft().trim()
  let composer: HTMLTextAreaElement | undefined
  let log: HTMLDivElement | undefined
  let initialized: Promise<void> | undefined
  let unlisten: (() => void) | undefined
  let disposed = false
  let thread: string | undefined
  let job: Job | undefined
  let follow = true
  let scrollFrame = 0
  let streamFrame = 0
  let accountVersion = 0

  function scrollLatest() {
    if (!follow) return
    cancelAnimationFrame(scrollFrame)
    scrollFrame = requestAnimationFrame(() => { if (log) log.scrollTop = log.scrollHeight })
  }

  async function readUsage() {
    if (loadingUsage() || !account()) return
    const version = accountVersion
    setLoadingUsage(true)
    setUsageError('')
    try {
      const next = await ai.usage()
      if (!disposed && version === accountVersion) setUsage(next)
    } catch (error) {
      if (!disposed && version === accountVersion) setUsageError(errorText(error))
    } finally {
      if (version === accountVersion) setLoadingUsage(false)
    }
  }

  async function readModels() {
    if (loadingModels() || !account()) return
    const version = accountVersion
    setLoadingModels(true)
    setModelError('')
    try {
      const next = await ai.models()
      if (!disposed && version === accountVersion) {
        for (const model of next) setEfforts(model.model, localStorage.getItem(`onebox.ai.effort.${model.model}`) ?? undefined)
        setModels(next)
      }
    } catch (error) {
      if (!disposed && version === accountVersion) setModelError(errorText(error))
    } finally {
      if (version === accountVersion) setLoadingModels(false)
    }
  }

  function chooseModel(model: AiModel) {
    localStorage.setItem('onebox.ai.model', model.model)
    setPreferredModel(model.model)
  }

  function chooseEffort(effort?: string) {
    const model = selectedModel()
    if (!model) return
    const key = `onebox.ai.effort.${model.model}`
    if (effort) localStorage.setItem(key, effort)
    else localStorage.removeItem(key)
    setEfforts(model.model, effort)
  }

  function clearAccountData() {
    accountVersion++
    setModels([])
    setUsage(undefined)
    setLoadingModels(false)
    setLoadingUsage(false)
  }

  async function refreshAccount() {
    if (loadingAccount()) return
    setLoadingAccount(true)
    setAccountError('')
    try {
      await (initialized ??= ai.events(receive).then((close) => {
        if (disposed) close()
        else unlisten = close
      }, (error: unknown) => {
        initialized = undefined
        throw error
      }))
      const next = await ai.account()
      if (disposed) return
      if (!next || next.email !== account()?.email) clearAccountData()
      setAccount(next)
      if (next) {
        void readModels()
        void readUsage()
      }
    } catch (error) {
      if (!disposed) setAccountError(errorText(error))
    } finally {
      if (!disposed) setLoadingAccount(false)
    }
  }

  async function signIn() {
    if (signingIn() || loadingAccount() || savingNetwork() || working()) return
    setSigningIn(true)
    setAccountError('')
    try { setLogin(await ai.login()) }
    catch (error) { setAccountError(errorText(error)); setSigningIn(false) }
  }

  async function cancelSignIn() {
    const id = login()
    if (!id) return
    try { await ai.cancelLogin(id); setLogin(undefined); setSigningIn(false) }
    catch (error) { setAccountError(errorText(error)) }
  }

  async function signOut() {
    try {
      await ai.logout()
      clearAccountData()
      setAccount(null)
      resetChat()
    } catch (error) { setAccountError(errorText(error)) }
  }

  async function readNetwork() {
    if (savingNetwork()) return
    const version = accountVersion
    try {
      const next = await ai.network()
      if (!disposed && version === accountVersion && !savingNetwork()) {
        setNetwork(next)
        setNetworkError('')
      }
    } catch (error) {
      if (!disposed && version === accountVersion && !savingNetwork()) setNetworkError(errorText(error))
    }
  }

  async function setProxy(url: string | null) {
    if (savingNetwork() || working() || signingIn() || loadingAccount()) return
    setSavingNetwork(true)
    setNetworkError('')
    try {
      setNetwork(await ai.setProxy(url))
      thread = undefined
      clearAccountData()
      await refreshAccount()
    } catch (error) { setNetworkError(errorText(error)) }
    finally { setSavingNetwork(false) }
  }

  function complete(current: Job, status: 'done' | 'stopped' | 'failed', error?: string) {
    if (job !== current) return
    job = undefined
    cancelAnimationFrame(streamFrame)
    streamFrame = 0
    setWorking(false)
    setStopping(false)
    const raw = current.final ?? current.latest ?? ''
    const output = status === 'done' ? decodeAiAnswer(raw) : { answer: partialAiAnswer(raw) }
    setMessages(current.index, {
      text: output.answer, revision: output.revision, status,
      error: error ?? (status === 'done' && !output.answer && !output.revision ? '没有收到回复，可以重试。' : undefined),
    })
    scrollLatest()
  }

  function receive(event: AiEvent) {
    if (disposed) return
    switch (event.method) {
      case 'disconnected':
        if (job) complete(job, 'failed', 'Codex 已断开，请重试。')
        thread = undefined
        setSigningIn(false)
        setLogin(undefined)
        return
      case 'account/updated':
        void refreshAccount()
        return
      case 'account/login/completed':
        setSigningIn(false)
        setLogin(undefined)
        if (!event.params.success && event.params.error) setAccountError(event.params.error)
        else void refreshAccount()
        return
      case 'account/rateLimits/updated':
        if (account() && (!event.params.rateLimits.limitId || event.params.rateLimits.limitId === 'codex')) {
          setUsage(event.params.rateLimits)
        }
        return
    }

    const current = job
    if (!current || current.thread !== event.params.threadId) return
    const currentTurn = 'turn' in event.params ? event.params.turn.id : event.params.turnId
    if (current.turn && currentTurn !== current.turn) return
    switch (event.method) {
      case 'turn/started':
        current.turn = event.params.turn.id
        if (current.stopping) void interrupt(current)
        return
      case 'item/agentMessage/delta': {
        const { itemId, delta } = event.params
        const raw = (current.items.get(itemId) ?? '') + delta
        current.items.set(itemId, raw)
        current.latest = raw
        if (!streamFrame) streamFrame = requestAnimationFrame(() => {
          streamFrame = 0
          if (job !== current) return
          const next = partialAiAnswer(current.latest ?? '')
          if (next) setMessages(current.index, 'text', next)
          scrollLatest()
        })
        return
      }
      case 'item/completed':
        if (event.params.item.phase === 'final_answer' || !event.params.item.phase) {
          current.final = event.params.item.text
        }
        return
      case 'turn/completed': {
        const { status, error } = event.params.turn
        if (status === 'completed') complete(current, 'done')
        else if (status === 'interrupted' || current.stopping) complete(current, 'stopped')
        else complete(current, 'failed', error?.message || '生成失败，可以重试。')
      }
    }
  }

  async function interrupt(current: Job) {
    if (!current.thread || !current.turn) return
    try { await ai.stop(current.thread, current.turn) }
    catch (error) {
      if (job === current) {
        current.stopping = false
        setStopping(false)
        setNotice(errorText(error))
      }
    }
  }

  function stop() {
    if (!job || job.stopping) return
    job.stopping = true
    setStopping(true)
    void interrupt(job)
  }

  function addReference(reference?: AiReference) {
    if (!reference) { setNotice('这里没有可引用的文字。'); return }
    const existing = references()
    if (existing.some(({ label, text }) => label === reference.label && text === reference.text)) return
    const remaining = 27_000 - existing.reduce((size, item) => size + item.text.length, 0)
    if (remaining < 100 || existing.length >= 6) { setNotice('引用已满，请先移除一条。'); return }
    const next: AiReference = reference.text.length > remaining
      ? { ...reference, text: reference.text.slice(0, remaining), shortened: true }
      : reference
    setNotice('')
    setReferences([...existing, next])
    setConversationUpdatedAt(Date.now())
  }

  function quote(kind: 'selection' | 'block' | 'page') {
    const editor = props.editor()
    if (editor) addReference(captureAiReference(editor, kind, props.title))
  }

  function jump(reference: AiReference) {
    if (reference.external) { setSourcePreview(reference); return }
    const editor = props.editor()
    if (!editor || !jumpToAiReference(editor, reference)) {
      setSourcePreview(reference)
      setNotice('原文已变化，正在显示引用时保存的文字。')
    } else setNotice('')
  }

  async function generate(request: Request, index: number) {
    const model = selectedModel()
    if (!model) return
    const effort = selectedEffort() ?? model.defaultReasoningEffort
    const current: Job = { index, items: new Map() }
    job = current
    setWorking(true)
    setStopping(false)
    setNotice('')
    follow = true
    scrollLatest()
    try {
      const recentConversation = thread ? undefined : messages.slice(0, index - 1)
        .filter((message) => message.text && (message.role === 'user' || message.status === 'done'))
        .slice(-6).map((message) => ({ role: message.role, text: message.text.slice(0, 900) }))
      if (!thread) {
        const opened = await ai.newThread()
        if (disposed || job !== current) { void ai.closeThread(opened).catch(() => {}); return }
        thread = opened
      }
      current.thread = thread
      if (current.stopping) { complete(current, 'stopped'); return }
      const input = JSON.stringify({
        request: request.text,
        recentConversation: recentConversation?.length ? recentConversation : undefined,
        references: request.references.map((item, index) => ({
          number: index + 1, title: item.label, markdown: item.text, excerpt: !!item.shortened,
        })),
      })
      const turn = await ai.start(current.thread, input, model.model, effort)
      if (disposed || job !== current) {
        if (disposed) void ai.stop(current.thread, turn).catch(() => {})
        return
      }
      const hasStarted = !!current.turn
      current.turn = turn
      if (current.stopping && !hasStarted) void interrupt(current)
    } catch (error) {
      complete(current, current.stopping ? 'stopped' : 'failed', errorText(error))
    }
  }

  function send() {
    const editor = props.editor()
    if (!editor || !canSend()) return
    const text = draft().trim()
    const request = { text, references: references(), insertion: captureAiInsertion(editor) }
    const index = messages.length
    setMessages(index, { role: 'user', text, request })
    setMessages(index + 1, { role: 'assistant', text: '', request, status: 'working' })
    setDraft('')
    setConversationUpdatedAt(Date.now())
    setReferences([])
    setSourcePreview(undefined)
    void generate(request, index + 1)
  }

  function retry(index: number) {
    const message = messages[index]
    if (!message || working() || savingNetwork() || !account() || !selectedModel()) return
    setMessages(index, { text: '', status: 'working', revision: undefined, error: undefined })
    void generate(message.request, index)
  }

  function disconnectThread() {
    if (thread) void ai.closeThread(thread).catch(() => {})
    thread = undefined
  }

  function rememberConversation() {
    const id = conversationId()
    const other = conversations().filter((conversation) => conversation.id !== id)
    const draftText = draft()
    const quoted = references()
    if (messages.length || draftText.trim() || quoted.length) {
      const transcript = messages.map((message): Message => ({
        ...message, status: message.status === 'working' ? 'stopped' : message.status,
      }))
      other.unshift({ id, messages: transcript, draft: draftText, references: quoted, updatedAt: conversationUpdatedAt() })
    }
    props.history.conversations = other
    props.history.active = id
    return other
  }

  function showConversation(id: number, conversation?: Conversation) {
    props.history.active = id
    batch(() => {
      setConversationId(id)
      setConversationUpdatedAt(conversation?.updatedAt)
      setMessages(conversation?.messages.map((message) => ({ ...message })) ?? [])
      setReferences(conversation?.references ?? [])
      setDraft(conversation?.draft ?? '')
      setSourcePreview(undefined)
      setNotice('')
      setMenu(undefined)
    })
    follow = true
    composer?.focus({ preventScroll: true })
    scrollLatest()
  }

  function switchConversation(id: number) {
    if (working() || conversationId() === id) return
    disconnectThread()
    const saved = rememberConversation()
    setConversations(saved)
    showConversation(id, saved.find((conversation) => conversation.id === id))
  }

  function startConversation() {
    if (working()) return
    if (messages.length || draft().trim() || references().length) switchConversation(++props.history.next)
    else {
      setMenu(undefined)
      composer?.focus({ preventScroll: true })
    }
    setNotice(NEW_CONVERSATION_READY)
  }

  function resetChat() {
    if (working()) return
    disconnectThread()
    const editor = props.editor()
    if (editor) clearAiAnchors(editor)
    props.history.conversations = []
    setConversations([])
    showConversation(++props.history.next)
  }

  function changeReference(message: Message) {
    const id = message.revision?.reference
    return id == null ? undefined : message.request.references[id - 1]
  }

  function apply(index: number, method: 'replace' | 'below') {
    const editor = props.editor()
    const message = messages[index]
    if (!editor || !message?.revision || message.change === 'applied') return
    try {
      const undo = applyAiRevision(editor, message.revision, method, changeReference(message), message.request.insertion)
      if (!undo) {
        setNotice(method === 'replace' ? '无法安全替换。原文可能已更改，也可以选择插入下方。' : '插入位置已变化，请重新发起请求。')
        return
      }
      setMessages(index, { undo, change: 'applied', reviewing: false })
      setNotice('')
    } catch { setNotice('无法将这条建议写入 Markdown。') }
  }

  function undo(index: number) {
    const editor = props.editor()
    const change = messages[index]?.undo
    if (!editor || !change || !undoAiRevision(editor, change)) {
      setNotice('应用后的文字已变化，无法单独撤销这条建议。')
      return
    }
    setMessages(index, { undo: undefined, change: 'undone' })
    setNotice('')
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice('已复制。') }
    catch { setNotice('复制失败。') }
  }

  createEffect(on(() => props.open, (open) => {
    if (!open) { setMenu(undefined); return }
    if (!initialized) void refreshAccount()
    queueMicrotask(scrollLatest)
  }))
  createEffect(on(() => props.open && !props.loading, (ready) => {
    if (ready) queueMicrotask(() => {
      if (props.open && !props.loading && !menu()) composer?.focus({ preventScroll: true })
    })
  }))
  createEffect(on(() => props.quote, (reference) => {
    if (!reference) return
    addReference(reference)
    props.onQuoteConsumed()
    queueMicrotask(() => composer?.focus({ preventScroll: true }))
  }))
  onMount(() => {
    const closeOutside = (event: PointerEvent) => {
      const open = menu()
      if (open && !event.composedPath().some((node) => node instanceof HTMLElement && node.dataset.aiComposerMenu === open)) {
        setMenu(undefined)
      }
    }
    document.addEventListener('pointerdown', closeOutside, true)
    onCleanup(() => document.removeEventListener('pointerdown', closeOutside, true))
  })
  onCleanup(() => {
    rememberConversation()
    disposed = true
    unlisten?.()
    cancelAnimationFrame(scrollFrame)
    cancelAnimationFrame(streamFrame)
    if (job) void interrupt(job)
    disconnectThread()
  })

  return (
    <aside id="onebox-ai-sidebar" class="ai-sidebar" classList={{ 'ai-sidebar-resizing': resizingSidebar() }}
      aria-label="Onebox AI" hidden={!props.open} style={{ '--ai-preferred-width': `${sidebarWidth()}px` }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
        event.preventDefault()
        const details = (event.target as HTMLElement).closest<HTMLDetailsElement>('details[open]')
        if (details) {
          details.open = false
          details.querySelector('summary')?.focus({ preventScroll: true })
        } else if (menu()) {
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-ai-composer-menu="${menu()}"] > button`)?.focus({ preventScroll: true })
          setMenu(undefined)
        } else if (sourcePreview()) setSourcePreview(undefined)
        else props.onClose()
      }}>
      <Show when={props.open}>
        <WorkspaceResizeHandle sidebar="ai" width={sidebarWidth()} onWidth={setSidebarWidth} onResize={setResizingSidebar} />
      </Show>
      <header class="ai-sidebar-header">
        <AiConversationMenu current={{ id: conversationId(), title: excerpt(messages[0]?.text || '') || '新会话', updatedAt: conversationUpdatedAt() }}
          history={savedConversations()} open={menu() === 'conversations'} disabled={working()}
          onToggle={() => setMenu(menu() === 'conversations' ? undefined : 'conversations')}
          onDismiss={() => { if (menu() === 'conversations') setMenu(undefined) }}
          onSelect={(id) => { setMenu(undefined); if (id === conversationId()) composer?.focus({ preventScroll: true }); else switchConversation(id) }} />
        <button class="ai-subtle" type="button" title="新会话" aria-label="新会话" disabled={working()} onClick={startConversation}>＋</button>
        <button class="ai-subtle" type="button" title="收起对话" aria-label="收起对话" onClick={props.onClose}>
          <span class="ai-toggle-collapse" aria-hidden="true" />
        </button>
      </header>

      <Show when={props.loading}><div class="ai-document-loading" role="status">正在载入文档…</div></Show>

      <Show when={sourcePreview()} keyed>{(source) =>
        <div class="ai-source-preview">
          <header><strong>{source.label}</strong><button class="ai-subtle" type="button" aria-label="关闭引用预览" onClick={() => setSourcePreview(undefined)}>×</button></header>
          <pre>{source.text}</pre>
        </div>
      }</Show>

      <div class="ai-chat" ref={log} aria-label="AI 对话" inert={props.loading} onScroll={(event) => {
        const el = event.currentTarget
        follow = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      }}>
        <Index each={messages}>{(message, index) =>
          <article class="ai-message" classList={{ 'ai-message-user': message().role === 'user' }}>
            <Show when={message().role === 'user'} fallback={
              <>
                <Show when={message().status === 'working'} fallback={
                  <Show when={message().text}>
                    <div class="ai-answer" innerHTML={aiAnswerHtml(message().text, message().request.references.length)}
                      onClick={(event) => {
                        const citation = (event.target as Element).closest<HTMLElement>('[data-reference]')
                        const value = citation && message().request.references[Number(citation.dataset.reference)]
                        if (value) jump(value)
                      }} />
                  </Show>
                }>
                  <div class="ai-stream" aria-live="off">{message().text || '正在生成…'}</div>
                </Show>
                <Show when={message().status === 'stopped'}><div class="ai-message-status">已停止</div></Show>
                <Show when={message().error}><div class="ai-message-status ai-error" role="status">{message().error}</div></Show>
                <Show when={message().revision}>
                  {(patch) => <div class="ai-change">
                    <div class="ai-change-title">
                      <strong>{message().change === 'applied' ? '已应用到文档' : message().change === 'undone' ? '已撤销' : message().change === 'dismissed' ? '已放弃建议' : '建议变更'}</strong>
                      <Show when={message().undo}><button type="button" class="ai-subtle" onClick={() => undo(index)}>撤销</button></Show>
                    </div>
                    <Show when={!message().change}>
                      <Show when={changeReference(message())?.anchor}>
                        <div class="ai-change-before"><span>原文</span>
                          <ChangeExcerpt before={changeReference(message())?.text ?? ''} after={patch().markdown} side="before" />
                        </div>
                      </Show>
                      <div class="ai-change-after"><span>建议</span>
                        <Show when={message().reviewing} fallback={
                          <ChangeExcerpt before={changeReference(message())?.anchor ? changeReference(message())!.text : ''} after={patch().markdown} side="after" />
                        }>
                          <textarea aria-label="编辑建议的 Markdown" rows={4} value={patch().markdown} maxLength={120_000}
                            onInput={(event) => setMessages(index, 'revision', { ...patch(), markdown: event.currentTarget.value })} />
                        </Show>
                      </div>
                      <div class="ai-row ai-change-actions">
                        <Show when={changeReference(message())?.anchor && !changeReference(message())?.shortened}>
                          <button type="button" class="ai-primary" onClick={() => apply(index, 'replace')}>替换原文</button>
                        </Show>
                        <button type="button" class="ai-subtle" onClick={() => apply(index, 'below')}>插入下方</button>
                        <button type="button" class="ai-subtle" aria-expanded={!!message().reviewing}
                          onClick={() => setMessages(index, 'reviewing', !message().reviewing)}>{message().reviewing ? '查看对照' : '编辑建议'}</button>
                        <button type="button" class="ai-subtle" onClick={() => setMessages(index, { change: 'dismissed', reviewing: false })}>放弃</button>
                      </div>
                    </Show>
                    <Show when={message().change === 'dismissed' || message().change === 'undone'}>
                      <button type="button" class="ai-subtle" onClick={() => setMessages(index, 'change', undefined)}>查看建议</button>
                    </Show>
                  </div>}
                </Show>
                <Show when={message().status !== 'working'}>
                  <div class="ai-row ai-reply-actions">
                    <Show when={message().text}><button type="button" class="ai-subtle" onClick={() => void copy(message().text)}>复制回复</button></Show>
                    <Show when={message().status === 'failed' || message().status === 'stopped' || message().error}>
                      <button type="button" class="ai-subtle" disabled={working() || savingNetwork() || !selectedModel() || index !== messages.length - 1} onClick={() => retry(index)}>重试</button>
                    </Show>
                  </div>
                </Show>
              </>
            }>
              <Show when={message().request.references.length}>
                <div class="ai-sent-references">
                  <For each={message().request.references}>{(ref, offset) =>
                    <button type="button" class="ai-source" onClick={() => jump(ref)} title={excerpt(ref.text)}>[{offset() + 1}] {ref.label}</button>
                  }</For>
                </div>
              </Show>
              <div>{message().text}</div>
            </Show>
          </article>
        }</Index>
      </div>

      <form class="ai-compose" onSubmit={(event) => { event.preventDefault(); send() }}>
        <Show when={notice()}><div class="ai-notice" role="status">{notice()}</div></Show>
        <Show when={references().length}>
          <div class="ai-references">
            <For each={references()}>{(ref, index) =>
              <div class="ai-reference">
                <button type="button" class="ai-reference-link" title={excerpt(ref.text)} onClick={() => jump(ref)}>
                  <strong>{ref.label}{ref.shortened ? '（节选）' : ''}</strong>
                  <span>{excerpt(ref.text)}</span>
                </button>
                <button type="button" class="ai-subtle" aria-label={`移除引用 ${ref.label}`} onClick={() => setReferences((items) => items.filter((_, i) => i !== index()))}>×</button>
              </div>
            }</For>
          </div>
        </Show>
        <textarea ref={composer} aria-label="向 AI 提问" placeholder="问 Onebox AI…" rows={2} maxLength={4000}
          value={draft()} onInput={(event) => {
            setDraft(event.currentTarget.value)
            setConversationUpdatedAt(Date.now())
            if (notice() === NEW_CONVERSATION_READY) setNotice('')
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
              event.preventDefault()
              send()
            }
          }} />
        <div class="ai-compose-actions">
          <AiComposerMenu kind="quote" label="添加引用" open={menu() === 'quote'}
            onToggle={() => setMenu(menu() === 'quote' ? undefined : 'quote')}
            onDismiss={() => { if (menu() === 'quote') setMenu(undefined) }}
            trigger={<span class="ai-add-symbol" aria-hidden="true" />}>
            <div>
              <button class="ai-popup-option" type="button" disabled={!props.editor()} onClick={() => { quote('selection'); setMenu(undefined) }}>选中文字</button>
              <button class="ai-popup-option" type="button" disabled={!props.editor()} onClick={() => { quote('block'); setMenu(undefined) }}>当前区块</button>
              <button class="ai-popup-option" type="button" disabled={!props.editor()} onClick={() => { quote('page'); setMenu(undefined) }}>当前文档</button>
              <button class="ai-popup-option" type="button" onClick={() => {
                setMenu(undefined)
                void props.pickReference().then((reference) => {
                  if (!disposed && reference) addReference(reference)
                }).catch((error) => { if (!disposed) setNotice(errorText(error)) })
              }}>选取 Markdown 文件…</button>
            </div>
          </AiComposerMenu>
          <AiComposerControls account={account()} models={models()} model={selectedModel()} usage={usage()} network={network()}
            effort={selectedEffort()} menu={composerMenu()} onMenu={setMenu} onChooseEffort={chooseEffort}
            loadingAccount={loadingAccount()} loadingModels={loadingModels()} loadingUsage={loadingUsage()}
            working={working()} savingNetwork={savingNetwork()} signingIn={signingIn()} canCancelLogin={!!login()}
            accountError={accountError()} modelError={modelError()} usageError={usageError()} networkError={networkError()}
            onOpenSettings={() => void readNetwork()} onChooseModel={chooseModel}
            onSignIn={() => void signIn()} onCancelSignIn={() => void cancelSignIn()} onSignOut={() => void signOut()}
            onRefreshModels={() => void readModels()} onRefreshUsage={() => void readUsage()}
            onRefreshAccount={() => void refreshAccount()} onSetProxy={(url) => void setProxy(url)} />
          <Show when={working()} fallback={
            <button class="ai-composer-trigger ai-send" type="submit" aria-label="发送" title="发送" disabled={!canSend()}>
              <span class="ai-send-symbol" aria-hidden="true" />
            </button>
          }>
            <button class="ai-composer-trigger ai-send ai-send-stop" type="button" disabled={stopping()} onClick={stop}
              aria-label={stopping() ? '正在停止' : '停止生成'} title="停止生成"><span aria-hidden="true" /></button>
          </Show>
        </div>
      </form>
    </aside>
  )
}
