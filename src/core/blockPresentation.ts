import type { EditorView } from '@tiptap/pm/view'
import { codeLanguage, codeLanguageIds } from './codeLanguages'
import { codeLanguageMenu } from './codeLanguageMenu'
import type { createCodeHighlight } from './codeHighlight'
import { richLanguage, watchRichBlock } from './richBlock'
import { continueAfterBlock, isDisplayMath } from './editorCaret'
import { mountMermaidEditor } from './mermaidEditor'
import type { PresentBlock } from './viewport/blockNodeView'

const selectableLanguages = [...codeLanguageIds, 'html', 'c']
  .map((id) => ({ id, label: codeLanguage(id).label }))
  .sort((a, b) => a.label.localeCompare(b.label, 'en'))
const languageChoices = [
  { id: '', label: '纯文本' }, { id: 'echarts', label: 'ECharts' }, { id: 'mermaid', label: 'Mermaid' },
  ...selectableLanguages,
]
const selectableIds = new Set(languageChoices.map(({ id }) => id))

let nextRichBlock = 0

export function keepTableCaretVisible(view: EditorView) {
  const { $head } = view.state.selection
  for (let depth = $head.depth; depth > 0; depth--) {
    const role = $head.node(depth).type.spec.tableRole
    if (role !== 'cell' && role !== 'header_cell') continue
    const cell = view.nodeDOM($head.before(depth)) as HTMLTableCellElement | null
    const scroller = cell?.closest<HTMLElement>('.table-scroll[data-overflow]')
    if (!cell || !scroller) return

    const pin = Number.parseFloat(scroller.style.scrollPaddingInlineStart) || 0
    if (pin && cell.cellIndex === 0) return
    const rtl = getComputedStyle(scroller).direction === 'rtl'
    const bounds = scroller.getBoundingClientRect()
    const caret = view.coordsAtPos($head.pos)
    const left = bounds.left + (rtl ? 0 : pin) + 4
    const right = bounds.right - (rtl ? pin : 0) - 4
    if (caret.left < left) scroller.scrollLeft += caret.left - left
    else if (caret.right > right) scroller.scrollLeft += caret.right - right
    return
  }
}

