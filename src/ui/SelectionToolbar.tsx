import type { ChainedCommands, Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { Selection, TextSelection, type Selection as EditorSelection } from '@tiptap/pm/state'
import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js'
import { blockCommands } from '../core/blockCommands'

export const selectionToolbarWidth = 214
export const selectionToolbarHeight = 128
export const selectionToolbarFormat = 'onebox:selection-toolbar-format'

type Action = (chain: ChainedCommands) => ChainedCommands
type Panel = 'main' | 'blocks' | 'link' | 'more'

const blockTypes = blockCommands.map((item) => ({
  ...item,
  active: (editor: Editor) => {
    if (item.shortcut?.startsWith('#')) return editor.isActive('heading', { level: item.shortcut.length })
    if (item.icon === 'T') return editor.isActive('paragraph') &&
      !['listItem', 'blockquote'].some((type) => editor.isActive(type))
    const task = editor.isActive('listItem') && !editor.isActive('listItem', { checked: null })
    if (item.icon === '☑') return task
    if (item.icon === '☷') return editor.isActive('bulletList') && !task
    if (item.icon === '❝') return editor.isActive('blockquote', { variant: null })
    return item.icon === '≡' ? editor.isActive('orderedList') && !task : editor.isActive('codeBlock')
  },
}))

const inlineMarks = [
  { name: '高亮', symbol: 'A', mark: 'highlight' },
  { name: '粗体', symbol: 'B', mark: 'bold' },
  { name: '斜体', symbol: 'I', mark: 'italic' },
  { name: '下划线', symbol: 'U', mark: 'underline' },
] as const

function asText(selection: EditorSelection) {
  if (selection instanceof TextSelection) return selection
  const { $from, $to } = selection
  const start = Selection.findFrom($from, 1, true)
  const end = Selection.findFrom($to, -1, true)
  if (!start || !end || start.from < selection.from || end.to > selection.to || start.from > end.to) return
  return TextSelection.create($from.doc, start.from, end.to)
}

export default function SelectionToolbar(props: {
  editor: Editor
  selection: EditorSelection
  x: number
  y: number
  above: boolean
  width: number
  maxHeight: number
  ref: (element: HTMLDivElement) => void
  onClose: () => void
  onAiEdit?: (event: MouseEvent) => boolean
}) {
  const [panel, setPanel] = createSignal<Panel>('main')
  const [linkError, setLinkError] = createSignal(false)
  const [copyError, setCopyError] = createSignal(false)
  const [aiError, setAiError] = createSignal(false)
  const editor = props.editor
  const textSelection = createMemo(() => asText(props.selection))
  const canMark = () => {
    const selection = textSelection()
    return !!selection && !selection.empty && !editor.isActive('codeBlock')
  }
  const latex = createMemo(() => {
    const selection = textSelection()
    return selection && canMark() && selection.$from.sameParent(selection.$to)
      ? selection.$from.doc.textBetween(selection.from, selection.to).trim() : ''
  })
  const activeBlock = blockTypes.find(({ active }) => active(editor))
  const inQuote = editor.isActive('blockquote')
  const listType = editor.isActive('orderedList') ? 'orderedList' : editor.isActive('bulletList') ? 'bulletList' : undefined
  const quoteVariant = editor.getAttributes('blockquote').variant
  const typeLabel = quoteVariant === 'note' ? '标注' : quoteVariant === 'fold'
    ? (activeBlock?.icon.startsWith('H') ? `折叠${activeBlock.label}` : '折叠区块') : activeBlock?.label
  const valid = () => editor.isEditable && editor.state.doc === props.selection.$from.doc

  const run = (action: Action, keepOpen = false) => {
    const selection = textSelection()
    if (!valid() || !selection) return false
    const result = action(editor.chain().command(({ tr }) => {
      closeHistory(tr)
      if (keepOpen) tr.setMeta(selectionToolbarFormat, true)
      tr.setSelection(selection)
      return true
    })).run()
    if (result && !keepOpen) { props.onClose(); editor.view.focus() }
    return result
  }

  const math = (display: boolean) => {
    const source = latex()
    if (!source) return
    const formula = { type: 'math', attrs: { latex: source, display } }
    run((chain) => chain.insertContent(display ? { type: 'paragraph', content: [formula] } : formula))
  }

  const quote = (chain: ChainedCommands, variant: 'note' | 'fold' | null) => inQuote
    ? chain.updateAttributes('blockquote', { variant }) : chain.wrapIn('blockquote', { variant })

  const copy = async () => {
    if (!valid()) return
    const text = editor.view.props.clipboardTextSerializer?.(props.selection.content(), editor.view)
    if (!text) return
    try { await navigator.clipboard.writeText(text); props.onClose() }
    catch { setCopyError(true) }
  }

  const iconButton = (label: string, symbol: string, activate: () => void, disabled?: () => boolean, mark?: string) => (
    <button type="button" class="selection-toolbar-icon" title={label} aria-label={label}
      aria-pressed={mark ? !!textSelection() && editor.isActive(mark) : undefined}
      data-action={label} disabled={disabled?.()} onClick={activate}>{symbol}</button>
  )

  return <div class="editor-selection-menu" role="group" aria-label="选区操作" ref={props.ref}
    style={{ left: `${props.x}px`, width: `${props.width}px`, 'max-height': `${props.maxHeight}px`,
      top: props.above ? undefined : `${props.y}px`, bottom: props.above ? `${window.innerHeight - props.y}px` : undefined }}
    onMouseDown={(event) => {
      if (event.button === 0 && !(event.target as Element).closest('input')) event.preventDefault()
    }}
    onKeyDown={(event) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      if (panel() !== 'main') { setPanel('main'); editor.view.focus() }
      else { props.onClose(); editor.view.focus() }
    }}>
    <Show when={panel() !== 'main'}>
      <button type="button" class="selection-toolbar-row" aria-label="返回选区操作" onClick={() => {
        setPanel('main')
        editor.view.focus()
      }}><span aria-hidden="true">‹</span><strong>{panel() === 'blocks' ? '转换区块' : panel() === 'link' ? '链接' : '更多操作'}</strong></button>
    </Show>
    <div class="selection-toolbar-content"><Switch>
      <Match when={panel() === 'main'}>
        <button type="button" class="selection-toolbar-row" aria-label="转换区块" aria-expanded="false"
          disabled={!textSelection()} onClick={() => setPanel('blocks')}>
          <span aria-hidden="true">{activeBlock?.icon ?? 'T'}</span><strong>{typeLabel ?? '转换区块'}</strong><i aria-hidden="true">›</i>
        </button>
        <div class="selection-toolbar-marks" role="group" aria-label="文字格式">
          <For each={inlineMarks}>{(item) => iconButton(item.name, item.symbol, () =>
            run((chain) => chain.toggleMark(item.mark), true), () => !canMark(), item.mark)}</For>
          {iconButton('清除格式', 'Tₓ', () => run((chain) => chain.unsetAllMarks(), true), () => !canMark())}
          {iconButton('链接', '↗', () => { setLinkError(false); setPanel('link') }, () => !canMark(), 'link')}
          {iconButton('删除线', 'S', () => run((chain) => chain.toggleStrike(), true), () => !canMark(), 'strike')}
          {iconButton('行内代码', '‹/›', () => run((chain) => chain.toggleCode(), true), () => !canMark(), 'code')}
          {iconButton('行内公式', '√x', () => math(false), () => !latex())}
          {iconButton('更多操作', '⋯', () => { setCopyError(false); setPanel('more') })}
        </div>
      </Match>
      <Match when={panel() === 'blocks'}>
        <div class="selection-toolbar-options" role="group" aria-label="区块类型">
          <For each={blockTypes}>{(item) => (
            <button type="button" class="selection-toolbar-row" aria-pressed={item === activeBlock} onClick={() => {
              if (item === activeBlock) props.onClose()
              else if (item.icon === 'T') run((chain) => chain.clearNodes())
              else if (item.icon === '❝') run((chain) => quote(chain, null))
              else if (item.icon === '☷' || item.icon === '≡') {
                const type = item.icon === '☷' ? 'bulletList' : 'orderedList'
                run((chain) => (listType === type ? chain : item.run(chain)).updateAttributes('listItem', { checked: null }))
              }
              else run(item.run)
            }}><span aria-hidden="true">{item.icon}</span>{item.label}<Show when={item === activeBlock}><i aria-hidden="true">✓</i></Show></button>
          )}</For>
          <button type="button" class="selection-toolbar-row" disabled={!latex()} onClick={() => math(true)}>
            <span aria-hidden="true">∑</span>公式区块
          </button>
          <button type="button" class="selection-toolbar-row" aria-pressed={quoteVariant === 'note'}
            onClick={() => run((chain) => quote(chain, 'note'))}><span aria-hidden="true">▣</span>标注</button>
          <button type="button" class="selection-toolbar-row" aria-pressed={quoteVariant === 'fold'}
            onClick={() => run((chain) => quote(chain, 'fold'))}><span aria-hidden="true">▸</span>折叠区块</button>
          <For each={[1, 2, 3, 4] as const}>{(level) => (
            <button type="button" class="selection-toolbar-row" aria-pressed={quoteVariant === 'fold' && editor.isActive('heading', { level })}
              onClick={() => run((chain) => quote(chain.setHeading({ level }), 'fold'))}>
              <span aria-hidden="true">▸H{level}</span>折叠标题 {level}
            </button>
          )}</For>
          <button type="button" class="selection-toolbar-row" disabled={!canMark()} onClick={() => { setLinkError(false); setPanel('link') }}>
            <span aria-hidden="true">↗</span>页面链接
          </button>
        </div>
      </Match>
      <Match when={panel() === 'link'}>
        <form class="selection-toolbar-link" onSubmit={(event) => {
          event.preventDefault()
          const href = new FormData(event.currentTarget).get('href')?.toString().trim()
          if (!href || !run((chain) => chain.setLink({ href }))) setLinkError(true)
        }}>
          <input name="href" type="text" aria-label="链接地址" placeholder="链接地址" value={editor.getAttributes('link').href ?? ''}
            onInput={() => setLinkError(false)} ref={(input) => queueMicrotask(() => { if (input.isConnected) input.focus() })} />
          <button type="submit" aria-label="应用链接" title="应用链接">✓</button>
          <Show when={editor.isActive('link')}><button type="button" aria-label="移除链接" title="移除链接"
            onClick={() => run((chain) => chain.unsetLink())}>×</button></Show>
        </form>
        <Show when={linkError()}><p class="selection-toolbar-error" role="alert">请输入有效的链接</p></Show>
      </Match>
      <Match when={panel() === 'more'}>
        <button type="button" class="selection-toolbar-row" onClick={() => void copy()}><span aria-hidden="true">⧉</span>复制为 Markdown</button>
        <Show when={copyError()}><p class="selection-toolbar-error" role="alert">复制失败</p></Show>
      </Match>
    </Switch></div>
    <Show when={props.onAiEdit}>
      <Show when={aiError()}><p class="selection-toolbar-error" role="status">该选区没有可供 AI 编辑的内容</p></Show>
      <button type="button" class="selection-toolbar-row selection-toolbar-ai" onClick={(event) => {
        if (!valid() || !props.onAiEdit?.(event)) setAiError(true)
      }}><span aria-hidden="true">✨</span>使用 AI 编辑</button>
    </Show>
  </div>
}
