import type { Range } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { Node } from '@tiptap/pm/model'
import { Selection } from '@tiptap/pm/state'
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { blockCommands, slashTrigger, tableCommands, type CommandItem } from '../core/blockCommands'
import { createEditor, type EditorHandle } from '../core/editor'

export type AttachmentKind = 'image' | 'file'

interface Popup {
  x: number
  y: number
  trigger?: NonNullable<ReturnType<typeof slashTrigger>>
  inTable: boolean
}

export default function EditorShell(props: {
  markdown: string
  onReady: (handle: EditorHandle) => void
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
  const items = createMemo(() => {
    const current = popup()
    if (!current) return []
    const commands: (CommandItem | { label: string; search: string; attachment: AttachmentKind })[] =
      current.inTable ? [...tableCommands] : [...blockCommands]
    if (props.onInsertAttachment && !current.inTable) {
      commands.push(
        { label: '图片', search: 'image photo', attachment: 'image' },
        { label: '附件', search: 'attachment file', attachment: 'file' },
      )
    }
    const query = current.trigger?.query.toLowerCase() ?? ''
    return commands.filter((item) => `${item.label} ${item.search}`.includes(query))
  })

  const closeMenu = () => {
    dismissedSlash = popup()?.trigger?.from
    setPopup(undefined)
  }

  const showMenu = (next: Popup) => {
    if (popup()?.trigger?.query !== next.trigger?.query || !popup()) setHighlighted(0)
    setPopup(next)
  }

  const runItem = (index: number) => {
    const current = popup()
    const item = items()[index]
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
        if (!popup() || !view.editable || view.composing || event.isComposing) return false
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
        showMenu({ x: event.clientX, y: event.clientY, inTable: handle.editor.isActive('table') })
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
        const { left, bottom } = editor.view.coordsAtPos(trigger.to)
        showMenu({ x: left, y: bottom + 4, trigger, inTable: editor.isActive('table') })
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
  onCleanup(() => handle?.destroy())

  return (
    <div class="editor-shell">
      <div class="editor-scroll" ref={scrollRoot}>
        <div class="editor-mount" ref={element} />
      </div>
      <Show when={popup()}>
        <div
          class="block-menu"
          ref={popupElement}
          role="menu"
          aria-label="块操作"
          style={{
            left: `${Math.max(8, Math.min(popup()!.x, window.innerWidth - 210))}px`,
            top: `${Math.max(8, Math.min(popup()!.y, window.innerHeight - 260))}px`,
          }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <For each={items()} fallback={<span class="block-menu-empty">无匹配命令</span>}>
            {(item, index) => (
              <button
                type="button"
                role="menuitem"
                classList={{ highlighted: index() === highlighted() }}
                onMouseEnter={() => setHighlighted(index())}
                onClick={() => runItem(index())}
              >{item.label}</button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
