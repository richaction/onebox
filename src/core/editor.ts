import { Editor, Extension, type JSONContent } from '@tiptap/core'
import { Fragment, Mark } from '@tiptap/pm/model'
import type { Node } from '@tiptap/pm/model'
import { EditorState, Plugin, Selection, TextSelection } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import type { EditorProps, EditorView } from '@tiptap/pm/view'
import { isRelativeResource } from './attachmentLinks'
import { isReorderedPointerRelease, reachesDragThreshold } from './buttonClickTolerance'
import { aiDocumentPlugin, aiInlineSourcePlugin } from './aiDocument'
import { isBlockSelection } from './blockSelection'
import { MarkdownTaskInput, ViewportGroupEditing } from './blockCommands'
import { createBlockPresentation, keepTableCaretVisible } from './blockPresentation'
import { editorImage } from './editorImage'
import { createCodeHighlight } from './codeHighlight'
import { developmentSession } from './developmentSession'
import { caretAtEditorPoint, isGutterPress, nearestCaret, placeCaretInGutter, taskCaretAtPoint } from './editorCaret'
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

function isCaretClick(view: EditorView, event: MouseEvent) {
  return view.editable && !view.composing && event.button === 0 &&
    !event.defaultPrevented && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey &&
    !(event.target as Element | null)?.closest?.('button, input, [contenteditable="false"]')
}

function canCollapseSelection(view: EditorView, event: MouseEvent) {
  const { selection } = view.state
  return isCaretClick(view, event) && !selection.empty &&
    (selection instanceof TextSelection || selection instanceof CellSelection || isBlockSelection(selection))
}

function collapseClickedSelection(view: EditorView, caret: Selection | undefined) {
  if (!(caret instanceof TextSelection) || !caret.empty) return false
  if (!caret.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(caret))
  view.focus()
  return true
}

function nativeTextRange(view: EditorView) {
  const selection = view.dom.ownerDocument.getSelection()
  if (!selection?.rangeCount || selection.isCollapsed || !view.dom.contains(selection.anchorNode) ||
    !view.dom.contains(selection.focusNode)) return
  return selection.getRangeAt(0)
}

