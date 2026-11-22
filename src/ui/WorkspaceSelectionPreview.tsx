import { convertFileSrc } from '@tauri-apps/api/core'
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { desktopWorkspace, type WorkspaceEntry } from '../io/tauri'
import { FilePreviewDialog } from './FilePreview'
import { isImagePreview } from './previewImage'
import type { WorkspaceSelection } from './WorkspaceSidebar'

function ItemPreview(props: {
  entry: WorkspaceEntry
  root?: string
  cut: boolean
  onRemove: () => void
  onOpen: (trigger: HTMLButtonElement) => void
}) {
  let thumbnail!: HTMLSpanElement
  const [source, setSource] = createSignal<string>()
  const image = () => isImagePreview(props.entry.name)
  const kind = () => {
    const dot = props.entry.name.lastIndexOf('.')
    const extension = dot > 0 ? props.entry.name.slice(dot + 1).toUpperCase() : ''
    return [extension, image() ? '图片' : '文件'].filter(Boolean).join(' ')
  }

  onMount(() => {
    if (!image()) return
    let disposed = false
    const load = () => {
      void desktopWorkspace.preparePreview(props.root, props.entry.path).then((path) => {
        if (typeof path === 'string' && !disposed) setSource(convertFileSrc(path))
      }).catch(() => { /* The file icon also covers unavailable thumbnails. */ })
    }
    const observer = typeof IntersectionObserver === 'undefined' ? undefined
      : new IntersectionObserver(([entry]) => {
        if (disposed || !entry?.isIntersecting) return
        observer?.disconnect()
        load()
      })
    if (observer) observer.observe(thumbnail)
    else load()
    onCleanup(() => {
      disposed = true
      observer?.disconnect()
    })
  })

  const remove = (button: HTMLButtonElement) => {
    const item = button.parentElement
    const next = item?.nextElementSibling ?? item?.previousElementSibling
    next?.querySelector('button')?.focus({ preventScroll: true })
    props.onRemove()
  }

  return (
    <li>
      <button type="button" class="selection-preview-item" classList={{ 'selection-preview-item-cut': props.cut }}
        title={props.entry.path} aria-haspopup="dialog"
        onPointerDown={(event) => {
          // macOS may turn Ctrl-click into a context menu instead of dispatching click.
          if (!event.ctrlKey || (event.button !== 0 && event.button !== 2)) return
          event.preventDefault()
          remove(event.currentTarget)
        }}
        onClick={(event) => {
          if (event.ctrlKey || event.metaKey) remove(event.currentTarget)
          else if (!event.shiftKey) props.onOpen(event.currentTarget)
        }}>
        <span class="selection-preview-thumbnail" ref={thumbnail} aria-hidden="true">
          <Show when={source()} fallback={
            <span class="workspace-entry-icon" classList={{ 'is-document': props.entry.markdown }} />
          }>
            {(url) => <img src={url()} alt="" decoding="async" onError={() => setSource(undefined)} />}
          </Show>
        </span>
        <span class="selection-preview-description">
          <strong>{props.entry.name}</strong>
          <small>{kind()}</small>
        </span>
      </button>
    </li>
  )
}

export default function WorkspaceSelectionPreview(props: {
  selection: WorkspaceSelection
  root?: string
  onFilePreviewOpenChange: (open: boolean) => void
  onOpenExternal: (entry: WorkspaceEntry, application?: string) => void
  onSaveHint: () => void
  saveHint: string
}) {
  const [preview, setPreview] = createSignal<{ path: string; trigger: HTMLButtonElement }>()
  const entries = () => props.selection.entries()
  const previewEntry = createMemo(() => entries().find(({ path }) => path === preview()?.path))
  createEffect(() => { if (preview() && !previewEntry()) setPreview(undefined) })
  createEffect(() => props.onFilePreviewOpenChange(!!previewEntry()))
  onCleanup(() => props.onFilePreviewOpenChange(false))
  return (
    <section class="file-preview selection-preview" aria-label="多选预览"
      onKeyDown={(event) => { if (!previewEntry()) props.selection.onKeyDown(event) }}>
      <header class="file-preview-toolbar selection-preview-toolbar" inert={!!previewEntry()}>
        <strong role="status">已选中 {entries().length} 个文件</strong>
        <div class="selection-preview-message" role="status">{props.selection.message()}</div>
        <div class="file-preview-actions" role="group" aria-label="选中项操作">
          <button type="button" disabled={!props.selection.canCopy()} onClick={() => props.selection.copy(true)}>剪切</button>
          <button type="button" disabled={!props.selection.canCopy()} onClick={() => props.selection.copy(false)}>复制</button>
        </div>
      </header>
      <div class="preview-surface selection-preview-surface" inert={!!previewEntry()}
        onContextMenu={(event) => { if (event.ctrlKey) event.preventDefault() }}>
        <ul class="selection-preview-items" aria-label="选中的项目">
          <For each={entries()}>{(entry) => (
            <ItemPreview entry={entry} root={props.root} cut={props.selection.cutPaths().has(entry.path)}
              onRemove={() => props.selection.remove(entry.path)} onOpen={(trigger) => setPreview({ path: entry.path, trigger })} />
          )}</For>
        </ul>
      </div>
      <Show when={previewEntry()} keyed>{(entry) => (
        <FilePreviewDialog entry={entry} root={props.root} trigger={preview()!.trigger} onClose={() => setPreview(undefined)}
          onOpenExternal={(application) => props.onOpenExternal(entry, application)}
          onSaveHint={props.onSaveHint} saveHint={props.saveHint} />
      )}</Show>
    </section>
  )
}
