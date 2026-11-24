import { Editor, Extension, type JSONContent } from '@tiptap/core'
import { Fragment, Mark } from '@tiptap/pm/model'
import type { Node } from '@tiptap/pm/model'
import { EditorState, NodeSelection, Plugin, Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorProps, EditorView } from '@tiptap/pm/view'
import { isRelativeResource } from './attachmentLinks'
import { reachesDragThreshold } from './buttonClickTolerance'
import { aiDocumentPlugin, aiInlineSourcePlugin } from './aiDocument'
import { blockRangeSelectionPlugin, extendBlockSelection, isBlockSelection } from './blockSelection'
import { MarkdownTaskInput, ViewportGroupEditing } from './blockCommands'
import { createBlockPresentation, keepTableCaretVisible } from './blockPresentation'
import { editorImage } from './editorImage'
import { createCodeHighlight } from './codeHighlight'
import { developmentSession } from './developmentSession'
import { blockAtGutterPoint, gutterDragAnchor, placeCaretInGutter, selectBlockInGutter } from './editorCaret'
import { parseMarkdown, serializeMarkdown } from './markdown'
import type { ViewportMetrics } from './metrics'
import { MarkdownImage } from './markdownNodes'
import { extensions, schema } from './schema'
import { listSelectionPlugin } from './listSelection'
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
  const isTextOrBlock = selection instanceof TextSelection || isBlockSelection(selection)
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
  handleTextInput?: EditorProps['handleTextInput']
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
        blockRangeSelectionPlugin(),
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
      return ({ node, view, getPos }) => editorImage(node, view, getPos, {
        read: opts.readImage, context: opts.imageContext, refreshers: localImages,
      })
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
      handleKeyDown(view, event) {
        if (opts.handleKeyDown?.(view, event)) return true
        if (!view.editable || view.composing || event.isComposing || event.metaKey || event.ctrlKey || event.altKey ||
          event.shiftKey || (event.key !== 'Escape' && event.key !== 'Enter')) return false
        const { selection } = view.state
        if (!isBlockSelection(selection)) return false
        const caret = Selection.findFrom(selection.$from, 1, true)
        if (caret && caret.from < selection.to) view.dispatch(view.state.tr.setSelection(caret))
        else if (event.key === 'Escape') {
          const exit = Selection.findFrom(selection.$to, 1, true) ?? Selection.findFrom(selection.$from, -1, true)
          view.dispatch(view.state.tr.setSelection(exit ?? Selection.near(selection.$to)))
        }
        return true
      },
      handleClick(view, pos, event) {
        return !finishesDrag(view) && collapseClickedSelection(view, pos, event)
      },
      handleDrop: opts.handleDrop,
      handlePaste: opts.handlePaste,
      handleTextInput: opts.handleTextInput,
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
  const scrollRoot = opts.scrollRoot
  let gutterDrag: { anchor: NodeSelection; pointer: number; x: number; y: number; started: boolean } | undefined
  let dragFrame = 0
  const updateMousePress = (event: MouseEvent) => {
    if (mousePress && reachesDragThreshold(event.clientX - mousePress.x, event.clientY - mousePress.y)) {
      mousePress.dragged = true
    }
  }
  const stopGutterDrag = () => {
    cancelAnimationFrame(dragFrame)
    const pointer = gutterDrag?.pointer
    gutterDrag = undefined
    if (pointer !== undefined && scrollRoot.hasPointerCapture(pointer)) scrollRoot.releasePointerCapture(pointer)
  }
  const selectDragRange = (y: number) => {
    const drag = gutterDrag
    const view = editor.view
    if (!drag || view.state.doc !== drag.anchor.$from.doc || !view.editable) return
    const page = view.dom.getBoundingClientRect()
    const viewport = scrollRoot.getBoundingClientRect()
    const top = viewport.height > 0 ? Math.max(page.top, viewport.top) : page.top
    const bottom = viewport.height > 0 ? Math.min(page.bottom, viewport.bottom) : page.bottom
    if (bottom <= top) return
    const target = blockAtGutterPoint(view, Math.min(bottom - 1, Math.max(top, y)))
    const selection = target && extendBlockSelection(drag.anchor, target)
    if (selection && !selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection))
  }
  const endMousePress = (event: MouseEvent) => {
    if (event.button === 0) updateMousePress(event)
  }
  const resetMousePress = () => {
    mousePress = undefined
    stopGutterDrag()
  }
  const focusGutter = (event: MouseEvent) => {
    mousePress = undefined
    const target = event.target as Element | null
    // Task toggles use the native button click. Text and gutter presses still track drag selection.
    if (event.button === 0 && !target?.closest?.('[data-task-toggle]')) {
      mousePress = { x: event.clientX, y: event.clientY, selection: editor.state.selection, dragged: false }
    }
    placeCaretInGutter(editor.view, event, scrollRoot)
  }
  const doubleClickGutter = (event: MouseEvent) => {
    if (!mousePress?.dragged) selectBlockInGutter(editor.view, event, scrollRoot)
  }
  const startGutterDrag = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return
    stopGutterDrag()
    const anchor = gutterDragAnchor(editor.view, event, scrollRoot)
    if (!anchor) return
    gutterDrag = { anchor, pointer: event.pointerId, x: event.clientX, y: event.clientY, started: false }
    scrollRoot.setPointerCapture(event.pointerId)
  }
  const movedFromGutter = (event: PointerEvent) =>
    gutterDrag?.pointer === event.pointerId &&
    reachesDragThreshold(event.clientX - gutterDrag.x, event.clientY - gutterDrag.y, event.pointerType)
  const dragFromGutter = (event: PointerEvent) => {
    const drag = gutterDrag
    if (!drag || drag.pointer !== event.pointerId || (!drag.started && !movedFromGutter(event))) return
    drag.started = true
    if (mousePress) mousePress.dragged = true
    const y = event.clientY
    selectDragRange(y)
    cancelAnimationFrame(dragFrame)
    const { top, bottom, height } = scrollRoot.getBoundingClientRect()
    if (!height) return
    const step = y < top + 24 ? -16 : y > bottom - 24 ? 16 : 0
    if (!step) return
    const scroll = () => {
      if (gutterDrag !== drag) return
      const before = scrollRoot.scrollTop
      scrollRoot.scrollTop += step
      if (scrollRoot.scrollTop === before) return
      selectDragRange(y)
      dragFrame = requestAnimationFrame(scroll)
    }
    dragFrame = requestAnimationFrame(scroll)
  }
  const finishGutterDrag = (event: PointerEvent) => {
    if (gutterDrag?.pointer !== event.pointerId) return
    if (event.type === 'pointerup' && (gutterDrag.started || movedFromGutter(event))) selectDragRange(event.clientY)
    stopGutterDrag()
  }
  scrollRoot.addEventListener('mousedown', focusGutter, true)
  scrollRoot.addEventListener('dblclick', doubleClickGutter, true)
  scrollRoot.addEventListener('pointerdown', startGutterDrag, true)
  scrollRoot.addEventListener('lostpointercapture', finishGutterDrag)
  window.addEventListener('pointermove', dragFromGutter, true)
  window.addEventListener('pointerup', finishGutterDrag, true)
  window.addEventListener('pointercancel', finishGutterDrag, true)
  document.addEventListener('mousemove', updateMousePress, true)
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
      stopGutterDrag()
      scrollRoot.removeEventListener('mousedown', focusGutter, true)
      scrollRoot.removeEventListener('dblclick', doubleClickGutter, true)
      scrollRoot.removeEventListener('pointerdown', startGutterDrag, true)
      scrollRoot.removeEventListener('lostpointercapture', finishGutterDrag)
      window.removeEventListener('pointermove', dragFromGutter, true)
      window.removeEventListener('pointerup', finishGutterDrag, true)
      window.removeEventListener('pointercancel', finishGutterDrag, true)
      document.removeEventListener('mousemove', updateMousePress, true)
      document.removeEventListener('mouseup', endMousePress, true)
      window.removeEventListener('blur', resetMousePress)
      observer?.disconnect()
      observer = null
      editor.destroy()
      highlight?.destroy()
    },
  }
}
