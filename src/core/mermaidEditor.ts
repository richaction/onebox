import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { unwrapMermaidFence } from './mermaidFence'

export function mountMermaidEditor(
  frame: HTMLElement, pre: HTMLElement, preview: HTMLElement, view: EditorView, getPos: () => number | undefined,
) {
  const document = frame.ownerDocument
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('aria-expanded', 'false')

  const workspace = document.createElement('div')
  workspace.className = 'mermaid-workspace'
  workspace.id = `${preview.id}-workspace`
  button.setAttribute('aria-controls', workspace.id)

  const tabs = document.createElement('div')
  tabs.className = 'mermaid-tabs code-actions'
  tabs.contentEditable = 'false'
  tabs.dataset.activateOnRelease = ''
  tabs.setAttribute('role', 'group')
  tabs.setAttribute('aria-label', 'Mermaid 编辑视图')
  tabs.onmousedown = (event) => event.preventDefault()
  pre.id = `${preview.id}-source`
  const sourceTab = document.createElement('button')
  sourceTab.type = 'button'
  sourceTab.textContent = '源码'
  sourceTab.setAttribute('aria-controls', pre.id)
  const previewTab = document.createElement('button')
  previewTab.type = 'button'
  previewTab.textContent = '预览'
  previewTab.setAttribute('aria-controls', preview.id)
  tabs.append(sourceTab, previewTab)

  const panes = document.createElement('div')
  panes.className = 'mermaid-panes'
  const diagnostic = document.createElement('div')
  diagnostic.className = 'mermaid-diagnostic'
  diagnostic.contentEditable = 'false'
  diagnostic.setAttribute('role', 'status')
  diagnostic.setAttribute('aria-atomic', 'true')
  diagnostic.hidden = true
  pre.hidden = true
  const labels = document.createElement('div')
  labels.className = 'mermaid-pane-labels'
  labels.contentEditable = 'false'
  labels.setAttribute('aria-hidden', 'true')
  for (const tab of [sourceTab, previewTab]) {
    const label = document.createElement('span')
    label.textContent = tab.textContent
    labels.append(label)
  }
  pre.setAttribute('aria-label', 'Mermaid 源码')
  panes.append(pre, preview)
  workspace.append(labels, tabs, panes, diagnostic)
  frame.append(workspace)

  let editing = false
  let caret = { anchor: 0, head: 0 }
  function rememberSource() {
    const start = getPos()
    const { selection, doc } = view.state
    const block = start === undefined ? null : doc.nodeAt(start)
    if (start === undefined || !block || selection.from <= start || selection.to >= start + block.nodeSize) return
    caret = { anchor: selection.anchor - start - 1, head: selection.head - start - 1 }
  }

  function focusSource() {
    const start = getPos()
    if (start === undefined || !view.editable) return
    const { doc, tr, selection } = view.state
    const block = doc.nodeAt(start)
    if (!block) return
    const position = (offset: number) => start + 1 + Math.min(offset, block.content.size)
    const next = TextSelection.create(doc, position(caret.anchor), position(caret.head))
    if (!next.eq(selection)) view.dispatch(tr.setSelection(next))
    view.focus()
  }

  function showPane(pane: 'source' | 'preview') {
    workspace.dataset.pane = pane
    sourceTab.setAttribute('aria-pressed', String(pane === 'source'))
    previewTab.setAttribute('aria-pressed', String(pane === 'preview'))
  }

  const refreshButton = () => { button.textContent = editing ? '完成' : view.editable ? '编辑' : '源码' }
  refreshButton()
  button.onclick = () => {
    rememberSource()
    editing = !editing
    workspace.toggleAttribute('data-editing', editing)
    pre.hidden = !editing
    button.setAttribute('aria-expanded', String(editing))
    refreshButton()
    if (editing) {
      showPane('source')
      focusSource()
    } else {
      button.focus({ preventScroll: true })
    }
  }
  sourceTab.onclick = () => {
    showPane('source')
    focusSource()
  }
  previewTab.onclick = () => {
    rememberSource()
    previewTab.focus({ preventScroll: true })
    showPane('preview')
  }
  pre.addEventListener('paste', (event) => {
    if (!editing || !view.editable || view.composing || !event.clipboardData || event.clipboardData.files.length) return
    const source = unwrapMermaidFence(event.clipboardData.getData('text/plain'))
    if (source === undefined) return
    const { selection, tr } = view.state
    const start = getPos()
    const { $from, $to } = selection
    if (start === undefined || $from.parent.type.name !== 'codeBlock' || !$from.sameParent($to) || $from.before() !== start) return
    event.preventDefault()
    view.dispatch(tr.insertText(source).scrollIntoView())
  })

  return {
    button, workspace, refreshButton,
    report(message: string) {
      if (diagnostic.textContent !== message) diagnostic.textContent = message
      diagnostic.hidden = !message
    },
    stopEvent(event: Event) {
      const target = event.target as Node | null
      return labels.contains(target) || tabs.contains(target) || diagnostic.contains(target)
    },
  }
}