function nativeRangeChanged(view: EditorView, before: Range | undefined) {
  const range = nativeTextRange(view)
  return !!range && (!before || range.startContainer !== before.startContainer || range.startOffset !== before.startOffset ||
    range.endContainer !== before.endContainer || range.endOffset !== before.endOffset)
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
  let mousePress: { x: number; y: number; selection: Selection; nativeRange?: Range; dragged: boolean } | undefined
  const finishesDrag = (view: EditorView) => !!mousePress &&
    (mousePress.dragged || nativeRangeChanged(view, mousePress.nativeRange) ||
      (!view.state.selection.empty && !view.state.selection.eq(mousePress.selection)))
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
        if (finishesDrag(view) || !isCaretClick(view, event)) return false
        const taskCaret = taskCaretAtPoint(view, event.clientX, event.clientY)
        return collapseClickedSelection(view, taskCaret ??
          (canCollapseSelection(view, event) ? nearestCaret(view, pos, event.clientY) : undefined))
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
            if (dragged || event.detail !== 1 || !isCaretClick(view, event)) return false
            const caret = canCollapseSelection(view, event) ? caretAtEditorPoint(view, event.clientX, event.clientY)
              : taskCaretAtPoint(view, event.clientX, event.clientY)
            return collapseClickedSelection(view, caret)
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
  type SelectionPress = { event: MouseEvent; selection: Selection; nativeRange?: Range }
  type SelectionPointer = SelectionPress & { event: PointerEvent; received: number }
  type Drag = { press?: SelectionPress; anchor?: TextSelection; recovered?: boolean }
  let pointerDown: (Drag & { event: PointerEvent; mouseHeld?: boolean }) | undefined
  let mouseOnlyDrag: Drag | undefined
  let releasedTapPointer: number | undefined
  let earlyRelease: SelectionPointer | undefined
  let latestEditorPress = -Infinity
  let latestPointerRelease = -Infinity
  const insideEditor = (event: Event) => event.target instanceof globalThis.Node && scrollRoot.contains(event.target)
  const discardStaleMouseEvent = (event: MouseEvent) => {
    if (event.button !== 0 || event.timeStamp >= latestEditorPress || !insideEditor(event)) return false
    // A late release/click from the previous tap must not finish the next drag.
    event.preventDefault()
    event.stopImmediatePropagation()
    return true
  }
  const selectionPress = (event: MouseEvent): SelectionPress | undefined => {
    const view = editor.view
    const target = event.target
    if (!(target instanceof Element) || !scrollRoot.contains(target) || !isCaretClick(view, event) ||
      (!canCollapseSelection(view, event) && !isGutterPress(view, event, scrollRoot) && !target.closest('li[data-checked]'))) return
    return { event, selection: view.state.selection, nativeRange: nativeTextRange(view)?.cloneRange() }
  }
  const collapseTap = (press: SelectionPress, release: PointerEvent) => {
    const view = editor.view
    const { event, selection } = press
    const current = view.state.selection
    if (selection.$from.doc !== view.state.doc || (!current.empty && !selection.eq(current)) || nativeRangeChanged(view, press.nativeRange) ||
      reachesDragThreshold(release.clientX - event.clientX, release.clientY - event.clientY)) return false
    if (selection.empty) {
      return placeCaretInGutter(view, release, scrollRoot) ||
        collapseClickedSelection(view, taskCaretAtPoint(view, release.clientX, release.clientY))
    }
    return collapseClickedSelection(view, caretAtEditorPoint(view, release.clientX, release.clientY))
  }
  const startSelectionTap = (event: PointerEvent) => {
    if (!event.isPrimary || event.pointerType !== 'mouse' || event.button !== 0) return
    if (discardStaleMouseEvent(event)) return
    if (insideEditor(event)) latestEditorPress = event.timeStamp
    const release = earlyRelease
    releasedTapPointer = undefined
    earlyRelease = undefined
    mouseOnlyDrag = undefined
    const press = selectionPress(event)
    if (release && insideEditor(event) && isReorderedPointerRelease(event, release.event, performance.now() - release.received)) {
      // WKWebView can deliver pointerup before pointerdown. The gesture has already ended.
      pointerDown = undefined
      releasedTapPointer = event.pointerId
      if (press && press.selection.eq(release.selection) && collapseTap(press, release.event)) event.preventDefault()
      return
    }
    pointerDown = { event, press }
  }
  const extendTextDrag = (anchor: TextSelection, event: MouseEvent) => {
    const view = editor.view
    if (!view.editable || view.composing || anchor.$anchor.doc !== view.state.doc) return
    const head = caretAtEditorPoint(view, event.clientX, event.clientY)
    if (!(head instanceof TextSelection)) return
    const range = TextSelection.create(view.state.doc, anchor.anchor, head.head)
    if (!range.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(range).setMeta('pointer', true))
  }
  const finishSelectionTap = (event: PointerEvent) => {
    if (!event.isPrimary || event.pointerType !== 'mouse' || event.button !== 0) return
    if (discardStaleMouseEvent(event)) return
    const down = pointerDown
    if (down && (down.event.pointerId !== event.pointerId || event.timeStamp < down.event.timeStamp)) return
    if (insideEditor(event) || down?.press || down?.anchor) latestPointerRelease = event.timeStamp
    pointerDown = undefined
    releasedTapPointer = undefined
    const completed = down ?? mouseOnlyDrag
    mouseOnlyDrag = undefined
    if (completed?.anchor) {
      extendTextDrag(completed.anchor, event)
      return
    }
    const release = selectionPress(event)
    earlyRelease = !completed && release ? { ...release, event, received: performance.now() } : undefined
    if (release && down?.press) collapseTap(down.press, event)
  }
  const cancelSelectionTap = () => {
    releasedTapPointer = undefined
    pointerDown = undefined
    mouseOnlyDrag = undefined
    earlyRelease = undefined
  }
  const updateMousePress = (event: MouseEvent) => {
    if (mousePress && event.timeStamp >= latestEditorPress &&
      reachesDragThreshold(event.clientX - mousePress.x, event.clientY - mousePress.y)) {
      mousePress.dragged = true
    }
  }
  const moveTextDrag = (down: Drag, event: MouseEvent) => {
    if (down.anchor) {
      extendTextDrag(down.anchor, event)
      return
    }
    const { press } = down
    if (!press || !reachesDragThreshold(event.clientX - press.event.clientX, event.clientY - press.event.clientY)) return
    down.press = undefined
    const view = editor.view
    // Keep a native selection that has already grown. If WebKit leaves the
    // caret collapsed, resolve the drag from where the pointer first pressed.
    if (!view.editable || view.composing || press.selection.$from.doc !== view.state.doc ||
      nativeRangeChanged(view, press.nativeRange) || (!view.state.selection.empty && !view.state.selection.eq(press.selection))) return
    const { clientX, clientY } = press.event
    const anchor = down.recovered || isGutterPress(view, press.event, scrollRoot)
      ? caretAtEditorPoint(view, clientX, clientY)
      : taskCaretAtPoint(view, clientX, clientY)
    if (!(anchor instanceof TextSelection)) return
    down.anchor = anchor
    mousePress ??= { x: press.event.clientX, y: press.event.clientY, selection: press.selection,
      nativeRange: press.nativeRange, dragged: true }
    mousePress.dragged = true
    if (!view.hasFocus()) view.focus()
    extendTextDrag(anchor, event)
  }
  const moveSelectionTap = (event: PointerEvent) => {
    // After an up-before-down tap, WKWebView can report the next three-finger
    // press as a pointermove with buttons=1. Hover coordinates belong to neither drag.
    if (releasedTapPointer === event.pointerId && event.isPrimary && event.pointerType === 'mouse' && event.buttons !== 0) {
      releasedTapPointer = undefined
      const view = editor.view
      const target = event.target
      if (event.buttons === 1 && !event.defaultPrevented && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
        view.editable && !view.composing && target instanceof Element && scrollRoot.contains(target) &&
        !target.closest('button,input,textarea,a,[contenteditable="false"],td,th') &&
        (target.closest('p,h1,h2,h3,h4,h5,h6,li') || target === scrollRoot || target === view.dom || target === view.dom.parentElement)) {
        latestEditorPress = event.timeStamp
        mousePress = undefined
        pointerDown = { event, recovered: true, press: { event, selection: view.state.selection,
          nativeRange: nativeTextRange(view)?.cloneRange() } }
      }
    }
    const down = pointerDown
    if (!down || event.pointerId !== down.event.pointerId || event.timeStamp < down.event.timeStamp) return
    // A primary pointerdown is itself a press, even before a compatibility mousedown.
    if (down.mouseHeld !== false) moveTextDrag(down, event)
  }
  const moveMousePress = (event: MouseEvent) => {
    updateMousePress(event)
    if (event.timeStamp < latestEditorPress) return
    // WebKit may deliver movement through either stream. A matching mousedown
    // remains held until release, including dragged events reporting buttons=0.
    const down = pointerDown?.mouseHeld ? pointerDown : mouseOnlyDrag
    if (!down) return
    moveTextDrag(down, event)
    if (down.anchor) event.preventDefault()
  }
  const endMousePress = (event: MouseEvent) => {
    if (event.button !== 0 || discardStaleMouseEvent(event)) return
    const anchor = pointerDown?.anchor ?? mouseOnlyDrag?.anchor
    if (anchor) extendTextDrag(anchor, event)
    mouseOnlyDrag = undefined
    if (pointerDown && event.timeStamp >= pointerDown.event.timeStamp) pointerDown.mouseHeld = false
    updateMousePress(event)
    const view = editor.view
    if (mousePress && !finishesDrag(view) && event.target instanceof globalThis.Node && scrollRoot.contains(event.target)) {
      placeCaretInGutter(view, event, scrollRoot)
    }
  }
  const resetMousePress = () => {
    mousePress = undefined
    latestEditorPress = -Infinity
    latestPointerRelease = -Infinity
    cancelSelectionTap()
  }
  const recordMousePress = (event: MouseEvent) => {
    if (discardStaleMouseEvent(event)) return
    // A delayed compatibility press for a completed tap must not arm a hover drag.
    if (event.button === 0 && !pointerDown && event.timeStamp <= latestPointerRelease) return
    if (pointerDown?.mouseHeld === false) pointerDown = undefined
    mousePress = undefined
    mouseOnlyDrag = undefined
    const target = event.target as Element | null
    // Task toggles use the native button click. Text and gutter presses still track drag selection.
    if (event.button === 0 && !target?.closest?.('[data-task-toggle]')) {
      latestEditorPress = event.timeStamp
      if (pointerDown && event.timeStamp >= pointerDown.event.timeStamp) pointerDown.mouseHeld = true
      else if (!pointerDown) mouseOnlyDrag = { press: selectionPress(event) }
      mousePress = { x: event.clientX, y: event.clientY, selection: editor.state.selection,
        nativeRange: nativeTextRange(editor.view)?.cloneRange(), dragged: false }
    }
  }
  const discardStaleClick = (event: MouseEvent) => { if (event.detail > 0) discardStaleMouseEvent(event) }
  const cancelPointerTap = (event: PointerEvent) => {
    if (!pointerDown || (event.pointerId === pointerDown.event.pointerId && event.timeStamp >= pointerDown.event.timeStamp)) {
      cancelSelectionTap()
    }
  }
  scrollRoot.addEventListener('mousedown', recordMousePress, true)
  scrollRoot.addEventListener('click', discardStaleClick, true)
  window.addEventListener('pointerdown', startSelectionTap, true)
  window.addEventListener('pointerup', finishSelectionTap, true)
  window.addEventListener('pointermove', moveSelectionTap, true)
  window.addEventListener('pointercancel', cancelPointerTap, true)
  document.addEventListener('mousemove', moveMousePress, true)
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
      scrollRoot.removeEventListener('mousedown', recordMousePress, true)
      scrollRoot.removeEventListener('click', discardStaleClick, true)
      window.removeEventListener('pointerdown', startSelectionTap, true)
      window.removeEventListener('pointerup', finishSelectionTap, true)
      window.removeEventListener('pointermove', moveSelectionTap, true)
      window.removeEventListener('pointercancel', cancelPointerTap, true)
      document.removeEventListener('mousemove', moveMousePress, true)
      document.removeEventListener('mouseup', endMousePress, true)
      window.removeEventListener('blur', resetMousePress)
      observer?.disconnect()
      observer = null
      editor.destroy()
      highlight?.destroy()
    },
  }
}
