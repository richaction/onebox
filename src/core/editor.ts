import { Editor, Extension, type JSONContent } from '@tiptap/core'
import { Fragment, Mark } from '@tiptap/pm/model'
import type { Node } from '@tiptap/pm/model'
import { EditorState, NodeSelection, Plugin, TextSelection, type Selection } from '@tiptap/pm/state'
import type { EditorProps, EditorView } from '@tiptap/pm/view'
import { isRelativeResource } from './attachmentLinks'
import { aiDocumentPlugin, aiInlineSourcePlugin } from './aiDocument'
import { MarkdownTaskInput, ViewportGroupEditing } from './blockCommands'
import { createBlockPresentation, keepTableCaretVisible } from './blockPresentation'
import { createCodeHighlight } from './codeHighlight'
import { developmentSession } from './developmentSession'
import { blockAtGutterPoint, placeCaretInGutter } from './editorCaret'
import { parseMarkdown, serializeMarkdown } from './markdown'
import type { ViewportMetrics } from './metrics'
import { MarkdownImage } from './markdownNodes'
import { extensions, schema } from './schema'
import { ListRowsSelection, listSelectionPlugin } from './listSelection'
import { blockNodeViews, type ViewportObserver } from './viewport/blockNodeView'
import { HeightCache } from './viewport/heights'
import { createViewportObserver } from './viewport/observer'
import { createVisibilityPlugin } from './viewport/visibility'

export interface EditorHandle {
  editor: Editor
  viewportMetrics?: ViewportMetrics
  loadMarkdown(text: string): void
  loadBlocks(blocks: JSONContent[], grouped?: boolean): void
  appendBlocks(blocks: JSONContent[]): void
  resetDocument(doc: Node): void
  refreshImages(): void
  toMarkdown(): string
  destroy(): void
}

const BLOCKS_PER_GROUP = 64

function collapseClickedSelection(view: EditorView, pos: number, event: MouseEvent) {
  const { doc, selection } = view.state
  const isTextOrBlock = selection instanceof TextSelection || selection instanceof ListRowsSelection
    || (selection instanceof NodeSelection && selection.node.isBlock)
  if (!view.editable || view.composing || event.button !== 0 ||
    event.shiftKey || event.altKey || event.metaKey || event.ctrlKey ||
    !isTextOrBlock || selection.empty || pos < selection.from || pos > selection.to) return false
  if ((event.target as Element | null)?.closest?.('button, input, [contenteditable="false"]')) return false
  const caret = doc.resolve(pos)
  if (!caret.parent.inlineContent) return false
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, pos)))
  view.focus()
  return true
}

