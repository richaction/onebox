import { InputRule, Node } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import type { MathfieldElement } from 'mathlive'
import { mathSource } from './mathMarkdown'

let visual: typeof import('./mathliveEngine') | undefined
let preparing: Promise<typeof import('./mathliveEngine')> | undefined
let warmScheduled = false

function prepareVisualMath() {
  return preparing ??= import('./mathliveEngine').then((engine) => (visual = engine), (error: unknown) => {
    preparing = undefined
    throw error
  })
}

function preloadVisualMath() {
  if (preparing || warmScheduled) return
  warmScheduled = true
  const load = () => {
    warmScheduled = false
    void prepareVisualMath().catch(() => {})
  }
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(load, { timeout: 500 })
  else setTimeout(load, 100)
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
      const canEditVisually = () => editor.isEditable && node.attrs.latex.length < 4_000
        && !richCommands.test(node.attrs.latex)
      const render = async () => {
        if (rendering || disposed || node.attrs.latex.length > 20_000) return
        rendering = true
        observer?.disconnect()
        try {
          const { default: katex } = await import('./katexEngine')
          if (disposed) return
          katex.render(node.attrs.latex, preview, {
            displayMode: node.attrs.display, throwOnError: false, trust: false, maxExpand: 100, maxSize: 25,
          })
          if (canEditVisually()) preloadVisualMath()
        } catch {
          preview.title = '公式预览加载失败，可点击编辑源码'
        }
      }
      const observer = typeof IntersectionObserver === 'undefined' ? undefined
        : new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) void render()
        })
      if (observer) observer.observe(dom)
      else void render()

      let active: MathfieldElement | HTMLTextAreaElement | undefined
      let opening = false

      const warm = () => {
        if (canEditVisually()) {
          void prepareVisualMath().catch(() => {})
        }
      }
      preview.onpointerenter = warm
      preview.onfocus = warm
      preview.title = '点击编辑公式 · Option / Alt + 点击编辑 LaTeX'

      function finish(save: boolean, latex: string, direction?: 'backward' | 'forward') {
        const input = active
        active = undefined
        input?.remove()
        preview.hidden = false
        const pos = getPos()
        if (disposed || !editor.isEditable || pos === undefined) return
        const { view } = editor
        const tr = view.state.tr
        if (save && latex !== node.attrs.latex) {
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
        preview.hidden = true
        dom.append(input)
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

      function editVisual(engine: typeof import('./mathliveEngine'), event: MouseEvent) {
        const input = engine.createMathfield(node.attrs.display)
        active = input
        preview.hidden = true
        dom.append(input)
        input.setValue(node.attrs.latex)
        if (input.errors.length) {
          active = undefined
          input.remove()
          editSource()
          return
        }

        const initialValue = input.value
        const latex = () => input.value === initialValue ? node.attrs.latex : input.value
        input.addEventListener('blur', () => { if (active === input) finish(true, latex()) })
        input.addEventListener('keydown', (event) => {
          if (event.isComposing || (event.key !== 'Escape' && event.key !== 'Enter')) return
          event.preventDefault()
          event.stopPropagation()
          finish(event.key === 'Enter', latex(), 'forward')
        }, true)
        input.addEventListener('move-out', (event) => {
          const { direction } = event.detail
          if (direction !== 'forward' && direction !== 'backward') return
          event.preventDefault()
          finish(true, latex(), direction)
        })

        let press: { id: number; x: number; y: number; dragged: boolean } | undefined
        input.addEventListener('pointerdown', (event) => {
          if (event.isPrimary && event.button === 0 && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
            press = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false }
          } else {
            press = undefined
          }
        }, true)
        const trackDrag = (event: PointerEvent) => {
          if (!press || press.id !== event.pointerId) return
          const threshold = event.pointerType === 'touch' ? 20 : 5
          press.dragged ||= Math.abs(press.x - event.clientX) >= threshold || Math.abs(press.y - event.clientY) >= threshold
        }
        input.addEventListener('pointermove', trackDrag, true)
        input.addEventListener('pointerup', (event) => {
          if (!press || press.id !== event.pointerId) return
          trackDrag(event)
          const dragged = press.dragged
          press = undefined
          // MathLive groups nearby taps. Collapse that selection unless the user dragged or held Shift.
          if (!dragged && !event.shiftKey && !input.selectionIsCollapsed) {
            const offset = input.getOffsetFromPoint(event.clientX, event.clientY)
            input.position = offset < 0 ? input.position : offset
          }
        }, true)
        input.addEventListener('pointercancel', () => { press = undefined }, true)

        input.focus()
        if (event.detail) {
          const offset = input.getOffsetFromPoint(event.clientX, event.clientY)
          input.position = offset < 0 ? input.lastOffset : offset
        } else {
          input.position = input.lastOffset
        }
      }

      preview.onmousedown = (event) => {
        // Keep the native editor selection until the math field is ready to take focus.
        if (event.button === 0 && editor.isEditable) event.preventDefault()
      }
      preview.onclick = async (event) => {
        if (!editor.isEditable || active || opening) return
        const pos = getPos()
        if (pos === undefined) return
        const { view } = editor
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
        if (event.altKey || !canEditVisually()) {
          editSource()
          return
        }
        opening = true
        const previouslyFocused = document.activeElement
        const canFocus = () => !disposed && editor.isEditable && document.activeElement === previouslyFocused
          && view.state.selection.empty && view.state.selection.head === getPos()
        try {
          const engine = visual ?? await prepareVisualMath()
          if (canFocus()) editVisual(engine, event)
        } catch {
          if (canFocus()) {
            dom.querySelector('math-field')?.remove()
            editSource()
          }
        } finally {
          opening = false
        }
      }
      return {
        dom,
        stopEvent: () => true,
        ignoreMutation: () => true,
        destroy() {
          disposed = true
          observer?.disconnect()
        },
      }
    }
  },
})
