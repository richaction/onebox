import { convertFileSrc } from '@tauri-apps/api/core'
import { createSignal, For, lazy, Match, onCleanup, onMount, Show, Suspense, Switch } from 'solid-js'
import ImagePreview from './ImagePreview'
import { desktopWorkspace, type WorkspaceEntry } from '../io/tauri'

const formats: Record<string, 'text' | 'pdf' | 'audio' | 'video' | 'image' | 'office'> = {
  txt: 'text', pdf: 'pdf',
  mp3: 'audio', m4a: 'audio', aac: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', opus: 'audio',
  mp4: 'video', m4v: 'video', mov: 'video', webm: 'video', ogv: 'video',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image',
  bmp: 'image', svg: 'image', ico: 'image',
  doc: 'office', docx: 'office', xls: 'office', xlsx: 'office', ppt: 'office', pptx: 'office',
}

export function previewKind(name: string) {
  const dot = name.lastIndexOf('.')
  const extension = name.slice(dot + 1).toLowerCase()
  return dot >= 0 && Object.hasOwn(formats, extension) ? formats[extension] : undefined
}

function decodeText(bytes: Uint8Array, truncated: boolean) {
  let encoding = 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated })
  } catch {
    return new TextDecoder(encoding === 'utf-8' ? 'gb18030' : encoding).decode(bytes, { stream: truncated })
  }
}

const PdfPreview = lazy(() => import('./PdfPreview'))

function AppIcon(props: { bytes?: number[] }) {
  return (
    <span class="file-open-with-icon" aria-hidden="true">
      <Show when={props.bytes?.length ? props.bytes : undefined} fallback={<span class="file-open-with-generic" />}>
        {(bytes) => <img src={`data:image/png;base64,${btoa(String.fromCharCode(...bytes()))}`} alt="" />}
      </Show>
    </span>
  )
}

