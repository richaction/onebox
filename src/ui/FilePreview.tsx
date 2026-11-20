import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { desktopWorkspace, type FileApplications, type WorkspaceEntry } from '../io/tauri'
import ViewerFrame from './ViewerFrame'

function AppIcon(props: { src?: string | null }) {
  return (
    <span class="file-open-with-icon" aria-hidden="true">
      <Show when={props.src} fallback={<span class="file-open-with-generic" />}>
        {(src) => <img src={src()} alt="" />}
      </Show>
    </span>
  )
}

export default function FilePreview(props: {
  root?: string
  entry: WorkspaceEntry
  onOpenExternal: (application?: string) => void
  onClose: () => void
}) {
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [applications, setApplications] = createSignal<FileApplications>()
  const [applicationIcons, setApplicationIcons] = createSignal<Record<string, string>>({})
  let openWithButton!: HTMLButtonElement
  let openWithMenu!: HTMLDivElement
  let disposed = false

  onMount(() => {
    void desktopWorkspace.fileApplications(props.root, props.entry.path, (list) => {
      if (!disposed) setApplications(list)
    }).then((icons) => {
      if (!disposed) setApplicationIcons(icons)
    }).catch(() => {
      if (!disposed) setApplications((list) => list ?? { items: [], defaultIcon: null })
    })
  })
  onCleanup(() => { disposed = true })

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

  return (
    <section class="file-preview" aria-label="文件预览">
      <header class="file-preview-toolbar">
        <strong title={props.entry.name}>{props.entry.name}</strong>
        <div class="file-open-with" role="group" aria-label="打开方式">
          <button type="button" class="file-open-with-default"
            aria-label={`用${defaultApp()?.name ?? '系统默认应用'}打开`}
            title={`用${defaultApp()?.name ?? '系统默认应用'}打开`} onClick={() => openWith()}>
            <AppIcon src={applications()?.defaultIcon} />
          </button>
          <button type="button" class="file-open-with-toggle" ref={openWithButton} aria-label="打开方式"
            aria-haspopup="menu" aria-expanded={menuOpen()} aria-controls="preview-open-with"
            popovertarget="preview-open-with" onClick={positionOpenWith}>
            <span aria-hidden="true" />
          </button>
        </div>
        <div ref={openWithMenu} id="preview-open-with" class="file-open-with-menu" popover="auto" role="menu" aria-label="打开方式"
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
      <ViewerFrame root={props.root} entry={props.entry} onClose={props.onClose} />
    </section>
  )
}
