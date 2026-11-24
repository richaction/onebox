import type { Range } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { Node as DocumentNode } from '@tiptap/pm/model'
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state'
import { createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount, Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { captureAiReference, highlightAiSource, type AiReference } from '../core/aiDocument'
import {
  blockCommands, blockEditCommands, insertCommands, selectedBlock, slashTrigger, tableCommands,
  type CommandItem, type MenuItem,
} from '../core/blockCommands'
import { blockDropTarget, moveBlock } from '../core/blockMove'
import { reachesDragThreshold } from '../core/buttonClickTolerance'
import { createEditor, type EditorHandle } from '../core/editor'
import { ListRowsSelection, listTextSelectionRects } from '../core/listSelection'
import { trackMenuPress } from '../core/menuPress'
import BlockMenu from './BlockMenu'
import InlineAiEditor, { type OpeningClick } from './InlineAiEditor'
import SelectionToolbar, { selectionToolbarFormat, selectionToolbarHeight, selectionToolbarWidth } from './SelectionToolbar'

export type AttachmentKind = 'image' | 'file'

interface Popup {
  x: number
  y: number
  above: number
  trigger?: NonNullable<ReturnType<typeof slashTrigger>>
  inTable: boolean
  canEditBlock?: boolean
  quoteRange?: Range
  selection: Selection
}

type GripDrag = { pointer: number; selection: NodeSelection; startX: number; startY: number; moved: boolean }

type Action = CommandItem | (MenuItem & { attachment: AttachmentKind }) | (MenuItem & { quote: true })

const quoteAction: Action = { label: '引用到 AI', search: 'AI 引用', icon: '✦', quote: true }

const attachmentItems: readonly Action[] = [
  {
    label: '图片', search: 'image photo', icon: '▧',
    preview: { kind: 'media', caption: '插入本地图片' }, attachment: 'image',
  },
  {
    label: '附件', search: 'attachment file', icon: '▤',
    preview: { kind: 'media', caption: '插入本地文件链接' }, attachment: 'file',
  },
]

export default function EditorShell(props: {
  markdown: string
  onReady: (handle: EditorHandle) => void
  onDispose?: (handle: EditorHandle) => void
  onUpdate: (doc: DocumentNode) => void
  onInsertAttachment?: (kind: AttachmentKind, range?: Range) => void
  onInsertFiles?: (files: File[]) => void
  onQuoteSelection?: (range?: Range) => void
  inlineAi?: boolean
  readImage?: (href: string) => Promise<Blob | undefined>
  imageContext?: () => string | null
  openResource?: (href: string) => void
}) {
  let scrollRoot!: HTMLDivElement
  let element!: HTMLDivElement
  let popupElement: HTMLDivElement | undefined
  let selectionElement: HTMLDivElement | undefined
  let handle: EditorHandle | undefined
  let dismissedSlash: number | undefined
  let selectionRects: { selection: Selection; rects: DOMRect[] } | undefined
  let selectionFrame = 0
  let menuPress: ReturnType<typeof trackMenuPress>
  let blockDrag: GripDrag | undefined
  let blockScrollFrame = 0
  let suppressGripClick = false

  const [popup, setPopup] = createSignal<Popup>()
  const [selectionMenu, setSelectionMenu] = createSignal<{
    x: number; y: number; above: boolean; width: number; maxHeight: number; selection: Selection
  }>()
  const [inlineEdit, setInlineEdit] = createSignal<{ reference: AiReference & { anchor: number }; openingClick?: OpeningClick }>()
  const [blockGrip, setBlockGrip] = createSignal<{ x: number; y: number; selection: NodeSelection }>()
  const [blockDrop, setBlockDrop] = createSignal<ReturnType<typeof blockDropTarget>>()
  const [highlighted, setHighlighted] = createSignal(0)
  const [keyboardHighlight, setKeyboardHighlight] = createSignal(true)
  const menuId = createUniqueId()
  const items = createMemo(() => {
    const current = popup()
    if (!current) return []
    const sections: [string, readonly Action[]][] = current.inTable
      ? [['表格操作', tableCommands]]
      : [
        ['区块操作', current.canEditBlock ? blockEditCommands : []],
        [current.trigger ? '基本区块' : '转换区块', blockCommands],
        ['插入内容', insertCommands],
        ['媒体与附件', props.onInsertAttachment ? attachmentItems : []],
      ]
    if (current.quoteRange && props.onQuoteSelection) sections.unshift(['AI', [quoteAction]])
    const query = current.trigger?.query.toLowerCase() ?? ''
    return sections.flatMap(([section, commands]) => {
      const matches = commands.filter((item) =>
        `${item.label} ${item.search} ${item.shortcut ?? ''}`.toLowerCase().includes(query))
      const exact = matches.findIndex((item) => item.shortcut === query)
      if (exact > 0) matches.unshift(...matches.splice(exact, 1))
      return matches.map((item, index) => ({ item, section: index === 0 ? section : undefined }))
    })
  })

  const closeMenu = () => {
    dismissedSlash = popup()?.trigger?.from
    if (menuPress.active(popupElement)) menuPress.clear()
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

  const startInlineEdit = (range: Range, event: MouseEvent) => {
    const editor = handle?.editor
    if (!props.inlineAi || !editor?.isEditable || inlineEdit()) return false
    const reference = captureAiReference(editor, 'selection', '', range)
    if (!reference || reference.anchor === undefined) return false
    closeSelectionMenu()
    highlightAiSource(editor, reference.anchor)
    const { clientX, clientY, timeStamp } = event
    setInlineEdit({ reference: { ...reference, anchor: reference.anchor },
      openingClick: event.detail > 0 ? { clientX, clientY, timeStamp } : undefined })
    return true
  }

  const showSelectionMenu = (x: number, y: number, afterSelection = false) => {
    const view = handle?.editor.view
    if (!view?.editable || !view.hasFocus() || view.composing || inlineEdit() || popup()) return
    const { selection } = view.state
    if (!(selection instanceof TextSelection || selection instanceof ListRowsSelection ||
      (selection instanceof NodeSelection && selection.node.isBlock)) || selection.empty) return
    if (selectionMenu()?.selection.eq(selection)) return
    if (!selectionRects?.selection.eq(selection)) {
      const native = window.getSelection()
      if (selection instanceof TextSelection) {
        if (!native?.rangeCount || native.isCollapsed || !view.dom.contains(native.anchorNode) ||
          !view.dom.contains(native.focusNode)) return
        selectionRects = { selection, rects: listTextSelectionRects(view) ?? Array.from(native.getRangeAt(0).getClientRects()) }
      } else {
        const first = view.nodeDOM(selection.from)
        const last = selection instanceof ListRowsSelection ? view.nodeDOM(selection.last.pos) : first
        if (!(first instanceof HTMLElement) || !(last instanceof HTMLElement)) return
        const start = first.getBoundingClientRect()
        const end = last.getBoundingClientRect()
        selectionRects = { selection, rects: [new DOMRect(start.left, start.top, start.width, end.bottom - start.top)] }
      }
    }
    const rects = selectionRects.rects.filter((rect) => rect.width > 0)
    if (!rects.length) return
    if (!afterSelection && !rects.some((rect) => x >= rect.left && x <= rect.right &&
      y >= rect.top && y <= rect.bottom)) return
    const bounds = scrollRoot.getBoundingClientRect()
    let topEdge = rects[0].top
    let bottomEdge = rects[0].bottom
    for (const rect of rects) {
      topEdge = Math.min(topEdge, rect.top)
      bottomEdge = Math.max(bottomEdge, rect.bottom)
    }
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
    suppressGripClick = !!blockDrag?.moved
    blockDrag = undefined
    setBlockDrop(undefined)
  }

  const startBlockDrag = (event: PointerEvent & { currentTarget: HTMLButtonElement }, selection: NodeSelection) => {
    const view = handle?.editor.view
    if (event.button !== 0 || blockDrag || !view?.editable || view.state.selection !== selection) return
    suppressGripClick = false
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
      setKeyboardHighlight(true)
      setHighlighted(0)
    }
    setPopup({ ...next, selection: editor.state.selection })
  }

  const runItem = (index: number) => {
    const current = popup()
    const item = items()[index]?.item
    const editor = handle?.editor
    if (!current || !item || !editor?.isEditable || current.selection.$from.doc !== editor.state.doc) return
    closeMenu()
    if ('quote' in item) { props.onQuoteSelection?.(current.quoteRange); return }
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
        const files = Array.from(event.clipboardData?.files ?? [])
        if (!props.onInsertFiles || !view.editable || !files.length) return false
        props.onInsertFiles(files)
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
            canEditBlock: !!selectedBlock(selection),
          })
          return true
        }
        if (!popup()) return false
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
          canEditBlock: !!selectedBlock(view.state.selection),
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
      if (transaction.docChanged && menu && transaction.getMeta(selectionToolbarFormat) && !selection.empty) {
        selectionRects = undefined
        setSelectionMenu({ ...menu, selection })
      } else if (transaction.docChanged || (selected && !selected.eq(selection) && !selectionInUse)) {
        resetSelectionMenu()
      }
      if (blockDrag) endBlockDrag()
      positionBlockGrip()
      if (current && menuPress.active(popupElement)) {
        if (transaction.docChanged) closeMenu()
        return
      }
      if (current && !current.trigger) {
        if (transaction.docChanged || !current.selection.eq(editor.state.selection)) closeMenu()
        return
      }
      const trigger = editor.isEditable && editor.isFocused && !editor.view.composing
        ? slashTrigger(editor.state)
        : null
      if (!trigger) {
        dismissedSlash = undefined
        setPopup(undefined)
      } else if (trigger.from !== dismissedSlash) {
        const { left, bottom, top } = editor.view.coordsAtPos(trigger.from)
        showMenu({ x: left, y: bottom + 4, above: top - 4, trigger, inTable: editor.isActive('table') })
      }
    })

    const closeOutside = (event: PointerEvent) => {
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
    const dom = handle?.editor.view.dom
    if (!dom) return
    if (current) dom.setAttribute('aria-controls', menuId)
    else dom.removeAttribute('aria-controls')
    if (active) dom.setAttribute('aria-activedescendant', `${menuId}-${highlighted()}`)
    else dom.removeAttribute('aria-activedescendant')
  })

  return (
    <div class="editor-shell">
      <div class="editor-scroll" ref={scrollRoot} onPointerMove={hoverSelection} onPointerUp={hoverAfterSelection}>
        <div class="editor-mount" ref={element} />
      </div>
      <Show when={blockGrip()}>
        {(grip) => <Portal>
          <button type="button" class="editor-block-grip" title="拖动以移动区块"
            aria-label="区块操作，拖动以移动" style={{ left: `${grip().x}px`, top: `${grip().y}px` }}
            onPointerDown={(event) => startBlockDrag(event, grip().selection)}
            onMouseDown={(event) => { if (event.button === 0) event.preventDefault() }}
            onPointerMove={previewBlockDrop} onPointerUp={finishBlockDrag}
            onPointerCancel={endBlockDrag}
            onLostPointerCapture={() => { if (blockDrag) endBlockDrag() }}
            onClick={(event) => {
              if (suppressGripClick && event.detail !== 0) return
              const editor = handle?.editor
              const { selection, x, y } = grip()
              if (!editor?.isEditable || editor.state.selection !== selection) return
              editor.view.focus()
              showMenu({
                x: x + 26, y: y + 28, above: y - 4, inTable: editor.isActive('table'), canEditBlock: true,
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
              onAiEdit={props.inlineAi ? (event) => {
                const { from, to } = current().selection
                return startInlineEdit({ from, to }, event)
              } : undefined} />
          </Portal>
        )}
      </Show>
      <Show when={inlineEdit()} keyed>
        {(edit) => <Portal><InlineAiEditor editor={handle!.editor} reference={edit.reference} openingClick={edit.openingClick}
          scrollRoot={scrollRoot} close={closeInlineEdit} /></Portal>}
      </Show>
      <Show when={popup()}>
        {(current) => (
          <Portal><BlockMenu
            id={menuId}
            anchor={current()}
            query={current().trigger?.query}
            items={items()}
            active={highlighted()}
            keyboardHighlight={keyboardHighlight()}
            isPressing={() => menuPress.active(popupElement)}
            onHighlight={(index) => { setKeyboardHighlight(false); setHighlighted(index) }}
            onChoose={runItem}
            onClose={closeMenu}
            ref={(el) => { popupElement = el }}
          /></Portal>
        )}
      </Show>
    </div>
  )
}