export default function FilePreview(props: {
  root: string
  entry: WorkspaceEntry
  onOpenExternal: (application?: string) => void
}) {
  const kind = previewKind(props.entry.name)
  const [ready, setReady] = createSignal(false)
  const [error, setError] = createSignal('')
  const [text, setText] = createSignal('')
  const [truncated, setTruncated] = createSignal(false)
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [applications, setApplications] = createSignal<Awaited<ReturnType<typeof desktopWorkspace.fileApplications>>>()
  const [applicationIcons, setApplicationIcons] = createSignal<Record<string, number[]>>({})
  const [officeError, setOfficeError] = createSignal('')
  const [officePdf, setOfficePdf] = createSignal<string>()
  const [outlineAvailable, setOutlineAvailable] = createSignal(false)
  const [outlineVisible, setOutlineVisible] = createSignal(false)
  const [poster, setPoster] = createSignal<string>()
  let openWithButton!: HTMLButtonElement
  let openWithMenu!: HTMLDivElement
  const url = convertFileSrc(props.entry.path)
  let disposed = false
  let localPoster: string | undefined
  let localOfficePdf: string | undefined

  const openOfficePreview = async () => {
    setOfficeError('')
    try {
      const bytes = await desktopWorkspace.officePreview(props.root, props.entry.path)
      if (disposed) return
      localOfficePdf = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
      setOfficePdf(localOfficePdf)
    } catch (error) {
      if (!disposed) setOfficeError(typeof error === 'string' ? error : '无法打开 Office 预览')
    }
  }

  onMount(() => {
    void desktopWorkspace.fileApplications(props.root, props.entry.path).catch(() => []).then((items) => {
      if (disposed) return
      setApplications(items)
      if (items.length) {
        void desktopWorkspace.fileApplicationIcons(props.root, props.entry.path, items.map((app) => app.path))
          .then((icons) => { if (!disposed) setApplicationIcons(icons) }).catch(() => {})
      }
    })
    if (kind === 'office') {
      setReady(true)
      void openOfficePreview()
      return
    }
    if (kind === 'video') {
      void desktopWorkspace.videoPoster(props.root, props.entry.path).then((bytes) => {
        if (disposed || !bytes.byteLength) return
        localPoster = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
        setPoster(localPoster)
      }).catch(() => {})
    }
    void desktopWorkspace.preparePreview(props.root, props.entry.path).then((bytes) => {
      if (disposed) return
      if (kind === 'text') {
        const limit = 4 * 1024 * 1024
        const partial = bytes.byteLength > limit
        setTruncated(partial)
        setText(decodeText(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, limit)), partial))
      }
      setReady(true)
    }).catch(() => { if (!disposed) setError('无法读取预览') })
  })
  onCleanup(() => {
    disposed = true
    if (localPoster) URL.revokeObjectURL(localPoster)
    if (localOfficePdf) URL.revokeObjectURL(localOfficePdf)
  })

  const mediaError = () => setError('当前系统无法播放此文件的编码格式')

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

  const defaultApp = () => applications()?.find((app) => app.default)
  const alternatives = () => applications()?.filter((app) => !app.default) ?? []
  const defaultIcon = () => applicationIcons()[defaultApp()?.path ?? '']

  return (
    <section class="file-preview" aria-label="文件预览">
      <header class="file-preview-toolbar">
        <strong title={props.entry.name}>{props.entry.name}</strong>
        <Show when={outlineAvailable()}>
          <button type="button" aria-expanded={outlineVisible()} onClick={() => setOutlineVisible((visible) => !visible)}>目录</button>
        </Show>
        <div class="file-open-with" role="group" aria-label="打开方式">
          <button type="button" class="file-open-with-default"
            aria-label={`用${defaultApp()?.name ?? '系统默认应用'}打开`}
            title={`用${defaultApp()?.name ?? '系统默认应用'}打开`} onClick={() => openWith()}>
            <AppIcon bytes={defaultIcon()} />
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
            <AppIcon bytes={defaultIcon()} />
            <span class="file-open-with-name">{defaultApp()?.name ?? '系统应用'}</span>
            <span class="file-open-with-check" aria-hidden="true" />
          </button>
          <For each={alternatives()}>{(app) => (
            <button type="button" role="menuitem" onClick={() => openWith(app.path)}>
              <AppIcon bytes={applicationIcons()[app.path]} />
              <span class="file-open-with-name">{app.name}</span>
            </button>
          )}</For>
          <Show when={!applications()}><span class="file-open-with-loading" role="status">正在查找其他应用…</span></Show>
        </div>
      </header>
      <Switch>
        <Match when={error()}><p class="file-preview-message" role="status">{error()}</p></Match>
        <Match when={!ready()}><p class="file-preview-message" role="status">正在载入预览…</p></Match>
        <Match when={kind === 'text'}>
          <Show when={truncated()}><p class="file-preview-message">预览前 4 MiB</p></Show>
          <pre class="file-preview-text" tabindex="0">{text()}</pre>
        </Match>
        <Match when={kind === 'pdf'}>
          <Suspense fallback={<p class="file-preview-message" role="status">正在载入 PDF…</p>}>
            <PdfPreview url={url} onError={setError} outlineVisible={outlineVisible()} onOutline={setOutlineAvailable} />
          </Suspense>
        </Match>
        <Match when={kind === 'audio'}>
          <div class="file-preview-media"><audio controls preload="metadata" src={url} onError={mediaError} /></div>
        </Match>
        <Match when={kind === 'video'}>
          <div class="file-preview-media">
            <video controls playsinline preload="auto" src={url} poster={poster()} onError={mediaError}
              onEnded={(event) => { event.currentTarget.currentTime = 0 }} />
          </div>
        </Match>
        <Match when={kind === 'image'}>
          <ImagePreview url={url} name={props.entry.name} onError={() => setError('无法显示此图片')} />
        </Match>
        <Match when={kind === 'office'}>
          <Show when={officePdf()} keyed fallback={
            <div class="file-preview-office" role="status">
              <Show when={officeError()} fallback={<p>正在排版 Office 文档…</p>}>
                <p>{officeError()}</p>
                <button type="button" onClick={() => void openOfficePreview()}>重试</button>
              </Show>
            </div>
          }>
            {(pdfUrl) => (
              <Suspense fallback={<p class="file-preview-message" role="status">正在载入分页预览…</p>}>
                <PdfPreview url={pdfUrl} onError={setError} outlineVisible={outlineVisible()} onOutline={setOutlineAvailable} />
              </Suspense>
            )}
          </Show>
        </Match>
      </Switch>
    </section>
  )
}
