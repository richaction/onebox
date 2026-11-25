import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, onSettled, Show } from 'solid-js'
import { desktopWorkspace, type FileApplications, type WorkspaceEntry } from '../io/tauri'
import ViewerFrame from './ViewerFrame'
import FileName, { type TitleEdit } from './FileName'
import { isImagePreview, type ImagePreviewAction, type ImagePreviewState } from './previewImage'

const previewRequest = (entry: WorkspaceEntry, root?: string) => ({
  entry, root, ready: createSignal(false), image: createSignal<ImagePreviewState>(), outline: createSignal(false),
})

function AppIcon(props: { src?: string | null }) {
  return (
    <span class="file-open-with-icon" aria-hidden="true">
      <Show when={props.src} fallback={<span class="file-open-with-generic" />}>
        {(src) => <img src={src()} alt="" draggable={false} />}
      </Show>
    </span>
  )
}

interface FilePreviewProps {
  root?: string
  entry?: WorkspaceEntry
  onOpenExternal: (application?: string) => void
  onSaveHint: () => void
  saveHint: string
  onClose: () => void
  titleEdit?: TitleEdit
}

export function FilePreviewDialog(props: FilePreviewProps & { trigger: HTMLButtonElement }) {
  let dialog!: HTMLDivElement
  const close = () => {
    const trigger = props.trigger
    props.onClose()
    trigger.focus({ preventScroll: true })
  }
  onSettled(() => {
    dialog.focus({ preventScroll: true })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.key === 'Escape') {
        if (dialog.querySelector('[popover]:popover-open')) return
        event.preventDefault()
        close()
      } else if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        props.onSaveHint()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  return (
    <div class="file-preview-overlay">
      <div class="file-preview-dialog" ref={dialog} role="dialog" aria-modal="true" tabindex={-1}
        aria-label={`预览 ${props.entry?.name ?? ''}`}>
        <FilePreview {...props} onClose={close} showClose />
      </div>
    </div>
  )
}

export default function FilePreview(props: FilePreviewProps & { showClose?: boolean }) {
  const menuId = createUniqueId()
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [applications, setApplications] = createSignal<FileApplications>()
  const [applicationIcons, setApplicationIcons] = createSignal<Record<string, string>>({})
  const [imageCommand, setImageCommand] = createSignal<{ action: ImagePreviewAction }>()
  const requested = createMemo(() => {
    const { entry, root } = props
    return entry ? previewRequest(entry, root) : undefined
  })
  const imageState = () => requested()?.image[0]()
  const previewReady = () => requested()?.ready[0]() ?? false
  const pdfOutlineOpen = () => requested()?.outline[0]() ?? false
  const setPdfOutlineOpen = (open: boolean) => requested()?.outline[1](open)
  const imagePreview = () => isImagePreview(props.entry?.name ?? '')
  const pdfPreview = () => /\.pdf$/iu.test(props.entry?.name ?? '')
  let openWithButton!: HTMLButtonElement
  let openWithMenu!: HTMLDivElement
  let outlineButton: HTMLButtonElement | undefined
  createEffect(() => [props.root, props.entry?.path] as const, ([root, path]) => {
    if (!path) return
    let disposed = false
    void desktopWorkspace.fileApplications(root, path, (list) => {
      if (!disposed) setApplications(list)
    }).then((icons) => {
      if (!disposed) setApplicationIcons(icons)
    }).catch(() => {
      if (!disposed) setApplications((list) => list ?? { items: [], defaultIcon: null })
    })
    return () => { disposed = true }
  })

  const positionOpenWith = () => {
    const bounds = openWithButton.getBoundingClientRect()
    openWithMenu.style.top = `${bounds.bottom + 6}px`
    openWithMenu.style.right = `${Math.max(8, window.innerWidth - bounds.right)}px`
    openWithMenu.style.maxHeight = `${Math.max(48, window.innerHeight - bounds.bottom - 14)}px`
  }

  const focusMenuItem = () => openWithMenu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()

  const updateOpenWith = () => {
    const visible = openWithMenu.matches(':popover-open')
    setMenuOpen(visible)
    if (visible) focusMenuItem()
  }

  const dismissOpenWith = () => {
    if (openWithMenu.matches(':popover-open')) openWithMenu.hidePopover()
  }

  const openWith = (application?: string) => {
    if (openWithMenu.matches(':popover-open')) {
      openWithMenu.hidePopover()
      openWithButton.focus()
    }
    props.onOpenExternal(application)
  }

  const onMenuKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      openWithMenu.hidePopover()
      openWithButton.focus()
      return
    }
    const entries = Array.from(openWithMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    if (!entries.length) return
    const index = entries.indexOf(document.activeElement as HTMLButtonElement)
    let next: number
    switch (event.key) {
      case 'ArrowDown': next = (index + 1) % entries.length; break
      case 'ArrowUp': next = index <= 0 ? entries.length - 1 : index - 1; break
      case 'Home': next = 0; break
      case 'End': next = entries.length - 1; break
      default: return
    }
    event.preventDefault()
    entries[next]?.focus()
  }

  const defaultApp = () => applications()?.items.find((app) => app.default)
  const alternatives = () => applications()?.items.filter((app) => !app.default) ?? []
  const closePreview = () => {
    if (!pdfOutlineOpen()) {
      props.onClose()
      return
    }
    setPdfOutlineOpen(false)
    outlineButton?.focus()
  }

  return (
    <section class="file-preview" aria-label="文件预览">
      <header class="file-preview-toolbar" data-activate-on-release>
        <FileName name={props.entry?.name ?? ''} edit={props.titleEdit} />
        <div class="file-save-hint" role="status">{props.saveHint}</div>
        <div class="file-preview-actions">
          <Show when={imagePreview()}>
            <div class="file-preview-image-tools" role="group" aria-label="图片工具栏">
              <Show when={imageState()?.pages}>{(pages) => <span class="file-preview-image-pages">{pages()}</span>}</Show>
              <button type="button" class="file-preview-image-rotate" title="顺时针旋转" aria-label="顺时针旋转"
                disabled={!imageState()} onClick={() => setImageCommand({ action: 'rotate' })}>↻</button>
              <button type="button" title="缩小图片" aria-label="缩小图片" disabled={!imageState()?.canZoomOut}
                onClick={() => setImageCommand({ action: 'zoom-out' })}>−</button>
              <button type="button" class="file-preview-image-fit" title="适合窗口" aria-label={`适合窗口，当前缩放 ${imageState()?.label ?? '未知'}`}
                disabled={!imageState()} onClick={() => setImageCommand({ action: 'fit' })}>{imageState()?.label ?? '适合'}</button>
              <button type="button" title="放大图片" aria-label="放大图片" disabled={!imageState()?.canZoomIn}
                onClick={() => setImageCommand({ action: 'zoom-in' })}>+</button>
            </div>
          </Show>
          <Show when={pdfPreview()}>
            <button type="button" ref={outlineButton} class="file-preview-outline-toggle" title="PDF 目录" aria-label="PDF 目录"
              aria-expanded={pdfOutlineOpen() ? 'true' : 'false'} disabled={!previewReady()} onClick={() => setPdfOutlineOpen(!pdfOutlineOpen())}
              onKeyDown={(event) => {
                if (event.key !== 'Escape' || !pdfOutlineOpen()) return
                event.stopPropagation()
                closePreview()
              }}>
              <span class="sidebar-toggle-symbol" aria-hidden="true" />
            </button>
          </Show>
          <div class="file-open-with" role="group" aria-label="打开方式">
            <button type="button" class="file-open-with-default"
              aria-label={`用${defaultApp()?.name ?? '系统默认应用'}打开`}
              title={`用${defaultApp()?.name ?? '系统默认应用'}打开`} onClick={() => openWith()}>
              <AppIcon src={applications()?.defaultIcon} />
            </button>
            <button type="button" class="file-open-with-toggle" ref={openWithButton} aria-label="打开方式"
              aria-haspopup="menu" aria-expanded={menuOpen() ? 'true' : 'false'} aria-controls={menuId}
              popovertarget={menuId} onClick={positionOpenWith}>
              <span aria-hidden="true" />
            </button>
          </div>
          <Show when={props.showClose}>
            <button type="button" class="file-preview-close" aria-label="关闭预览"
              title="关闭预览（Esc）" onClick={props.onClose} />
          </Show>
        </div>
        <div ref={openWithMenu} id={menuId} class="file-open-with-menu" popover="auto" role="menu" aria-label="打开方式"
          onToggle={updateOpenWith} onKeyDown={onMenuKey}>
          <button type="button" role="menuitem" aria-label={`${defaultApp()?.name ?? '系统应用'}，默认`} onClick={() => openWith()}>
            <AppIcon src={applications()?.defaultIcon} />
            <span class="file-open-with-name">{defaultApp()?.name ?? '系统应用'}</span>
            <span class="file-open-with-check" aria-hidden="true" />
          </button>
          <For each={alternatives()}>{(app) => (
            <button type="button" role="menuitem" onClick={() => openWith(app.path)}>
              <AppIcon src={applicationIcons()[app.path]} />
              <span class="file-open-with-name">{app.name}</span>
            </button>
          )}</For>
          <Show when={!applications()}><span class="file-open-with-loading" role="status">正在查找其他应用…</span></Show>
        </div>
      </header>
      <Show when={requested()} keyed>{(frame) => (
          <ViewerFrame root={frame.root} entry={frame.entry} onClose={closePreview} onSaveHint={props.onSaveHint}
            onInteract={dismissOpenWith}
            onSettled={(ready) => {
              frame.ready[1](ready)
              if (!ready) frame.outline[1](false)
            }}
            imageCommand={imageCommand()} onImageState={frame.image[1]} pdfOutlineOpen={frame.outline[0]()} />
      )}</Show>
    </section>
  )
}
