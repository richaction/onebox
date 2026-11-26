import type { Editor } from '@tiptap/core'
import { createSignal, onCleanup, onSettled, Show } from 'solid-js'
import { decodeAiAnswer } from '../core/aiAnswer'
import { resolveSavedReasoningEffort } from '../core/aiReasoning'
import { aiReferenceRange, applyAiRevision, clearAiSource, previewInlineAiRevision, type AiReference, type AiRevision } from '../core/aiDocument'
import { closeEmptyContinuation } from '../core/editorCaret'
import { ai, type AiEvent } from '../io/ai'
import { isClickFromRelease } from '../core/buttonClickTolerance'
type EditJob = { thread?: string; turn?: string; chunks: Map<string, string>; final?: string; released?: true }

const actionPaths = {
  send: 'M8 13V3 M4 7l4-4 4 4',
  confirm: 'M3.5 8.5 6.5 11.5 12.5 5',
  undo: 'M6 4 3 7l3 3 M3 7h6.5a3 3 0 0 1 0 6H8',
  stop: 'M4.5 3.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z',
}

function ActionIcon(props: { name: keyof typeof actionPaths }) {
  return <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round">
    <path d={actionPaths[props.name]} fill={props.name === 'stop' ? 'currentColor' : undefined}
      stroke={props.name === 'stop' ? 'none' : undefined} />
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
  const [summary, setSummary] = createSignal('')
  const [signedOut, setSignedOut] = createSignal(false)
  const [signingIn, setSigningIn] = createSignal(false)
  const [layout, setLayout] = createSignal<{ left: number; top: number; width: number }>()
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

  const releaseJob = (current: EditJob, interrupt = false) => {
    if (!current.thread || current.released) return
    const { thread, turn } = current
    current.released = true
    const stop = interrupt && turn ? ai.stop(thread, turn).catch(() => {
      if (!disposed && !job && !suggestion()) setMessage('停止请求未获确认。')
    }) : Promise.resolve()
    void stop.then(() => ai.closeThread(thread)).catch(() => {})
  }

  function stop() {
    const current = job
    if (!current) return
    job = undefined
    if (current.turn) releaseJob(current, true)
    setWorking(false)
    setMessage('已停止生成。')
    queueMicrotask(() => { if (!disposed && !job) input.focus({ preventScroll: true }) })
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
    releaseJob(current)
    if (event.params.turn.status !== 'completed') {
      setMessage(event.params.turn.error?.message || '生成未完成，可以重试。')
      return
    }
    const raw = current.final ?? Array.from(current.chunks.values()).at(-1) ?? ''
    const { revision, answer } = decodeAiAnswer(raw)
    if (!revision || revision.reference !== 1 || revision.markdown.trim() === props.reference.text.trim()) {
      setMessage(revision?.reference === 1 ? '建议与原文相同。' : '没有收到针对选区的修改建议，可以调整要求后重试。')
      return
    }
    try {
      if (previewInlineAiRevision(props.editor, props.reference, revision)) {
        setSummary(answer.replace(/\s+/gu, ' ').trim().slice(0, 160) || '修改建议已就绪')
        setSuggestion(revision)
        schedule()
        return
      }
    } catch { /* Keep the original when the replacement cannot be previewed. */ }
    setMessage('原文已变化或建议的结构不适合该选区，可以调整要求后重试。')
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
      const effort = resolveSavedReasoningEffort(model, savedEffort) ?? model.defaultReasoningEffort
      current.thread = await ai.newThread()
      if (job !== current) { releaseJob(current); return }
      const inputText = JSON.stringify({
        request: `${props.reference.emptyLine
          ? '引用 [1] 是空白行。根据要求为该行生成内容，在 revision.markdown 中返回要填入的 Markdown。'
          : '根据以下要求只修改引用 [1]。在 revision.markdown 中返回该选区的完整替换文本，保留未要求更改的 Markdown 格式和列表结构。'}将 revision.reference 设为 1。请在 answer 中用一句纯文本简述改动。要求：${request}`,
        references: [{ number: 1, markdown: props.reference.text }],
      })
      const turn = await ai.start(current.thread, inputText, model.model, effort)
      current.turn = turn
      if (job !== current) releaseJob(current, true)
    } catch (error) {
      releaseJob(current, true)
      if (job !== current) return
      job = undefined
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
    const content = props.editor.view.dom.getBoundingClientRect()
    const start = props.editor.view.coordsAtPos(props.reference.emptyLine ? range.from + 1 : range.from, 1)
    const end = props.reference.emptyLine ? start : props.editor.view.coordsAtPos(range.to, -1)
    const left = Math.max(viewport.left, content.left)
    const width = Math.max(0, Math.min(viewport.right, content.right) - left)
    const height = panel.offsetHeight || 31
    const below = end.bottom + 6
    const above = start.top - height - 6
    const review = suggestion() && props.editor.view.dom.querySelector('.editor-ai-review-anchor')
    const preferAbove = above >= viewport.top + 6 && below + height > viewport.bottom
    const targetTop = review ? review.getBoundingClientRect().top
      : props.reference.emptyLine ? (start.top + start.bottom - height) / 2
      : preferAbove ? above : below
    const top = Math.max(viewport.top + 6, Math.min(targetTop, viewport.bottom - height - 6))
    setLayout({ left, top, width })
  }
  const schedule = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(position)
  }

  onSettled(() => {
    const resize = new ResizeObserver(schedule)
    resize.observe(panel)
    resize.observe(props.scrollRoot)
    props.editor.on('transaction', schedule)
    props.scrollRoot.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    const doc = panel.ownerDocument
    let insidePointer: number | undefined
    let insideRelease: PointerEvent | undefined
    const press = (event: PointerEvent) => {
      if (event.defaultPrevented || !event.isPrimary || event.button !== 0) return
      const inside = event.composedPath().includes(panel)
      insidePointer = inside ? event.pointerId : undefined
      insideRelease = undefined
      if (!inside && !suggestion()) props.close(false)
    }
    const release = (event: PointerEvent) => {
      if (event.pointerId !== insidePointer) return
      insidePointer = undefined
      insideRelease = event.type === 'pointerup' ? event : undefined
    }
    const click = (event: MouseEvent) => {
      if (event.button !== 0) return
      // A press on the panel border can end with a native click on a common ancestor.
      if (event.composedPath().includes(panel) || (insideRelease && isClickFromRelease(event, insideRelease))) return
      // Removing the in-document diff can reflow the text under the pointer.
      clearTimeout(outsideClose)
      outsideClose = setTimeout(() => props.close(false), 0)
    }
    doc.addEventListener('pointerdown', press, true)
    doc.addEventListener('pointerup', release, true)
    doc.addEventListener('pointercancel', release, true)
    doc.addEventListener('click', click, true)
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
    return () => {
      resize.disconnect()
      props.editor.off('transaction', schedule)
      props.scrollRoot.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      doc.removeEventListener('pointerdown', press, true)
      doc.removeEventListener('pointerup', release, true)
      doc.removeEventListener('pointercancel', release, true)
      doc.removeEventListener('click', click, true)
    }
  })

  onCleanup(() => {
    disposed = true
    cancelAnimationFrame(frame)
    cancelAnimationFrame(focusFrame)
    clearTimeout(outsideClose)
    if (listener) void listener.then((close) => close()).catch(() => {})
    if (login) void ai.cancelLogin(login).catch(() => {})
    if (job?.turn) releaseJob(job, true)
    job = undefined
    if (props.reference.emptyLine && !props.editor.isDestroyed && !props.editor.view.hasFocus()) {
      const range = aiReferenceRange(props.editor, props.reference)
      if (range) closeEmptyContinuation(props.editor.view, range.from)
    }
    clearAiSource(props.editor, props.reference.anchor)
  })

  return <section class="editor-inline-ai" aria-label="在正文中使用 AI 编辑" ref={panel} data-activate-on-release
    style={{
      left: `${layout()?.left ?? 0}px`, top: `${layout()?.top ?? 0}px`, width: `${layout()?.width ?? 0}px`,
      visibility: layout() ? 'visible' : 'hidden',
    }}
    onPointerDown={(event) => {
      const target = event.target as Element
      if (event.button !== 0 || input.hidden || target.closest('textarea, button, a') ||
        (target !== panel && !target.closest('.editor-inline-ai-bar'))) return
      event.preventDefault()
      input.focus({ preventScroll: true })
    }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && !event.isComposing) { event.stopPropagation(); props.close(true) }
    }}>
    <form class={['editor-inline-ai-bar', { 'editor-inline-ai-review': !!suggestion() }]}
      onSubmit={(event) => { event.preventDefault(); void send() }}>
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
        <span class="editor-inline-ai-summary" title={summary()}>{summary()}</span>
      </Show>
      <Show when={!working() && !suggestion() && !signedOut()}>
        <button type="submit" class="editor-inline-ai-action editor-inline-ai-send" aria-label="发送修改要求"
          title="发送修改要求" disabled={!prompt().trim()}><ActionIcon name="send" /></button>
      </Show>
      <Show when={working() || suggestion()}>
        <button type="button" ref={(button) => { dismiss = button }}
          class={['editor-inline-ai-action editor-inline-ai-dismiss', { 'editor-inline-ai-stop': working() }]}
          aria-label={working() ? '停止生成' : '撤销预览'} title={working() ? '停止生成' : '撤销预览'}
          onClick={() => working() ? stop() : props.close(true)}>
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
  </section>
}
