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
import { createEditor, type EditorHandle } from '../core/editor'
import { ListRowsSelection, listTextSelectionRects } from '../core/listSelection'
import BlockMenu from './BlockMenu'
import InlineAiEditor from './InlineAiEditor'

export type AttachmentKind = 'image' | 'file'

interface Popup {
  x: number
  y: number
  above: number
  trigger?: NonNullable<ReturnType<typeof slashTrigger>>
  inTable: boolean
  canEditBlock?: boolean
  quoteRange?: Range
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
  let handle: EditorHandle | undefined
  let dismissedSlash: number | undefined
  let selectionRects: { selection: Selection; rects: DOMRect[] } | undefined
  let selectionFrame = 0
  let menuPress: { pointer: number; menu: 'block' | 'selection' } | undefined
  let blockDrag: GripDrag | undefined
  let blockScrollFrame = 0
  let suppressGripClick = false

  const [popup, setPopup] = createSignal<Popup>()
  const [selectionMenu, setSelectionMenu] = createSignal<{ x: number; y: number; selection: Selection }>()
  const [inlineEdit, setInlineEdit] = createSignal<AiReference & { anchor: number }>()
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
    if (menuPress?.menu === 'block') menuPress = undefined
    setPopup(undefined)
  }

  const closeSelectionMenu = () => {
    if (menuPress?.menu === 'selection') menuPress = undefined
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
    if (!props.inlineAi || !editor?.isEditable || inlineEdit()) return
    const reference = captureAiReference(editor, 'selection', '', range)
    if (!reference || reference.anchor === undefined) return
    closeSelectionMenu()
    highlightAiSource(editor, reference.anchor)
    setInlineEdit({ ...reference, anchor: reference.anchor })
  }

  const showSelectionMenu = (x: number, y: number, afterRelease = false) => {
    const view = handle?.editor.view
    if (!view?.editable || !view.hasFocus() || view.composing || !props.inlineAi || inlineEdit() || popup()) return
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
    if (!rects.length || (!afterRelease && !rects.some((rect) =>
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom))) return
    const bounds = scrollRoot.getBoundingClientRect()
    let topEdge = rects[0].top
    let bottomEdge = rects[0].bottom
    for (const rect of rects) {
      topEdge = Math.min(topEdge, rect.top)
      bottomEdge = Math.max(bottomEdge, rect.bottom)
    }
    const above = topEdge - 38
    const below = bottomEdge + 4
    const nearEnd = Math.abs(y - bottomEdge) <= Math.abs(y - topEdge)
    const canOpenAbove = above >= bounds.top + 4
    const canOpenBelow = below + 32 <= bounds.bottom - 4
    const top = canOpenBelow && (nearEnd || !canOpenAbove) ? below
      : canOpenAbove ? above : Math.max(bounds.top + 4, Math.min(y + 8, bounds.bottom - 36))
    setSelectionMenu({
      x: Math.max(bounds.left + 4, Math.min(x - 64, bounds.right - 132)),
      y: top,
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
    // Mouseup and the editor's native selection sync complete after pointerup.
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
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return
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

  const showMenu = (next: Popup) => {
    closeSelectionMenu()
    if (!next.trigger || popup()?.trigger?.query !== next.trigger.query) {
      setKeyboardHighlight(true)
      setHighlighted(0)
    }
    setPopup(next)
  }

  const runItem = (index: number) => {
    const current = popup()
    const item = items()[index]?.item
    const editor = handle?.editor
    if (!current || !item || !editor?.isEditable) return
    closeMenu()
    if ('quote' in item) { props.onQuoteSelection?.(current.quoteRange); return }
    if ('attachment' in item) {
      props.onInsertAttachment?.(item.attachment, current.trigger)
      return
    }
    let chain = editor.chain().focus().command(({ tr }) => {
      closeHistory(tr)
      return true
    })
    if (current.trigger) chain = chain.deleteRange(current.trigger)
    item.run(chain).run()
  }

  onMount(() => {
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
      const selected = selectionMenu()?.selection ?? selectionRects?.selection
      if (transaction.docChanged || (selected && !selected.eq(editor.state.selection))) resetSelectionMenu()
      if (blockDrag) endBlockDrag()
      positionBlockGrip()
      if (current && !current.trigger) {
        if (transaction.docChanged) closeMenu()
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

    const menuAt = (event: PointerEvent) => {
      const path = event.composedPath()
      if (popup() && popupElement && path.includes(popupElement)) return 'block'
      if (selectionMenu() && path.some((node) => node instanceof Element && node.matches('.editor-selection-menu'))) return 'selection'
    }
    const closeOutside = (event: PointerEvent) => {
      cancelAnimationFrame(selectionFrame)
      const menu = menuAt(event)
      if (popup() && menu !== 'block') closeMenu()
      if (selectionMenu() && menu !== 'selection') closeSelectionMenu()
      if (menu && event.button === 0) menuPress = { pointer: event.pointerId, menu }
    }
    const releaseMenu = (event: PointerEvent) => {
      if (event.pointerId !== menuPress?.pointer) return
      const { menu } = menuPress
      menuPress = undefined
      if (event.type === 'pointerup' && menuAt(event) === menu) return
      if (menu === 'block') closeMenu()
      else resetSelectionMenu()
    }
    const closeOnBlur = () => {
      if (popup()) closeMenu()
      resetSelectionMenu()
    }
    const updateLayout = () => {
      // Keep the button mounted through the native click, even if scrolling or resizing occurs during the press.
      selectionRects = undefined
      if (menuPress?.menu !== 'selection') closeSelectionMenu()
      positionBlockGrip()
    }
    const closeOnScroll = () => {
      cancelAnimationFrame(selectionFrame)
      if (popup() && menuPress?.menu !== 'block') closeMenu()
      updateLayout()
    }
    const layout = new ResizeObserver(updateLayout)
    layout.observe(scrollRoot)
    document.addEventListener('pointerdown', closeOutside, true)
    document.addEventListener('pointerup', releaseMenu, true)
    document.addEventListener('pointercancel', releaseMenu, true)
    scrollRoot.addEventListener('scroll', closeOnScroll, true)
    window.addEventListener('resize', closeOnScroll)
    window.addEventListener('blur', closeOnBlur)
    onCleanup(() => {
      document.removeEventListener('pointerdown', closeOutside, true)
      document.removeEventListener('pointerup', releaseMenu, true)
      document.removeEventListener('pointercancel', releaseMenu, true)
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
      <Show when={props.inlineAi && selectionMenu()} keyed>
        {(current) => (
          <Portal>
            <button type="button" class="editor-selection-menu" style={{ left: `${current.x}px`, top: `${current.y}px` }}
              onMouseDown={(event) => { if (event.button === 0) event.preventDefault() }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                closeSelectionMenu()
                handle?.editor.view.focus()
              }}
              onClick={() => {
                const view = handle?.editor.view
                closeSelectionMenu()
                if (!view?.editable || !view.state.selection.eq(current.selection)) return
                const { from, to } = current.selection
                startInlineEdit({ from, to })
              }}>
              <span aria-hidden="true">✨</span> 使用 AI 编辑
            </button>
          </Portal>
        )}
      </Show>
      <Show when={inlineEdit()} keyed>
        {(reference) => <Portal><InlineAiEditor editor={handle!.editor} reference={reference}
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
            isPressing={() => menuPress?.menu === 'block'}
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