export function createEditor(opts: {
  element: HTMLElement
  scrollRoot: HTMLElement
  markdown: string
  editable?: boolean
  onUpdate: (doc: Node) => void
  handleKeyDown?: NonNullable<EditorProps['handleKeyDown']>
  handleContextMenu?: NonNullable<EditorProps['handleDOMEvents']>['contextmenu']
  handleDrop?: EditorProps['handleDrop']
  handlePaste?: EditorProps['handlePaste']
  readImage?: (href: string) => Promise<Blob | undefined>
  imageContext?: () => string | null
  openResource?: (href: string) => void
}): EditorHandle {
  const heights = new HeightCache()
  const highlight = createCodeHighlight(opts.scrollRoot)
  const presentation = createBlockPresentation(highlight)
  const viewportMetrics = import.meta.env.DEV
    ? { created: 0, destroyed: 0, transactions: 0, lastTransactionMs: 0, maxTransactionMs: 0 }
    : undefined
  let observer: ViewportObserver | null = null
  let mousePress: { x: number; y: number; selection: Selection; dragged: boolean } | undefined
  const finishesDrag = (view: EditorView) => !!mousePress &&
    (mousePress.dragged || (!view.state.selection.empty && !view.state.selection.eq(mousePress.selection)))
  const localImages = new Set<() => void>()
  const viewport = Extension.create({
    name: 'oneboxViewport',
    addProseMirrorPlugins() {
      // Tiptap 在创建 EditorView 时会覆盖 editorProps.nodeViews。
      return [
        createVisibilityPlugin(),
        aiDocumentPlugin(),
        aiInlineSourcePlugin(),
        listSelectionPlugin(opts.scrollRoot),
        new Plugin({
          props: { nodeViews: blockNodeViews(heights, () => observer, presentation.present) },
          view(view) {
            let editable = view.editable
            return {
              update(view) {
                if (view.editable === editable) return
                editable = view.editable
                presentation.setEditable(editable)
              },
            }
          },
        }),
      ]
    },
  })
  const inlineImage = MarkdownImage.extend({
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement('img')
        const { src, alt, title } = node.attrs
        dom.alt = alt
        if (title) dom.title = title
        dom.decoding = 'async'
        let objectUrl: string | undefined
        let disposed = false
        let request = 0
        let previousContext: string | null | undefined
        const refresh = () => {
          const context = opts.imageContext?.()
          if (request > 0 && previousContext === context) return
          previousContext = context
          const generation = ++request
          if (objectUrl) {
            dom.removeAttribute('src')
            URL.revokeObjectURL(objectUrl)
            objectUrl = undefined
          }
          void opts.readImage?.(src).then((blob) => {
            if (!blob || disposed || generation !== request) return
            objectUrl = URL.createObjectURL(blob)
            dom.src = objectUrl
          }).catch(() => {})
        }

        if (isRelativeResource(src)) {
          localImages.add(refresh)
          refresh()
        } else if (/^https?:\/\//i.test(src)) {
          dom.src = src
        }
        return {
          dom,
          destroy() {
            disposed = true
            localImages.delete(refresh)
            if (objectUrl) URL.revokeObjectURL(objectUrl)
          },
        }
      }
    },
  })
  const editor = new Editor({
    element: opts.element,
    editable: opts.editable ?? true,
    extensions: [
      ...extensions.map((extension) => extension === MarkdownImage ? inlineImage : extension),
      MarkdownTaskInput,
      ViewportGroupEditing,
      viewport,
    ],
    content: parseMarkdown(opts.markdown, schema).toJSON(),
    onBeforeCreate: ({ editor }) => {
      if (!import.meta.env.DEV) return
      const snapshot = developmentSession.snapshot
      // A new Tiptap instance normally creates new node types. Reuse the schema
      // when its source is unchanged so document and undo history stay in memory.
      if (snapshot?.editorState && snapshot.schemaSource === schema) {
        editor.schema = snapshot.editorState.schema
        editor.extensionManager.schema = editor.schema
      }
    },
    editorProps: {
      attributes: {
        'aria-label': opts.editable === false ? 'Markdown 预览' : 'Markdown 编辑器',
        'aria-multiline': 'true', role: 'textbox',
        autocorrect: 'off', autocapitalize: 'none',
      },
      clipboardTextSerializer: (slice, view) =>
        serializeMarkdown(view.state.schema.topNodeType.create(null, slice.content)),
      handleKeyDown: opts.handleKeyDown,
      handleClick(view, pos, event) {
        return !finishesDrag(view) && collapseClickedSelection(view, pos, event)
      },
      handleDrop: opts.handleDrop,
      handlePaste: opts.handlePaste,
      handleScrollToSelection(view) {
        keepTableCaretVisible(view)
        return false
      },
      handleDOMEvents: {
        contextmenu: opts.handleContextMenu,
        click(view, event) {
          const moved = !!mousePress?.dragged
          const dragged = event.detail > 0 && finishesDrag(view)
          mousePress = undefined
          const target = event.target as Element | null
          const anchor = target?.closest?.('a[href]')
          const href = anchor?.getAttribute('href')
          if (href && opts.openResource && (event.metaKey || event.ctrlKey || !view.editable) && isRelativeResource(href)) {
            event.preventDefault()
            opts.openResource(href)
            return true
          }
          const button = target?.closest?.('[data-task-toggle]')
          const item = button?.closest('li')
          if (!item || !view.editable) {
            if (dragged || event.detail !== 1 || view.state.selection.empty || event.defaultPrevented) return false
            const point = view.posAtCoords({ left: event.clientX, top: event.clientY })
            return !!point && collapseClickedSelection(view, point.pos, event)
          }
          if (event.detail > 0 && moved) return true
          const $pos = view.state.doc.resolve(view.posAtDOM(item, 0))
          for (let depth = $pos.depth; depth > 0; depth--) {
            const node = $pos.node(depth)
            if (node.type.name !== 'listItem') continue
            view.dispatch(view.state.tr.setNodeAttribute($pos.before(depth), 'checked', !node.attrs.checked))
            return true
          }
          return false
        },
      },
    },
    onUpdate: ({ editor }) => opts.onUpdate(editor.state.doc),
  })

  observer = createViewportObserver(editor.view, opts.scrollRoot, 200, viewportMetrics)
  for (const child of editor.view.dom.children) observer.observe(child)
  let listDrag: { selection: NodeSelection; y: number } | undefined
  const updateMousePress = (event: MouseEvent) => {
    if (mousePress && (Math.abs(event.clientX - mousePress.x) > 4 || Math.abs(event.clientY - mousePress.y) > 4)) {
      mousePress.dragged = true
    }
  }
  const endMousePress = (event: MouseEvent) => {
    if (event.button === 0) updateMousePress(event)
    listDrag = undefined
  }
  const resetMousePress = () => {
    mousePress = undefined
    listDrag = undefined
  }
  const focusGutter = (event: MouseEvent) => {
    resetMousePress()
    if (event.button === 0) {
      mousePress = { x: event.clientX, y: event.clientY, selection: editor.state.selection, dragged: false }
    }
    placeCaretInGutter(editor.view, event, opts.scrollRoot)
    const { selection } = editor.state
    if (event.defaultPrevented && selection instanceof NodeSelection && selection.node.type.name === 'listItem') {
      listDrag = { selection, y: event.clientY }
    }
  }
  const dragListRows = (event: MouseEvent) => {
    if (event.buttons & 1) updateMousePress(event)
    if (!listDrag) return
    if (!(event.buttons & 1) || editor.state.doc !== listDrag.selection.$from.doc || !editor.isEditable) {
      listDrag = undefined
      return
    }
    if (Math.abs(event.clientY - listDrag.y) < 4 && editor.state.selection === listDrag.selection) return
    const target = blockAtGutterPoint(editor.view, event.clientY)
    if (!target) return
    const selected = ListRowsSelection.between(listDrag.selection.$from, target.$from)
    if (selected && !selected.eq(editor.state.selection)) {
      editor.view.dispatch(editor.state.tr.setSelection(selected))
    }
  }
  opts.scrollRoot.addEventListener('mousedown', focusGutter, true)
  document.addEventListener('mousemove', dragListRows, true)
  document.addEventListener('mouseup', endMousePress, true)
  window.addEventListener('blur', resetMousePress)

  const load = (doc: Node) => {
    resetMousePress()
    editor.view.updateState(EditorState.create({ doc, plugins: editor.state.plugins }))
    opts.scrollRoot.scrollTop = 0
  }
  const decodeNode = (block: JSONContent): Node => {
    const { schema } = editor
    const marks = (block.marks ?? []).reduce(
      (set, mark) => schema.markFromJSON(mark).addToSet(set), Mark.none,
    )
    if (block.type === 'text') return schema.text(block.text!, marks)
    return schema.node(block.type!, block.attrs, block.content?.map(decodeNode), marks)
  }
  const decodeBlocks = (blocks: JSONContent[], grouped: boolean) => {
    const nodes = blocks.map(decodeNode)
    if (!grouped) return nodes
    const groups: Node[] = []
    for (let index = 0; index < nodes.length; index += BLOCKS_PER_GROUP) {
      groups.push(editor.schema.nodes.viewportGroup.createChecked(null, nodes.slice(index, index + BLOCKS_PER_GROUP)))
    }
    return groups
  }

  return {
    editor,
    viewportMetrics,
    loadMarkdown(text) {
      load(parseMarkdown(text, editor.schema))
    },
    loadBlocks(blocks, groupBlocks = false) {
      load(editor.schema.topNodeType.createChecked(null, decodeBlocks(blocks, groupBlocks)))
    },
    appendBlocks(blocks) {
      const { state } = editor
      const grouped = state.doc.lastChild?.type.name === 'viewportGroup'
      const insert = state.tr.insert(state.doc.content.size, Fragment.fromArray(decodeBlocks(blocks, grouped)))
      editor.view.updateState(state.apply(insert.setMeta('addToHistory', false)))
    },
    resetDocument(doc) {
      load(doc)
    },
    refreshImages() {
      for (const refresh of localImages) refresh()
    },
    toMarkdown: () => serializeMarkdown(editor.state.doc),
    destroy() {
      opts.scrollRoot.removeEventListener('mousedown', focusGutter, true)
      document.removeEventListener('mousemove', dragListRows, true)
      document.removeEventListener('mouseup', endMousePress, true)
      window.removeEventListener('blur', resetMousePress)
      observer?.disconnect()
      observer = null
      editor.destroy()
      highlight?.destroy()
    },
  }
}
