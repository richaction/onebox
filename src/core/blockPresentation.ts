import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { codeLanguage, codeLanguageIds } from './codeLanguages'
import type { createCodeHighlight } from './codeHighlight'
import type { PresentBlock } from './viewport/blockNodeView'

const selectableLanguages = [...codeLanguageIds, 'html', 'c']
  .map((id) => ({ id, label: codeLanguage(id).label }))
  .sort((a, b) => a.label.localeCompare(b.label, 'en'))
const languageChoices = [{ id: '', label: '纯文本' }, ...selectableLanguages]
const selectableIds = new Set(selectableLanguages.map(({ id }) => id))

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
  const wraps = new WeakMap<ProseMirrorNode, boolean>()
  const languageSelects = new Set<HTMLSelectElement>()
  const present: PresentBlock = (node, rendered, view, getPos) => {
    const { dom, contentDOM } = rendered
    const document = dom.ownerDocument

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
    frame.dataset.language = language.id ?? 'plain'
    contentDOM.setAttribute('spellcheck', 'false')

    const toolbar = document.createElement('div')
    toolbar.className = 'code-toolbar'
    toolbar.contentEditable = 'false'
    const picker = document.createElement('div')
    picker.className = 'code-language-picker'
    const select = document.createElement('select')
    select.className = 'code-language'
    select.setAttribute('aria-label', '代码语言')
    select.disabled = !view.editable
    if (info) select.title = info
    for (const { id, label } of languageChoices) {
      const option = document.createElement('option')
      option.value = id
      option.textContent = label
      select.append(option)
    }
    const lowerName = language.name.toLowerCase()
    const selected = selectableIds.has(lowerName) ? lowerName
      : language.id ?? (language.plain ? '' : language.name)
    if (selected && !selectableIds.has(selected)) {
      const option = document.createElement('option')
      option.value = selected
      option.textContent = language.label
      select.append(option)
    }
    select.value = selected
    picker.append(select)
    languageSelects.add(select)

    const actions = document.createElement('div')
    actions.className = 'code-actions'
    const wrap = document.createElement('button')
    wrap.type = 'button'
    wrap.textContent = '换行'
    wrap.setAttribute('aria-label', '自动换行')
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.textContent = '复制'
    copy.hidden = !document.defaultView?.navigator.clipboard?.writeText
    actions.append(wrap, copy)
    toolbar.append(picker, actions)
    frame.append(toolbar, dom)

    let current = node
    let wrapped = wraps.get(node) ?? false
    let copyStatus: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    select.onchange = () => {
      if (select.value === selected) return
      const pos = getPos()
      if (!view.editable || pos === undefined || view.state.doc.nodeAt(pos) !== current) {
        select.value = selected
        return
      }
      // Fence info may contain attributes after the language. Keep them when switching syntax.
      const suffix = info.slice(language.name.length)
      const nextInfo = (select.value || (suffix ? 'text' : '')) + suffix
      const focused = document.activeElement === select
      const tr = view.state.tr.setNodeAttribute(pos, 'language', nextInfo || null)
      if (wrapped) wraps.set(tr.doc.nodeAt(pos)!, wrapped)
      view.dispatch(tr)
      if (focused) {
        const block = view.nodeDOM(pos) as HTMLElement | null
        block?.querySelector<HTMLSelectElement>('.code-language')?.focus({ preventScroll: true })
      }
    }
    const showWrap = () => {
      frame.toggleAttribute('data-wrap', wrapped)
      wrap.setAttribute('aria-pressed', String(wrapped))
    }
    showWrap()
    wrap.onclick = () => {
      wrapped = !wrapped
      wraps.set(current, wrapped)
      showWrap()
    }
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
      copy.textContent = status
      copyStatus = setTimeout(() => { copy.textContent = '复制' }, 1_200)
    }

    const syntax = highlight?.watch(frame, contentDOM, node)
    return {
      dom: frame,
      contentDOM,
      updateContent(next) {
        current = next
        if (wrapped || wraps.has(node)) wraps.set(current, wrapped)
        syntax?.update(next)
      },
      stopEvent: (event) => toolbar.contains(event.target as Node | null),
      destroy() {
        disposed = true
        languageSelects.delete(select)
        clearTimeout(copyStatus)
        syntax?.destroy()
      },
    }
  }
  return {
    present,
    setEditable(editable: boolean) {
      for (const select of languageSelects) select.disabled = !editable
    },
  }
}
