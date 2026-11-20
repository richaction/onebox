import type { Range } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { Node } from '@tiptap/pm/model'
import { Selection } from '@tiptap/pm/state'
import { createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount, Show } from 'solid-js'
import {
  blockCommands, blockEditCommands, insertCommands, selectedBlock, slashTrigger, tableCommands,
  type CommandItem, type MenuItem,
} from '../core/blockCommands'
import { createEditor, type EditorHandle } from '../core/editor'
import BlockMenu from './BlockMenu'

export type AttachmentKind = 'image' | 'file'

interface Popup {
  x: number
  y: number
  above: number
  trigger?: NonNullable<ReturnType<typeof slashTrigger>>
  inTable: boolean
  canEditBlock?: boolean
}

type Action = CommandItem | (MenuItem & { attachment: AttachmentKind })

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
  onUpdate: (doc: Node) => void
  onInsertAttachment?: (kind: AttachmentKind, range?: Range) => void
  onInsertFiles?: (files: File[]) => void
  readImage?: (href: string) => Promise<Blob | undefined>
  imageContext?: () => string | null
  openResource?: (href: string) => void
}) {
  let scrollRoot!: HTMLDivElement
  let element!: HTMLDivElement
  let popupElement: HTMLDivElement | undefined
  let handle: EditorHandle | undefined
  let dismissedSlash: number | undefined

  const [popup, setPopup] = createSignal<Popup>()
  const [highlighted, setHighlighted] = createSignal(0)
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
    setPopup(undefined)
  }

  const showMenu = (next: Popup) => {
    if (!next.trigger || popup()?.trigger?.query !== next.trigger.query) setHighlighted(0)
    setPopup(next)
  }

  const runItem = (index: number) => {
    const current = popup()
    const item = items()[index]?.item
    const editor = handle?.editor
    if (!current || !item || !editor?.isEditable) return
    closeMenu()
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
        view.focus()
        event.preventDefault()
        showMenu({
          x: event.clientX, y: event.clientY, above: event.clientY, inTable: handle.editor.isActive('table'),
          canEditBlock: !!selectedBlock(view.state.selection),
        })
        return true
      },
    })

    const { editor } = handle
    editor.on('transaction', ({ transaction }) => {
      const current = popup()
      if (!transaction.docChanged && !transaction.selectionSet) return
      if (current && !current.trigger) {
        closeMenu()
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
      if (popup() && !popupElement?.contains(event.target as globalThis.Node)) closeMenu()
    }
    const closeOnScroll = () => { if (popup()) closeMenu() }
    document.addEventListener('pointerdown', closeOutside)
    scrollRoot.addEventListener('scroll', closeOnScroll)
    onCleanup(() => {
      document.removeEventListener('pointerdown', closeOutside)
      scrollRoot.removeEventListener('scroll', closeOnScroll)
    })
    props.onReady(handle)
  })
  onCleanup(() => {
    if (!handle) return
    props.onDispose?.(handle)
    handle.destroy()
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
      <div class="editor-scroll" ref={scrollRoot}>
        <div class="editor-mount" ref={element} />
      </div>
      <Show when={popup()}>
        {(current) => (
          <BlockMenu
            id={menuId}
            anchor={current()}
            query={current().trigger?.query}
            items={items()}
            active={highlighted()}
            onHighlight={setHighlighted}
            onChoose={runItem}
            onClose={closeMenu}
            ref={(el) => { popupElement = el }}
          />
        )}
      </Show>
    </div>
  )
}
