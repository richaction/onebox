import type { Editor } from '@tiptap/core'
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { aiRevisionDiff, decodeAiAnswer } from '../core/aiAnswer'
import { aiReferenceRange, applyAiRevision, clearAiSource, previewAiChanges, type AiReference, type AiRevision } from '../core/aiDocument'
import { ai, type AiEvent } from '../io/ai'

type EditJob = { thread?: string; turn?: string; chunks: Map<string, string>; final?: string }

const actionPaths = {
  send: 'M8 13V3 M4 7l4-4 4 4',
  confirm: 'M3.5 8.5 6.5 11.5 12.5 5',
  undo: 'M6 4 3 7l3 3 M3 7h6.5a3 3 0 0 1 0 6H8',
  stop: 'M5 5h6v6H5z',
}

function ActionIcon(props: { name: keyof typeof actionPaths }) {
  return <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round">
    <path d={actionPaths[props.name]} />
  </svg>
}

export default function InlineAiEditor(props: {
  editor: Editor
  reference: AiReference & { anchor: number }
  scrollRoot: HTMLElement
  close: (restoreFocus: boolean) => void
}) {
  const [prompt, setPrompt] = createSignal('')
  const [working, setWorking] = createSignal(false)
  const [message, setMessage] = createSignal('')
  const [suggestion, setSuggestion] = createSignal<AiRevision>()
  const [inPlace, setInPlace] = createSignal(false)
  const [signedOut, setSignedOut] = createSignal(false)
  const [signingIn, setSigningIn] = createSignal(false)
  const [layout, setLayout] = createSignal<{ left: number; top: number; width: number }>()
  const diff = createMemo(() => {
    const revision = suggestion()
    if (revision) return aiRevisionDiff(props.reference.text, revision.markdown)
  })
  let panel!: HTMLElement
  let input!: HTMLTextAreaElement
  let dismiss: HTMLButtonElement | undefined
  let job: EditJob | undefined
  let login: string | undefined
  let listener: Promise<() => void> | undefined
  let disposed = false
  let frame = 0
  let focusFrame = 0
  let outsideClose: ReturnType<typeof setTimeout> | undefined

  const stopJob = (current: EditJob | undefined) => {
    if (current?.thread) {
      const { thread, turn } = current
      const stop = turn ? ai.stop(thread, turn).catch(() => {}) : Promise.resolve()
      void stop.then(() => ai.closeThread(thread)).catch(() => {})
    }
  }

  const fail = (error: unknown) => setMessage(error instanceof Error ? error.message : String(error))

  const receive = (event: AiEvent) => {
    if (disposed) return
    if (event.method === 'account/login/completed' && signingIn()) {
      if (login && event.params.loginId && login !== event.params.loginId) return
      login = undefined
      setSigningIn(false)
      if (event.params.success) {
        setSignedOut(false)
        setMessage('')
        input.focus({ preventScroll: true })
      } else fail(event.params.error || '登录失败，请重试。')
      return
    }
    const current = job
    if (!current) return
    if (event.method === 'disconnected') {
      job = undefined
      setWorking(false)
      setMessage('AI 连接已断开，可以重试。')
      return
    }
    if (!('params' in event) || !('threadId' in event.params) || event.params.threadId !== current.thread) return
    const turn = 'turn' in event.params ? event.params.turn.id : event.params.turnId
    if (current.turn && turn !== current.turn) return
    if (event.method === 'turn/started') current.turn = turn
    if (event.method === 'item/agentMessage/delta') {
      const { itemId, delta } = event.params
      current.chunks.set(itemId, (current.chunks.get(itemId) ?? '') + delta)
    }
    if (event.method === 'item/completed' && (!event.params.item.phase || event.params.item.phase === 'final_answer')) {
      current.final = event.params.item.text
    }
    if (event.method !== 'turn/completed') return

    job = undefined
    setWorking(false)
    void ai.closeThread(current.thread!).catch(() => {})
    if (event.params.turn.status !== 'completed') {
      setMessage(event.params.turn.error?.message || '生成未完成，可以重试。')
      return
    }
    const raw = current.final ?? Array.from(current.chunks.values()).at(-1) ?? ''
    const { revision } = decodeAiAnswer(raw)
    if (!revision || revision.reference !== 1 || revision.markdown.trim() === props.reference.text.trim()) {
      setMessage(revision?.reference === 1 ? '建议与原文相同。' : '没有收到针对选区的修改建议，可以调整要求后重试。')
      return
    }
    setSuggestion(revision)
    try { setInPlace(previewAiChanges(props.editor, props.reference, revision, diff() ?? [])) }
    catch { setInPlace(false) }
    schedule()
  }

  const listen = () => listener ??= ai.events(receive).catch((error: unknown) => {
    listener = undefined
    throw error
  })

  async function signIn() {
    if (signingIn()) return
    setSigningIn(true)
    setMessage('')
    try {
      await listen()
      if (disposed) return
      const id = await ai.login()
      if (disposed) await ai.cancelLogin(id)
      else if (signingIn()) login = id
    } catch (error) {
      if (!disposed) { setSigningIn(false); fail(error) }
    }
  }

  async function send() {
    const request = prompt().trim()
    if (!request || working() || signingIn() || signedOut()) return
    if (props.reference.shortened || !aiReferenceRange(props.editor, props.reference)) {
      setMessage('选区过长或原文已变化，请重新选取。')
      return
    }
    const current: EditJob = { chunks: new Map() }
    job = current
    setSuggestion(undefined)
    setMessage('')
    setWorking(true)
    dismiss?.focus({ preventScroll: true })
    try {
      await listen()
      if (job !== current) return
      const account = await ai.account()
      if (job !== current) return
      if (!account) {
        setSignedOut(true)
        throw new Error('请先登录 ChatGPT。')
      }
      const models = await ai.models()
      if (job !== current) return
      const preferred = localStorage.getItem('onebox.ai.model')
      const model = models.find((option) => option.model === preferred) ?? models.find((option) => option.isDefault) ?? models[0]
      if (!model) throw new Error('此账号暂无可用模型。')
      const savedEffort = localStorage.getItem(`onebox.ai.effort.${model.model}`)
      const effort = model.supportedReasoningEfforts?.find((option) => option.reasoningEffort === savedEffort)?.reasoningEffort
        ?? model.defaultReasoningEffort
      current.thread = await ai.newThread()
      if (job !== current) { stopJob(current); return }
      const inputText = JSON.stringify({
        request: `根据以下要求只修改引用 [1]。在 revision.markdown 中返回该选区的完整替换文本，保留未要求更改的 Markdown 格式和列表结构，将 revision.reference 设为 1。要求：${request}`,
        references: [{ number: 1, markdown: props.reference.text }],
      })
      const turn = await ai.start(current.thread, inputText, model.model, effort)
      if (job === current) current.turn = turn
      else if (disposed) { current.turn = turn; stopJob(current) }
    } catch (error) {
      if (job !== current) return
      job = undefined
      stopJob(current)
      setWorking(false)
      fail(error)
    }
  }

  function apply() {
    const next = suggestion()
    if (!next) return
    try {
      if (applyAiRevision(props.editor, next, 'replace', props.reference, 0)) props.close(true)
      else setMessage('原文已变化或建议的结构不适合该选区。可重新生成或取消。')
    } catch { setMessage('这条建议无法写入选区。') }
  }

  function position() {
    if (disposed || props.editor.isDestroyed) return
    const range = aiReferenceRange(props.editor, props.reference)
    if (!range) { setLayout(undefined); props.close(false); return }
    const root = props.scrollRoot
    const viewport = root.getBoundingClientRect()
    const body = props.editor.view.dom.getBoundingClientRect()
    const start = props.editor.view.coordsAtPos(range.from, 1)
    const end = props.editor.view.coordsAtPos(range.to, -1)
    const left = Math.max(viewport.left + 8, body.left)
    const width = Math.min(560, Math.max(0, Math.min(viewport.right - 8, body.right) - left))
    const height = panel.offsetHeight || 36
    const below = end.bottom + 6
    const above = start.top - height - 6
    const preferAbove = above >= viewport.top + 6 && (suggestion() || below + height > viewport.bottom)
    const top = Math.max(viewport.top + 6, Math.min(
      preferAbove ? above : below,
      viewport.bottom - height - 6,
    ))
    setLayout({ left, top, width })
  }
  const schedule = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(position)
  }

  onMount(() => {
    const resize = new ResizeObserver(schedule)
    resize.observe(panel)
    resize.observe(props.scrollRoot)
    props.editor.on('transaction', schedule)
    props.scrollRoot.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    const doc = panel.ownerDocument
    const closeOutside = (event: MouseEvent) => {
      if (event.button !== 0) return
      const path = event.composedPath()
      if (path.includes(panel) || path.some((node) => node instanceof Element && node.matches('.editor-selection-menu'))) return
      clearTimeout(outsideClose)
      // Let the clicked control or editor position receive its own click first.
      outsideClose = setTimeout(() => { if (!disposed) props.close(false) }, 0)
    }
    doc.addEventListener('click', closeOutside, true)
    position()
    const previousFocus = doc.activeElement
    input.focus({ preventScroll: true })
    if (doc.activeElement !== input) {
      const focusWhenVisible = () => {
        if (disposed || !input.isConnected || input.hidden || !layout() ||
          (doc.activeElement !== previousFocus && doc.activeElement !== doc.body)) return
        input.focus({ preventScroll: true })
      }
      queueMicrotask(() => {
        focusWhenVisible()
        if (!disposed && doc.activeElement !== input) focusFrame = requestAnimationFrame(focusWhenVisible)
      })
    }
    onCleanup(() => {
      resize.disconnect()
      props.editor.off('transaction', schedule)
      props.scrollRoot.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      doc.removeEventListener('click', closeOutside, true)
    })
  })

  onCleanup(() => {
    disposed = true
    cancelAnimationFrame(frame)
    cancelAnimationFrame(focusFrame)
    clearTimeout(outsideClose)
    if (listener) void listener.then((close) => close()).catch(() => {})
    if (login) void ai.cancelLogin(login).catch(() => {})
    stopJob(job)
    job = undefined
    clearAiSource(props.editor, props.reference.anchor)
  })

  return <section class="editor-inline-ai" aria-label="在正文中使用 AI 编辑" ref={panel}
    style={{
      left: `${layout()?.left ?? 0}px`, top: `${layout()?.top ?? 0}px`, width: `${layout()?.width ?? 0}px`,
      visibility: layout() ? 'visible' : 'hidden',
    }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && !event.isComposing) { event.stopPropagation(); props.close(true) }
    }}>
    <form class="editor-inline-ai-bar" onSubmit={(event) => { event.preventDefault(); void send() }}>
      <Show when={working()} fallback={<span class="editor-inline-ai-spark" aria-hidden="true">✨</span>}>
        <svg class="editor-inline-ai-loading" aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor"
          stroke-width="1.5" stroke-linecap="round">
          <path d="M12.8 4.5A5.9 5.9 0 1 1 5.1 2.9" />
        </svg>
      </Show>
      <textarea ref={input} rows={1} maxlength={4000} aria-label="修改要求" placeholder="使用 AI 编辑…"
        hidden={working() || !!suggestion()} value={prompt()} onInput={(event) => setPrompt(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault()
            void send()
          }
        }} />
      <Show when={working()}><span class="editor-inline-ai-status" role="status">正在工作…</span></Show>
      <Show when={suggestion()}>
        <span class="editor-inline-ai-status">修改建议已就绪</span>
      </Show>
      <Show when={!working() && !suggestion() && !signedOut()}>
        <button type="submit" class="editor-inline-ai-action editor-inline-ai-apply" aria-label="发送修改要求"
          title="发送修改要求" disabled={!prompt().trim()}><ActionIcon name="send" /></button>
      </Show>
      <Show when={working() || suggestion()}>
        <button type="button" ref={(button) => { dismiss = button }} class="editor-inline-ai-action editor-inline-ai-dismiss"
          aria-label={working() ? '停止生成' : '撤销预览'} title={working() ? '停止生成' : '撤销预览'}
          onClick={() => props.close(true)}>
          <ActionIcon name={working() ? 'stop' : 'undo'} />
        </button>
      </Show>
      <Show when={suggestion()}>
        <button type="button" class="editor-inline-ai-action editor-inline-ai-apply" aria-label="确认修改"
          title="确认修改" onClick={apply}><ActionIcon name="confirm" /></button>
      </Show>
    </form>
    <Show when={message()}><div class="editor-inline-ai-message" role="status">{message()}</div></Show>
    <Show when={signedOut()}><div class="editor-inline-ai-message">
      <button type="button" onClick={() => void signIn()} disabled={signingIn()}>
        {signingIn() ? '请在浏览器完成登录…' : '使用 ChatGPT 登录'}
      </button>
    </div></Show>
    <Show when={!inPlace() && diff()}>{(change) => <div class="editor-inline-ai-diff" aria-label="修改差异">
      <For each={change()}>{(part) => 'removed' in part && part.removed
        ? <del>{part.value}</del> : 'added' in part && part.added ? <ins>{part.value}</ins> : part.value}</For>
    </div>}</Show>
  </section>
}
