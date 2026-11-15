import { Editor, Extension } from '@tiptap/core'
import type { Node } from '@tiptap/pm/model'
import { EditorState, Plugin } from '@tiptap/pm/state'
import { parseMarkdown, serializeMarkdown } from './markdown'
import type { ViewportMetrics } from './metrics'
import { extensions, schema } from './schema'
import { blockNodeViews, type ViewportObserver } from './viewport/blockNodeView'
import { HeightCache } from './viewport/heights'
import { createViewportObserver } from './viewport/observer'
import { createVisibilityPlugin } from './viewport/visibility'

export interface EditorHandle {
  editor: Editor
  viewportMetrics?: ViewportMetrics
  loadMarkdown(text: string): void
  toMarkdown(): string
  destroy(): void
}

export function createEditor(opts: {
  element: HTMLElement
  scrollRoot: HTMLElement
  markdown: string
  onUpdate: (doc: Node) => void
}): EditorHandle {
  const heights = new HeightCache()
  const viewportMetrics = import.meta.env.DEV
    ? { created: 0, destroyed: 0, transactions: 0, lastTransactionMs: 0, maxTransactionMs: 0 }
    : undefined
  let observer: ViewportObserver | null = null
  const viewport = Extension.create({
    name: 'oneboxViewport',
    addProseMirrorPlugins() {
      // Tiptap 在创建 EditorView 时会覆盖 editorProps.nodeViews。
      return [
        createVisibilityPlugin(),
        new Plugin({ props: { nodeViews: blockNodeViews(heights, () => observer) } }),
      ]
    },
  })
  const editor = new Editor({
    element: opts.element,
    extensions: [...extensions, viewport],
    content: parseMarkdown(opts.markdown, schema).toJSON(),
    editorProps: {
      attributes: { 'aria-label': 'Markdown 编辑器', 'aria-multiline': 'true', role: 'textbox' },
      clipboardTextSerializer: (slice, view) =>
        serializeMarkdown(view.state.schema.topNodeType.create(null, slice.content)),
    },
    onUpdate: ({ editor }) => opts.onUpdate(editor.state.doc),
  })

  observer = createViewportObserver(editor.view, opts.scrollRoot, '200px', viewportMetrics)
  for (const child of editor.view.dom.children) observer.observe(child)

  return {
    editor,
    viewportMetrics,
    loadMarkdown(text) {
      const doc = parseMarkdown(text, editor.schema)
      // 新文件从独立的历史和选区开始，加载本身也不触发自动保存。
      editor.view.updateState(EditorState.create({ doc, plugins: editor.state.plugins }))
      opts.scrollRoot.scrollTop = 0
    },
    toMarkdown: () => serializeMarkdown(editor.state.doc),
    destroy() {
      observer?.disconnect()
      observer = null
      editor.destroy()
    },
  }
}
