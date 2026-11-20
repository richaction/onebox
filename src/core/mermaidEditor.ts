import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

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
  panes.append(pre, preview, diagnostic)
  workspace.append(tabs, panes)
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
    preview.tabIndex = editing ? 0 : -1
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

  return {
    button, workspace, refreshButton,
    report(message: string) {
      if (diagnostic.textContent !== message) diagnostic.textContent = message
      diagnostic.hidden = !message
    },
    stopEvent(event: Event) {
      return tabs.contains(event.target as Node | null) || diagnostic.contains(event.target as Node | null)
    },
  }
}