export function createBlockPresentation(highlight: ReturnType<typeof createCodeHighlight>) {
  const languageMenus = new Set<ReturnType<typeof codeLanguageMenu>>()
  const mermaidEditors = new Set<ReturnType<typeof mountMermaidEditor>>()
  const present: PresentBlock = (node, rendered, view, getPos) => {
    const { dom, contentDOM } = rendered
    const document = dom.ownerDocument

    if (node.type.name === 'paragraph') {
      const updateContent = (paragraph: typeof node) => {
        dom.toggleAttribute('data-display-math', isDisplayMath(paragraph))
        dom.toggleAttribute('data-standalone-image', paragraph.childCount === 1 && paragraph.firstChild?.type.name === 'image')
      }
      updateContent(node)
      return { ...rendered, updateContent }
    }

    if (node.type.name === 'table') {
      const frame = document.createElement('div')
      frame.className = 'table-frame'
      const scroller = document.createElement('div')
      scroller.className = 'table-scroll'
      const table = dom as HTMLTableElement
      // Column geometry is CSS-driven. ProseMirror still owns and edits <tbody>.
      table.querySelector(':scope > colgroup')?.remove()
      table.style.removeProperty('min-width')
      table.style.removeProperty('width')
      scroller.append(table)
      frame.append(scroller)
      const updateEdge = () => {
        const remaining = scroller.scrollWidth - scroller.clientWidth - Math.abs(scroller.scrollLeft)
        frame.toggleAttribute('data-more-columns', remaining > 1)
      }
      const size = new ResizeObserver(() => {
        const width = scroller.clientWidth
        const overflowing = scroller.scrollWidth > width + 1
        const firstColumn = table.rows[0]?.cells[0]?.offsetWidth ?? 0
        const pinFirst = overflowing && firstColumn > 0 && firstColumn * 2 < width
        scroller.toggleAttribute('data-pin-first', pinFirst)
        const inset = pinFirst ? `${firstColumn}px` : '0px'
        if (scroller.style.scrollPaddingInlineStart !== inset) scroller.style.scrollPaddingInlineStart = inset
        updateEdge()
        if (scroller.hasAttribute('data-overflow') === overflowing) return
        scroller.toggleAttribute('data-overflow', overflowing)
        if (overflowing) {
          scroller.tabIndex = 0
          scroller.setAttribute('role', 'region')
          scroller.setAttribute('aria-label', '可横向滚动的表格')
        } else {
          scroller.removeAttribute('tabindex')
          scroller.removeAttribute('role')
          scroller.removeAttribute('aria-label')
        }
      })
      size.observe(scroller)
      size.observe(table)
      scroller.addEventListener('scroll', updateEdge, { passive: true })
      return {
        dom: frame,
        contentDOM,
        destroy() {
          size.disconnect()
          scroller.removeEventListener('scroll', updateEdge)
        },
        stopEvent(event) {
          if (event.target !== scroller || event.type !== 'keydown') return false
          const key = (event as KeyboardEvent).key
          if (key === 'ArrowLeft' || key === 'ArrowRight') {
            event.preventDefault()
            scroller.scrollLeft += key === 'ArrowLeft' ? -80 : 80
          }
          return true
        },
      }
    }

    if (node.type.name !== 'codeBlock' || !contentDOM) return rendered

    const frame = document.createElement('div')
    frame.className = 'code-frame'
    const info: string = node.attrs.language?.trim() ?? ''
    const language = codeLanguage(info)
    const rich = richLanguage(info)
    frame.dataset.language = language.id ?? 'plain'
    contentDOM.setAttribute('spellcheck', 'false')

    const toolbar = document.createElement('div')
    toolbar.className = 'code-toolbar'
    toolbar.contentEditable = 'false'
    const picker = document.createElement('div')
    picker.className = 'code-language-picker'
    const lowerName = language.name.toLowerCase()
    const selected = selectableIds.has(lowerName) ? lowerName
      : language.id ?? (language.plain ? '' : language.name)
    const selectedLanguage = languageChoices.find(({ id }) => id === selected) ?? { id: selected, label: language.label }
    const options = selectableIds.has(selected) ? languageChoices : [...languageChoices, selectedLanguage]
    const menu = codeLanguageMenu(document, options, selectedLanguage, (id) => {
      const pos = getPos()
      if (id === selected || !view.editable || pos === undefined || view.state.doc.nodeAt(pos) !== current) return
      const suffix = info.slice(language.name.length)
      const nextInfo = (id || (suffix ? 'text' : '')) + suffix
      view.dispatch(view.state.tr.setNodeAttribute(pos, 'language', nextInfo || null))
      const block = view.nodeDOM(pos)
      if (block instanceof HTMLElement) block.querySelector<HTMLButtonElement>('.code-language')?.focus({ preventScroll: true })
    })
    menu.trigger.disabled = !view.editable
    picker.append(menu.trigger)
    languageMenus.add(menu)

    const actions = document.createElement('div')
    actions.className = 'code-actions'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'code-copy'
    copy.title = '复制代码'
    copy.setAttribute('aria-label', copy.title)
    copy.hidden = !document.defaultView?.navigator.clipboard?.writeText
    actions.append(copy)
    const next = document.createElement('button')
    next.type = 'button'
    next.className = 'code-next'
    next.textContent = '↵'
    next.title = '在代码块后继续写正文'
    next.setAttribute('aria-label', next.title)
    actions.append(next)
    toolbar.append(picker, actions)
    const continueButton = document.createElement('button')
    continueButton.type = 'button'
    continueButton.className = 'code-continue'
    continueButton.contentEditable = 'false'
    continueButton.tabIndex = -1
    continueButton.setAttribute('aria-hidden', 'true')
    continueButton.onmousedown = (event) => { if (event.button === 0) event.preventDefault() }
    next.onclick = continueButton.onclick = () => {
      const pos = getPos()
      if (pos !== undefined) continueAfterBlock(view, pos)
    }
    frame.append(toolbar)
    let richPreview: ReturnType<typeof watchRichBlock> | undefined
    let mermaidEditor: ReturnType<typeof mountMermaidEditor> | undefined
    if (rich) {
      frame.dataset.rich = rich
      const preview = document.createElement('div')
      preview.className = 'rich-preview'
      preview.dataset.engine = rich
      preview.id = `onebox-chart-${++nextRichBlock}`
      preview.contentEditable = 'false'
      preview.setAttribute('aria-label', rich === 'mermaid' ? 'Mermaid 图' : 'ECharts 图表')
      preview.textContent = '正在载入预览…'
      if (rich === 'mermaid') {
        mermaidEditor = mountMermaidEditor(frame, dom, preview, view, getPos)
        mermaidEditors.add(mermaidEditor)
        actions.prepend(mermaidEditor.button)
        richPreview = watchRichBlock(preview, rich, node.textContent, {
          visibilityTarget: mermaidEditor.workspace,
          report: mermaidEditor.report,
        })
      } else {
        frame.append(preview)
        richPreview = watchRichBlock(preview, rich, node.textContent)
        const source = document.createElement('button')
        source.type = 'button'
        source.textContent = '源码'
        source.setAttribute('aria-expanded', 'false')
        dom.hidden = true
        source.onclick = () => {
          dom.hidden = !dom.hidden
          source.setAttribute('aria-expanded', String(!dom.hidden))
        }
        actions.prepend(source)
      }
    }
    if (!mermaidEditor) frame.append(dom)
    frame.append(continueButton)

    let current = node
    let copyStatus: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    actions.onmousedown = (event) => event.preventDefault()
    copy.onclick = async () => {
      let status = '已复制'
      try {
        await document.defaultView!.navigator.clipboard.writeText(current.textContent)
      } catch {
        status = '复制失败'
      }
      if (disposed) return
      clearTimeout(copyStatus)
      copy.dataset.result = status === '已复制' ? 'success' : 'error'
      copy.title = status
      copy.setAttribute('aria-label', status)
      copyStatus = setTimeout(() => {
        delete copy.dataset.result
        copy.title = '复制代码'
        copy.setAttribute('aria-label', copy.title)
      }, 1_200)
    }

    const syntax = rich ? undefined : highlight?.watch(frame, contentDOM, node)
    return {
      dom: frame,
      contentDOM,
      updateContent(next) {
        current = next
        syntax?.update(next)
        richPreview?.update(next.textContent)
      },
      stopEvent: (event) => event.target === continueButton || toolbar.contains(event.target as Node | null)
        || (event.target as Element)?.closest?.('.rich-preview') != null || mermaidEditor?.stopEvent(event) === true,
      destroy() {
        disposed = true
        menu.close()
        languageMenus.delete(menu)
        if (mermaidEditor) mermaidEditors.delete(mermaidEditor)
        clearTimeout(copyStatus)
        syntax?.destroy()
        richPreview?.destroy()
      },
    }
  }
  return {
    present,
    setEditable(editable: boolean) {
      for (const menu of languageMenus) {
        menu.trigger.disabled = !editable
        if (!editable) menu.close()
      }
      for (const editor of mermaidEditors) editor.refreshButton()
    },
  }
}
