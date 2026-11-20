import { InputRule, Node } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import type { MathfieldElement } from 'mathlive'
import { bindMathPointer } from './mathPointer'
import { mathSource } from './mathMarkdown'

let visual: typeof import('./mathliveEngine') | undefined
let preparing: Promise<typeof import('./mathliveEngine')> | undefined
function prepareVisualMath() {
  return preparing ??= import('./mathliveEngine').then((engine) => (visual = engine), (error: unknown) => {
    preparing = undefined
    throw error
  })
}

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
      preview.title = '编辑公式'
      preview.setAttribute('aria-label', '编辑公式')
      preview.textContent = mathSource(node.attrs.latex, node.attrs.display)
      dom.append(preview)
      let disposed = false
      let rendering = false
      let typesetter: typeof import('./katexEngine').default | undefined
      let field: MathfieldElement | undefined
      let readValue: string | undefined
      let active: MathfieldElement | HTMLTextAreaElement | undefined

      const canRenderVisually = () => node.attrs.latex.length < 4_000 && !richCommands.test(node.attrs.latex)

      function paint() {
        if (typesetter && node.attrs.latex.length <= 20_000) {
          try {
            typesetter.render(node.attrs.latex, preview, {
              displayMode: node.attrs.display, throwOnError: false, trust: false, maxExpand: 100, maxSize: 25,
            })
            return
          } catch { /* Show the original source if typesetting fails. */ }
        }
        preview.textContent = mathSource(node.attrs.latex, node.attrs.display)
      }

      async function render() {
        if (rendering || disposed) return
        rendering = true
        try {
          if (canRenderVisually()) {
            try {
              const engine = visual ?? await prepareVisualMath()
              if (disposed) return
              if (!active && installField(engine)) return
            } catch { /* KaTeX also handles formulas unsupported in the editor. */ }
          }
          if (node.attrs.latex.length <= 20_000) {
            const { default: katex } = await import('./katexEngine')
            if (!disposed) {
              typesetter = katex
              paint()
            }
          }
        } finally {
          rendering = false
        }
      }

      const observer = typeof IntersectionObserver === 'undefined' ? undefined
        : new IntersectionObserver((entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return
          observer?.disconnect()
          void render().catch(() => {})
        }, { rootMargin: '100px' })
      if (observer) observer.observe(dom)
      else void render().catch(() => {})

      function stopEditing() {
        const input = active
        active = undefined
        if (input && input === field) {
          input.readOnly = true
          input.style.removeProperty('inline-size')
          input.style.removeProperty('block-size')
        } else {
          input?.remove()
        }
        delete dom.dataset.mathEdit
        preview.hidden = !!field
      }

      function finish(save: boolean, latex: string, direction?: 'backward' | 'forward') {
        const pos = getPos()
        const editable = !disposed && editor.isEditable && pos !== undefined
        const changed = editable && save && latex !== node.attrs.latex
        if (!changed && active === field && field && field.value !== readValue) field.setValue(node.attrs.latex)
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
          const { width, height } = input.getBoundingClientRect()
          input.style.inlineSize = `${width}px`
          input.style.blockSize = `${height}px`
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

        input.setValue(node.attrs.latex)
        dom.append(input)
        if (input.errors.length) {
          input.remove()
          return undefined
        }
        field = input
        readValue = input.value
        preview.hidden = true
        return field
      }

      preview.onmousedown = (event) => {
        if (event.button === 0 && editor.isEditable) event.preventDefault()
      }
      preview.onclick = () => {
        if (active || !pinFormula()) return
        editSource()
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
          if (field && canRenderVisually()) {
            if (field.value !== node.attrs.latex) field.setValue(node.attrs.latex)
            if (!field.errors.length) {
              readValue = field.value
              return true
            }
          }
          field?.remove()
          field = undefined
          preview.hidden = false
          paint()
          if (!typesetter) void render().catch(() => {})
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
