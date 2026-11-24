import type { Range } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { Node as DocumentNode } from '@tiptap/pm/model'
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state'
import { createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount, Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { captureAiReference, highlightAiSource, type AiReference } from '../core/aiDocument'
import {
  blockCommands, diagramCommands, insertCommands, slashTrigger, tableCommands,
  type CommandItem, type MenuItem,
} from '../core/blockCommands'
import { blockDropTarget, moveBlock } from '../core/blockMove'
import { isClickFromRelease, reachesDragThreshold } from '../core/buttonClickTolerance'
import { createEditor, type EditorHandle } from '../core/editor'
import { listTextSelectionRects } from '../core/listSelection'
import { trackMenuPress } from '../core/menuPress'
import BlockMenu from './BlockMenu'
import InlineAiEditor from './InlineAiEditor'
import SelectionToolbar, { inlineFormatMarks, selectionToolbarFormat, selectionToolbarHeight, selectionToolbarWidth } from './SelectionToolbar'

export type AttachmentKind = 'image' | 'file'

interface Popup {
  x: number
  y: number
  above: number
  trigger?: NonNullable<ReturnType<typeof slashTrigger>>
  inTable: boolean
  quoteRange?: Range
  selection: Selection
}

type GripDrag = { pointer: number; selection: NodeSelection; startX: number; startY: number; moved: boolean }

type Action = CommandItem | (MenuItem & { attachment: AttachmentKind }) | (MenuItem & { ai: 'quote' | 'edit' }) |
  (MenuItem & { mark: string }) | (MenuItem & { children: true })

const quoteAction: Action = { label: '引用到侧栏', search: 'AI 引用 侧栏', icon: '✦', ai: 'quote' }
const editAction: Action = { label: '正文编辑', search: 'AI 编辑 正文', icon: '✎', ai: 'edit' }
const formatActions: readonly Action[] = inlineFormatMarks.map(({ name, symbol, mark }) =>
  ({ label: name, search: name, icon: symbol, mark }))
const chartsAction: Action = { label: '图表与流程图', search: '图表 chart', icon: '▥', children: true }
const matchesQuery = (item: MenuItem, query: string) =>
  `${item.label} ${item.search} ${item.shortcut ?? ''}`.toLowerCase().includes(query)
const typedSlash = 'onebox-typed-slash'
const contextMenuFormat = 'onebox:context-menu-format'

const attachmentItems: readonly Action[] = [
  {
    label: '图片', search: 'image photo', icon: '▧',
    attachment: 'image',
  },
  {
    label: '附件', search: 'attachment file', icon: '▤',
    attachment: 'file',
  },
]

export default function EditorShell(props: {
  markdown: string
  onReady: (handle: EditorHandle) => void
  onDispose?: (handle: EditorHandle) => void
  onUpdate: (doc: DocumentNode) => void
  onInsertAttachment?: (kind: AttachmentKind, range?: Range) => void
  onInsertFiles?: (files: File[], range?: Range) => void
  onQuoteSelection?: (range?: Range) => void
  inlineAi?: boolean
  showSelectionToolbar?: boolean
  readImage?: (href: string) => Promise<Blob | undefined>
  imageContext?: () => string | null
  openResource?: (href: string) => void
}) {
  let scrollRoot!: HTMLDivElement
  let element!: HTMLDivElement
  let popupElement: HTMLDivElement | undefined
  let selectionElement: HTMLDivElement | undefined
  let handle: EditorHandle | undefined
  let selectionRects: { selection: Selection; rects: DOMRect[] } | undefined
  let selectionFrame = 0
  let menuPress: ReturnType<typeof trackMenuPress>
  let blockDrag: GripDrag | undefined
  let blockScrollFrame = 0
  let gripDragRelease: PointerEvent | undefined

  const [popup, setPopup] = createSignal<Popup>()
  const [selectionMenu, setSelectionMenu] = createSignal<{
    x: number; y: number; above: boolean; width: number; maxHeight: number; selection: Selection
  }>()
  const [inlineEdit, setInlineEdit] = createSignal<AiReference & { anchor: number }>()
  const [blockGrip, setBlockGrip] = createSignal<{ x: number; y: number; selection: NodeSelection }>()
  const [blockDrop, setBlockDrop] = createSignal<ReturnType<typeof blockDropTarget>>()
  const [highlighted, setHighlighted] = createSignal(0)
  const [chartChoice, setChartChoice] = createSignal<number>()
  const [keyboardHighlight, setKeyboardHighlight] = createSignal(true)
  const menuId = createUniqueId()
  const query = () => popup()?.trigger?.query.toLowerCase() ?? ''
  const charts = createMemo(() => matchesQuery(chartsAction, query())
    ? diagramCommands : diagramCommands.filter((item) => matchesQuery(item, query())))
  const groups = createMemo(() => {
    const current = popup()
    if (!current) return []
    const sections: [string, readonly Action[], 'inline'?][] = current.inTable
      ? [['表格操作', tableCommands]]
      : [
        [current.trigger ? '基本区块' : '转换区块', blockCommands],
        ['插入内容', [chartsAction, ...insertCommands]],
        ['媒体与附件', props.onInsertAttachment ? attachmentItems : []],
      ]
    if (current.quoteRange) {
      const { selection } = current
      if (selection instanceof TextSelection && !selection.empty && !selection.$from.parent.type.spec.code) {
        sections.unshift(['行内格式', formatActions, 'inline'])
      }
      const actions = []
      if (props.onQuoteSelection) actions.push(quoteAction)
      if (props.inlineAi && !inlineEdit()) actions.push(editAction)
      if (actions.length) sections.unshift(['AI', actions])
    }
    const search = query()
    let index = 0
    return sections.flatMap(([label, commands, layout]) => {
      const matches = commands.filter((item) => 'children' in item ? charts().length > 0 : matchesQuery(item, search))
      const exact = matches.findIndex((item) => item.shortcut === search)
      if (exact > 0) matches.unshift(...matches.splice(exact, 1))
      return matches.length ? [{
        label, layout, items: matches.map((item) => ({
          item, index: index++, applied: 'mark' in item && !!handle?.editor.isActive(item.mark),
          current: !current.trigger && !!item.headingLevel &&
            !!handle?.editor.isActive('heading', { level: item.headingLevel }),
        })),
      }] : []
    })
  })
  const items = createMemo(() => groups().flatMap((group) => group.items))

  const closeMenu = () => {
    if (menuPress.active(popupElement)) menuPress.clear()
    setChartChoice(undefined)
    setPopup(undefined)
  }

  const closeSelectionMenu = () => {
    if (menuPress.active(selectionElement)) menuPress.clear()
    setSelectionMenu(undefined)
  }

  const resetSelectionMenu = () => {
    selectionRects = undefined
    closeSelectionMenu()
  }

  const closeInlineEdit = (restoreFocus: boolean) => {
    setInlineEdit(undefined)
    if (restoreFocus) handle?.editor.view.focus()
  }

  const startInlineEdit = (range: Range) => {
    const editor = handle?.editor
    if (!props.inlineAi || !editor?.isEditable || inlineEdit()) return false
    const reference = captureAiReference(editor, 'selection', '', range)
    if (!reference || reference.anchor === undefined) return false
    closeSelectionMenu()
    highlightAiSource(editor, reference.anchor)
    setInlineEdit({ ...reference, anchor: reference.anchor })
    return true
  }

  const showSelectionMenu = (x: number, y: number, afterSelection = false) => {
    const view = handle?.editor.view
    if (!view?.editable || !view.hasFocus() || view.composing || inlineEdit() || popup()) return
    const { selection } = view.state
    if (!(selection instanceof TextSelection) || selection.empty) return
    if (selectionMenu()?.selection.eq(selection)) return
    if (!selectionRects?.selection.eq(selection)) {
      const native = window.getSelection()
      if (!native?.rangeCount || native.isCollapsed || !view.dom.contains(native.anchorNode) ||
        !view.dom.contains(native.focusNode)) return
      selectionRects = { selection, rects: listTextSelectionRects(view) ?? Array.from(native.getRangeAt(0).getClientRects()) }
    }
    const rects = selectionRects.rects.filter((rect) => rect.width > 0)
    if (!rects.length) return
    if (!afterSelection && !rects.some((rect) => x >= rect.left && x <= rect.right &&
      y >= rect.top && y <= rect.bottom)) return
    let topEdge = rects[0].top
    let bottomEdge = rects[0].bottom
    for (const rect of rects) {
      topEdge = Math.min(topEdge, rect.top)
      bottomEdge = Math.max(bottomEdge, rect.bottom)
    }
    const bounds = scrollRoot.getBoundingClientRect()
    const width = Math.min(selectionToolbarWidth, Math.max(0, bounds.width - 8))
    const minY = bounds.top + 4
    const maxY = bounds.bottom - 4
    const aboveY = topEdge - 5
    const belowY = bottomEdge + 5
    const aboveSpace = aboveY - minY
    const belowSpace = maxY - belowY
    const nearEnd = Math.abs(y - bottomEdge) <= Math.abs(y - topEdge)
    const above = aboveSpace >= selectionToolbarHeight ? !nearEnd || belowSpace < selectionToolbarHeight
      : belowSpace < selectionToolbarHeight && aboveSpace > belowSpace
    const minHeight = Math.min(selectionToolbarHeight, maxY - minY)
    const anchor = above ? Math.max(minY + minHeight, Math.min(aboveY, maxY))
      : Math.min(maxY - minHeight, Math.max(minY, belowY))
    setSelectionMenu({
      x: Math.max(bounds.left + 4, Math.min(x - width / 2, bounds.right - width - 4)),
      y: anchor, above, width, maxHeight: Math.min(360, above ? anchor - minY : maxY - anchor),
      selection,
    })
  }

  const hoverSelection = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.buttons === 0 && event.target instanceof Node &&
      handle?.editor.view.dom.contains(event.target)) showSelectionMenu(event.clientX, event.clientY)
  }

  const hoverAfterSelection = (event: PointerEvent) => {
    if (event.button !== 0 || (event.target as Element | null)?.closest?.('button, input, textarea, [contenteditable="false"]')) return
    cancelAnimationFrame(selectionFrame)
    // A drag can end past the last selected glyph, especially with wide characters.
    const show = () => showSelectionMenu(event.clientX, event.clientY, true)
    selectionFrame = requestAnimationFrame(() => {
      show()
      if (!selectionMenu()) selectionFrame = requestAnimationFrame(show)
    })
  }

  const positionBlockGrip = () => {
    if (blockDrag) return
    const view = handle?.editor.view
    const selection = view?.state.selection
    if (!view?.editable || !(selection instanceof NodeSelection) || !selection.node.isBlock) {
      setBlockGrip(undefined)
      return
    }
    const node = view.nodeDOM(selection.from)
    if (!(node instanceof HTMLElement)) { setBlockGrip(undefined); return }
    const row = node.getBoundingClientRect()
    const visible = scrollRoot.getBoundingClientRect()
    if (row.bottom < visible.top || row.top + 28 > visible.bottom) { setBlockGrip(undefined); return }
    setBlockGrip({
      x: Math.max(visible.left + 2, view.dom.getBoundingClientRect().left - 30),
      y: Math.max(visible.top, row.top) + 2,
      selection,
    })
  }

  const endBlockDrag = () => {
    cancelAnimationFrame(blockScrollFrame)
    blockDrag = undefined
    setBlockDrop(undefined)
  }

  const startBlockDrag = (event: PointerEvent & { currentTarget: HTMLButtonElement }, selection: NodeSelection) => {
    const view = handle?.editor.view
    if (event.defaultPrevented || event.button !== 0 || blockDrag || !view?.editable || view.state.selection !== selection) return
    blockDrag = { pointer: event.pointerId, selection, startX: event.clientX, startY: event.clientY, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const locateBlockDrop = (event: PointerEvent, selection: NodeSelection) => {
    const view = handle?.editor.view
    const bounds = scrollRoot.getBoundingClientRect()
    if (view?.editable && view.state.selection === selection &&
      event.clientX >= bounds.left && event.clientX <= bounds.right &&
      event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
      return blockDropTarget(view, selection, event.clientY)
    }
  }

  const previewBlockDrop = (event: PointerEvent) => {
    const drag = blockDrag
    if (!drag || event.pointerId !== drag.pointer) return
    if (!drag.moved) {
      if (!reachesDragThreshold(event.clientX - drag.startX, event.clientY - drag.startY, event.pointerType)) return
      drag.moved = true
      closeMenu()
      closeSelectionMenu()
    }
    setBlockDrop(locateBlockDrop(event, drag.selection))
    cancelAnimationFrame(blockScrollFrame)
    const bounds = scrollRoot.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right) return
    const nearTop = event.clientY - bounds.top
    const nearBottom = bounds.bottom - event.clientY
    const scroll = nearTop >= 0 && nearTop < 30 ? -12 : nearBottom >= 0 && nearBottom < 30 ? 12 : 0
    if (scroll) blockScrollFrame = requestAnimationFrame(() => {
      const before = scrollRoot.scrollTop
      scrollRoot.scrollTop += scroll
      if (scrollRoot.scrollTop !== before) previewBlockDrop(event)
    })
  }

  const finishBlockDrag = (event: PointerEvent) => {
    const drag = blockDrag
    if (!drag || event.pointerId !== drag.pointer) return
    if (drag.moved) gripDragRelease = event
    const target = drag.moved ? locateBlockDrop(event, drag.selection) : undefined
    endBlockDrag()
    if (target && handle) moveBlock(handle.editor.view, drag.selection, target.pos)
    positionBlockGrip()
  }

  const showMenu = (next: Omit<Popup, 'selection'>) => {
    const editor = handle?.editor
    if (!editor) return
    closeSelectionMenu()
    if (!next.trigger || popup()?.trigger?.query !== next.trigger.query) {
      setChartChoice(undefined)
      setKeyboardHighlight(true)
      setHighlighted(0)
    }
    setPopup({ ...next, selection: editor.state.selection })
    if (!next.trigger) {
      const heading = items().find((option) => option.current)
      if (heading) setHighlighted(heading.index)
    }
  }

  const runItem = (index: number, submenu = false) => {
    const current = popup()
    const item = submenu ? charts()[index] : items()[index]?.item
    const editor = handle?.editor
    if (!current || !item || !editor?.isEditable || current.selection.$from.doc !== editor.state.doc) return
    if ('children' in item) {
      setHighlighted(index)
      setChartChoice((choice) => choice === undefined ? 0 : undefined)
      return
    }
    if ('mark' in item) {
      editor.chain().command(({ tr }) => {
        closeHistory(tr)
        tr.setSelection(current.selection)
        tr.setMeta(contextMenuFormat, true)
        return true
      }).toggleMark(item.mark).run()
      return
    }
    closeMenu()
    if ('ai' in item) {
      if (item.ai === 'quote') props.onQuoteSelection?.(current.quoteRange)
      else if (current.quoteRange) startInlineEdit(current.quoteRange)
      return
    }
    if ('attachment' in item) {
      const { from, to } = current.selection
      props.onInsertAttachment?.(item.attachment, current.trigger ?? { from, to })
      return
    }
    let chain = editor.chain().focus().command(({ tr }) => {
      closeHistory(tr)
      tr.setSelection(current.selection)
      return true
    })
    if (current.trigger) chain = chain.deleteRange(current.trigger)
    item.run(chain).run()
  }

  onMount(() => {
    const document = scrollRoot.ownerDocument
    menuPress = trackMenuPress(document, (menu) => {
      if (menu === popupElement) closeMenu()
      else resetSelectionMenu()
    })
    handle = createEditor({
      element,
      scrollRoot,
      markdown: props.markdown,
      onUpdate: props.onUpdate,
      readImage: props.readImage,
      imageContext: props.imageContext,
      openResource: props.openResource,
      handlePaste(view, event) {
        if (!props.onInsertFiles || !view.editable || !event.clipboardData) return false
        const files = Array.from(event.clipboardData.files)
        if (!files.length) {
          for (const item of event.clipboardData.items ?? []) {
            if (item.kind !== 'file') continue
            const file = item.getAsFile()
            if (file) files.push(file)
          }
        }
        if (!files.length) return false
        const { from, to } = view.state.selection
        props.onInsertFiles(files, { from, to })
        return true
      },
      handleDrop(view, event, _slice, moved) {
        const files = Array.from(event.dataTransfer?.files ?? [])
        if (!props.onInsertFiles || !view.editable || moved || !files.length) return false
        const point = view.posAtCoords({ left: event.clientX, top: event.clientY })
        if (point) view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(point.pos))))
        props.onInsertFiles(files)
        return true
      },
      handleTextInput(view, from, _to, text, insert) {
        if (text !== '/' || view.composing) return false
        view.dispatch(insert().setMeta(typedSlash, from))
        return true
      },
      handleKeyDown(view, event) {
        if (!view.editable || view.composing || event.isComposing) return false
        if (event.key === 'Escape' && selectionMenu()) {
          closeSelectionMenu()
          return true
        }
        if ((event.metaKey || event.ctrlKey) && event.key === '/') {
          const { selection } = view.state
          const { left, bottom, top } = view.coordsAtPos(selection.head)
          showMenu({
            x: left, y: bottom + 4, above: top - 4, inTable: handle!.editor.isActive('table'),
          })
          return true
        }
        if (!popup()) return false
        const chart = chartChoice()
        if (chart !== undefined) {
          switch (event.key) {
            case 'Escape':
            case 'ArrowLeft':
              setChartChoice(undefined)
              return true
            case 'ArrowDown':
            case 'ArrowUp': {
              const count = charts().length
              setChartChoice((chart + (event.key === 'ArrowDown' ? 1 : count - 1)) % count)
              return true
            }
            case 'Enter':
              runItem(chart, true)
              return true
          }
        }
        const count = items().length
        switch (event.key) {
          case 'Escape':
            closeMenu()
            return true
          case 'ArrowDown':
          case 'ArrowUp':
            if (!count) return false
            setKeyboardHighlight(true)
            setHighlighted((index) => (index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count)
            return true
          case 'ArrowLeft':
          case 'ArrowRight': {
            const current = items()[highlighted()]?.item
            if (current && 'children' in current && event.key === 'ArrowRight') {
              if (chartChoice() === undefined) runItem(highlighted())
              return true
            }
            if (!current || !('mark' in current)) return false
            const next = highlighted() + (event.key === 'ArrowLeft' ? -1 : 1)
            const target = items()[next]?.item
            if (target && 'mark' in target) {
              setKeyboardHighlight(true)
              setHighlighted(next)
            }
            return true
          }
          case 'Enter':
            if (!count) return false
            runItem(highlighted())
            return true
          default:
            return false
        }
      },
      handleContextMenu(view, event) {
        if (!view.editable || view.composing || !handle) return false
        const point = view.posAtCoords({ left: event.clientX, top: event.clientY })
        if (!point) return false
        const { selection, doc } = view.state
        if (selection.empty || point.pos < selection.from || point.pos > selection.to) {
          view.dispatch(view.state.tr.setSelection(Selection.near(doc.resolve(point.pos))))
        }
        if (!view.hasFocus()) view.focus()
        event.preventDefault()
        const selected = view.state.selection
        showMenu({
          x: event.clientX, y: event.clientY, above: event.clientY, inTable: handle.editor.isActive('table'),
          quoteRange: selected.empty ? undefined : { from: selected.from, to: selected.to },
        })
        return true
      },
    })

    const { editor } = handle
    editor.on('transaction', ({ transaction }) => {
      const current = popup()
      if (!transaction.docChanged && !transaction.selectionSet) return
      const menu = selectionMenu()
      const selection = editor.state.selection
      const selected = menu?.selection ?? selectionRects?.selection
      const selectionInUse = menuPress.active(selectionElement) || selectionElement?.contains(document.activeElement)
      if (!(selection instanceof TextSelection)) {
        resetSelectionMenu()
      } else if (transaction.docChanged && menu && transaction.getMeta(selectionToolbarFormat) && !selection.empty) {
        selectionRects = undefined
        setSelectionMenu({ ...menu, selection })
      } else if (transaction.docChanged || (selected && !selected.eq(selection) && !selectionInUse)) {
        resetSelectionMenu()
      }
      if (blockDrag) endBlockDrag()
      positionBlockGrip()
      if (current && transaction.getMeta(contextMenuFormat)) {
        setPopup({ ...current, selection })
        return
      }
      if (current && menuPress.active(popupElement)) {
        if (transaction.docChanged) closeMenu()
        return
      }
      if (current && !current.trigger) {
        if (transaction.docChanged || !current.selection.eq(editor.state.selection)) closeMenu()
        return
      }
      const typedAt = transaction.getMeta(typedSlash)
      if (!current && typedAt === undefined) return
      const trigger = editor.isEditable && editor.isFocused && !editor.view.composing ? slashTrigger(editor.state) : null
      const previous = current?.trigger && transaction.mapping.mapResult(current.trigger.from, 1)
      const continues = previous && !previous.deleted && trigger?.from === previous.pos &&
        (transaction.docChanged || current?.selection.eq(selection))
      if (!trigger || (trigger.from !== typedAt && !continues)) {
        closeMenu()
        return
      }
      const { left, bottom, top } = editor.view.coordsAtPos(trigger.from)
      showMenu({ x: left, y: bottom + 4, above: top - 4, trigger, inTable: editor.isActive('table') })
    })

    const closeOutside = (event: PointerEvent) => {
      if (event.defaultPrevented) return
      cancelAnimationFrame(selectionFrame)
      const path = event.composedPath()
      const inPopup = popup() && popupElement && path.includes(popupElement)
      const inSelection = selectionMenu() && selectionElement && path.includes(selectionElement)
      if (popup() && !inPopup) closeMenu()
      if (selectionMenu() && !inSelection) closeSelectionMenu()
      menuPress.start(event, inPopup ? popupElement : inSelection ? selectionElement : undefined)
    }
    const closeOnBlur = () => {
      if (popup()) closeMenu()
      resetSelectionMenu()
    }
    const updateLayout = () => {
      // Keep the button mounted through the native click, even if scrolling or resizing occurs during the press.
      selectionRects = undefined
      if (!menuPress.active(selectionElement) && !selectionElement?.contains(document.activeElement)) closeSelectionMenu()
      positionBlockGrip()
    }
    const closeOnScroll = () => {
      cancelAnimationFrame(selectionFrame)
      if (popup() && !menuPress.active(popupElement)) closeMenu()
      updateLayout()
    }
    const layout = new ResizeObserver(updateLayout)
    layout.observe(scrollRoot, { box: 'border-box' })
    document.addEventListener('pointerdown', closeOutside, true)
    scrollRoot.addEventListener('scroll', closeOnScroll, true)
    window.addEventListener('resize', closeOnScroll)
    window.addEventListener('blur', closeOnBlur)
    onCleanup(() => {
      document.removeEventListener('pointerdown', closeOutside, true)
      menuPress.destroy()
      scrollRoot.removeEventListener('scroll', closeOnScroll, true)
      window.removeEventListener('resize', closeOnScroll)
      window.removeEventListener('blur', closeOnBlur)
      layout.disconnect()
      cancelAnimationFrame(selectionFrame)
      endBlockDrag()
    })
    props.onReady(handle)
  })
  onCleanup(() => {
    if (!handle) return
    props.onDispose?.(handle)
    handle.destroy()
  })

  createEffect(() => {
    props.imageContext?.()
    props.inlineAi
    closeInlineEdit(false)
    if (blockDrag) endBlockDrag()
    setBlockGrip(undefined)
    resetSelectionMenu()
  })

  createEffect(() => {
    const current = popup()
    const active = items()[highlighted()]
    const chart = chartChoice()
    const dom = handle?.editor.view.dom
    if (!dom) return
    if (current) dom.setAttribute('aria-controls', chart === undefined ? menuId : `${menuId}-charts`)
    else dom.removeAttribute('aria-controls')
    if (chart !== undefined) dom.setAttribute('aria-activedescendant', `${menuId}-charts-${chart}`)
    else if (active) dom.setAttribute('aria-activedescendant', `${menuId}-${highlighted()}`)
    else dom.removeAttribute('aria-activedescendant')
  })

  return (
    <div class="editor-shell">
      <div class="editor-scroll" ref={scrollRoot}
        onPointerMove={props.showSelectionToolbar ? hoverSelection : undefined}
        onPointerUp={props.showSelectionToolbar ? hoverAfterSelection : undefined}>
        <div class="editor-mount" ref={element} />
      </div>
      <Show when={blockGrip()}>
        {(grip) => <Portal>
          <button type="button" class="editor-block-grip" title="拖动以移动区块"
            aria-label="拖动以移动区块" style={{ left: `${grip().x}px`, top: `${grip().y}px` }}
            onPointerDown={(event) => startBlockDrag(event, grip().selection)}
            onMouseDown={(event) => { if (event.button === 0) event.preventDefault() }}
            onPointerMove={previewBlockDrop} onPointerUp={finishBlockDrag}
            onPointerCancel={endBlockDrag}
            onLostPointerCapture={() => { if (blockDrag) endBlockDrag() }}
            onClick={(event) => {
              if (gripDragRelease && isClickFromRelease(event, gripDragRelease)) return
              const editor = handle?.editor
              const { selection, x, y } = grip()
              if (!editor?.isEditable || editor.state.selection !== selection) return
              editor.view.focus()
              showMenu({
                x: x + 26, y: y + 28, above: y - 4, inTable: editor.isActive('table'),
                quoteRange: { from: selection.from, to: selection.to },
              })
            }}>
            <span aria-hidden="true" />
          </button>
        </Portal>}
      </Show>
      <Show when={blockDrop()}>
        {(target) => <Portal>
          <div class="editor-block-drop" aria-hidden="true"
            style={{ left: `${target().x}px`, top: `${target().y}px`, width: `${target().width}px` }} />
        </Portal>}
      </Show>
      <Show when={selectionMenu()}>
        {(current) => (
          <Portal>
            <SelectionToolbar {...current()} editor={handle!.editor} onClose={closeSelectionMenu}
              ref={(element) => { selectionElement = element }}
              onAiEdit={props.inlineAi ? () => {
                const { from, to } = current().selection
                return startInlineEdit({ from, to })
              } : undefined} />
          </Portal>
        )}
      </Show>
      <Show when={inlineEdit()} keyed>
        {(edit) => <Portal><InlineAiEditor editor={handle!.editor} reference={edit}
          scrollRoot={scrollRoot} close={closeInlineEdit} /></Portal>}
      </Show>
      <Show when={popup()}>
        {(current) => (
          <Portal><BlockMenu
            id={menuId}
            anchor={current()}
            query={current().trigger?.query}
            groups={groups()}
            active={highlighted()}
            submenu={chartChoice() === undefined ? undefined : { items: charts(), active: chartChoice()! }}
            keyboardHighlight={keyboardHighlight()}
            isPressing={() => menuPress.active(popupElement)}
            onHighlight={(index) => { setKeyboardHighlight(false); setHighlighted(index) }}
            onChoose={(index) => runItem(index)}
            onChooseSubmenu={(index) => runItem(index, true)}
            onHighlightSubmenu={setChartChoice}
            ref={(el) => { popupElement = el }}
          /></Portal>
        )}
      </Show>
    </div>
  )
}
