import { InputRule, Node } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import type { MathfieldElement } from 'mathlive'
import { bindMathPointer } from './mathPointer'
import { mathSource } from './mathMarkdown'
import { paintPreview } from './previewPaint'

let visual: typeof import('./mathliveEngine') | undefined
let preparing: Promise<typeof import('./mathliveEngine')> | undefined
function prepareVisualMath() {
  return preparing ??= import('./mathliveEngine').then((engine) => (visual = engine), (error: unknown) => {
    preparing = undefined
    throw error
  })
}

const formulaCache = new Map<string, string>()

const richCommands = /\\(?:href|url|includegraphics|html\w*|class|cssId|style)\b/u

export const MarkdownMath = Node.create({
  name: 'math',
  inline: true,
  group: 'inline',
  atom: true,
  addAttributes() {
    return { latex: { default: '', rendered: false }, display: { default: false, rendered: false } }
  },
  parseHTML() {
    return [{
      tag: 'span[data-math]',
      getAttrs: (element) => ({ latex: element.dataset.math, display: element.hasAttribute('data-display') }),
    }]
  },
  renderHTML({ node }) {
    const { latex, display } = node.attrs
    return ['span', { 'data-math': latex, ...(display ? { 'data-display': '' } : {}) }, mathSource(latex, display)]
  },
  renderText({ node }) {
    return mathSource(node.attrs.latex, node.attrs.display)
  },
  addInputRules() {
    return [new InputRule({
      find: /(?<![\\$])(\$\$?)([^$\s](?:[^$]*[^$\s])?)\1$/u,
      handler: ({ state, range, match }) => {
        state.tr.replaceWith(range.from, range.to, this.type.create({ latex: match[2], display: match[1] === '$$' }))
      },
    })]
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('span')
      dom.className = 'markdown-math'
      dom.contentEditable = 'false'
      dom.toggleAttribute('data-display', node.attrs.display)
      const preview = document.createElement('button')
      preview.type = 'button'
      preview.dataset.activateOnRelease = ''
      preview.title = '编辑公式'
      preview.setAttribute('aria-label', '编辑公式')
      preview.textContent = mathSource(node.attrs.latex, node.attrs.display)
      dom.append(preview)
      let disposed = false
      let rendering = false
      let field: MathfieldElement | undefined
      let readValue: string | undefined
      let active: MathfieldElement | HTMLTextAreaElement | undefined

      const canRenderVisually = () => node.attrs.latex.length < 4_000 && !richCommands.test(node.attrs.latex)

      const keyOf = () => JSON.stringify([node.attrs.display, node.attrs.latex])
      function paint(key: string, typeset: () => string | undefined) {
        if (disposed || keyOf() !== key) return false
        const cached = formulaCache.get(key)
        const html = cached ?? typeset()
        if (!html) return false
        if (cached === undefined) {
          if (html.length < 32_768) {
            if (formulaCache.size >= 128) formulaCache.delete(formulaCache.keys().next().value!)
            formulaCache.set(key, html)
          }
        }
        preview.innerHTML = html
        return true
      }

      async function render() {
        if (rendering || disposed || node.attrs.latex.length > 20_000) return
        rendering = true
        const key = keyOf()
        const { latex, display } = node.attrs
        try {
          const cached = formulaCache.get(key)
          if (cached !== undefined) {
            preview.innerHTML = cached
            return
          }
          if (canRenderVisually()) {
            const painted = await import('./mathPreview').then(({ previewMath }) =>
              paintPreview(() => paint(key, () => previewMath(latex, display)))).catch(() => false)
            if (painted || disposed || keyOf() !== key) return
          }
          const { default: katex } = await import('./katexEngine')
          await paintPreview(() => paint(key, () => katex.renderToString(latex, {
            displayMode: display, throwOnError: false, trust: false, maxExpand: 100, maxSize: 25,
          })))
        } finally {
          rendering = false
          if (!disposed && key !== keyOf()) void render().catch(() => {})
        }
      }

      const observer = typeof IntersectionObserver === 'undefined' || formulaCache.has(keyOf()) ? undefined
        : new IntersectionObserver((entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return
          observer?.disconnect()
          void render().catch(() => {})
        }, { rootMargin: '240px' })
      if (observer) observer.observe(dom)
      else void render().catch(() => {})

      function stopEditing() {
        const input = active
        const content = field?.shadowRoot?.querySelector('[part="content"]')
        if (content) preview.scrollLeft = content.scrollLeft
        active = undefined
        input?.remove()
        field = undefined
        delete dom.dataset.mathEdit
      }

      function finish(save: boolean, latex: string, direction?: 'backward' | 'forward') {
        const pos = getPos()
        const editable = !disposed && editor.isEditable && pos !== undefined
        const changed = editable && save && latex !== node.attrs.latex
        stopEditing()
        if (!editable) return
        const { view } = editor
        const tr = view.state.tr
        if (changed) {
          if (latex.trim()) tr.setNodeAttribute(pos, 'latex', latex)
          else tr.delete(pos, pos + node.nodeSize)
        }
        if (direction) {
          const end = direction === 'forward' ? pos + node.nodeSize : pos
          const caret = tr.mapping.map(end, direction === 'forward' ? 1 : -1)
          tr.setSelection(TextSelection.create(tr.doc, caret))
        }
        if (tr.docChanged || tr.selectionSet) view.dispatch(tr)
        if (direction) view.focus()
      }

      function editSource() {
        const input = document.createElement('textarea')
        input.rows = node.attrs.display ? 3 : 1
        input.setAttribute('aria-label', 'LaTeX 源码')
        input.value = node.attrs.latex
        active = input
        dom.dataset.mathEdit = 'source'
        dom.append(input)
        const overflow = input.getBoundingClientRect().right - document.documentElement.clientWidth + 12
        if (overflow > 0) input.style.insetInlineStart = `-${Math.ceil(overflow)}px`
        input.onblur = () => { if (active === input) finish(true, input.value) }
        input.onkeydown = (event) => {
          if (event.isComposing) return
          if (event.key === 'Escape' || (event.key === 'Enter' && (!node.attrs.display || event.metaKey || event.ctrlKey))) {
            event.preventDefault()
            event.stopPropagation()
            finish(event.key === 'Enter', input.value, 'forward')
          }
        }
        input.focus({ preventScroll: true })
        input.setSelectionRange(input.value.length, input.value.length)
      }

      function pinFormula() {
        const pos = getPos()
        if (!editor.isEditable || pos === undefined) return false
        const { view } = editor
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
        return !disposed
      }

      function installField(engine: typeof import('./mathliveEngine')) {
        if (field) return field
        const input = engine.createMathfield(node.attrs.display)
        input.readOnly = true
        // The mathfield can scroll its contents to the caret, but it must not
        // scroll the document as a side effect of editing.
        input.onScrollIntoView = () => {}

        const currentLatex = () => input.value === readValue ? node.attrs.latex : input.value
        const activate = (source: boolean) => {
          if (active && active !== input) return false
          if (!editor.isEditable) return false
          if (source) {
            if (active === input) finish(true, currentLatex())
            if (!disposed && pinFormula()) editSource()
            return false
          }
          if (active === input) return true
          if (!pinFormula()) return false
          active = input
          dom.dataset.mathEdit = 'visual'
          input.readOnly = false
          input.shadowRoot?.querySelector<HTMLElement>('[part="keyboard-sink"]')?.focus({ preventScroll: true })
          return true
        }

        bindMathPointer(input, activate)
        input.addEventListener('blur', () => { if (active === input) finish(true, currentLatex()) })
        input.addEventListener('keydown', (event) => {
          if (event.isComposing) return
          if (active !== input) {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            event.stopPropagation()
            if (activate(event.altKey)) input.position = input.lastOffset
            return
          }
          if (event.key !== 'Escape' && event.key !== 'Enter') return
          event.preventDefault()
          event.stopPropagation()
          finish(event.key === 'Enter', currentLatex(), 'forward')
        }, true)
        input.addEventListener('move-out', (event) => {
          const { direction } = event.detail
          if (active !== input || (direction !== 'forward' && direction !== 'backward')) return
          event.preventDefault()
          finish(true, currentLatex(), direction)
        })

        const latex: string = node.attrs.latex
        input.setValue(latex)
        dom.append(input)
        // MathLive draws synthetic placeholders in the omitted cells of short aligned rows.
        // Reparse them as explicit empty cells so editing uses the same layout as the preview.
        if (!input.errors.length && /\\begin\s*\{aligned\}/u.test(latex) &&
          !/\\placeholder\b|#[?@\d]/u.test(latex) && input.getValue('latex-expanded').includes('\\placeholder{}')) {
          input.setValue(input.getValue('latex-without-placeholders'))
          input.resetUndo()
        }
        if (input.errors.length) {
          input.remove()
          return undefined
        }
        field = input
        readValue = input.value
        if (!activate(false)) { stopEditing(); return }
        return field
      }

      preview.onmousedown = (event) => {
        if (event.button === 0 && editor.isEditable) event.preventDefault()
      }
      preview.onclick = async (event) => {
        if (active || !pinFormula()) return
        if (event.altKey || !canRenderVisually()) { editSource(); return }
        const pos = getPos()
        const scrollLeft = preview.scrollLeft
        try {
          const engine = visual ?? await prepareVisualMath()
          if (disposed || active || !editor.isEditable || editor.state.selection.head !== pos) return
          const input = installField(engine)
          if (input) {
            // The field can re-render its atoms on the first frame after opening.
            requestAnimationFrame(() => {
              if (disposed || active !== input) return
              const content = input.shadowRoot?.querySelector('[part="content"]')
              if (content) content.scrollLeft = scrollLeft
              const at = event.detail ? input.getOffsetFromPoint(event.clientX, event.clientY) : -1
              input.position = at < 0 ? input.lastOffset : at
            })
            return
          }
        } catch { /* Fall back to the source editor if visual editing is unavailable. */ }
        if (!disposed && !active && editor.isEditable && editor.state.selection.head === pos) editSource()
      }
      return {
        dom,
        stopEvent: () => true,
        ignoreMutation: () => true,
        update(next) {
          if (next.type !== node.type || next.attrs.display !== node.attrs.display) return false
          if (next.attrs.latex === node.attrs.latex) {
            node = next
            return true
          }
          if (active) return false
          node = next
          preview.textContent = mathSource(node.attrs.latex, node.attrs.display)
          void render().catch(() => {})
          return true
        },
        destroy() {
          disposed = true
          observer?.disconnect()
        },
      }
    }
  },
})
