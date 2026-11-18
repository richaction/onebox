import { convertFileSrc } from '@tauri-apps/api/core'
import { createSignal, For, lazy, Match, onCleanup, onMount, Show, Suspense, Switch } from 'solid-js'
import { desktopWorkspace, type WorkspaceEntry } from '../io/tauri'

const formats: Record<string, 'text' | 'pdf' | 'audio' | 'video'> = {
  txt: 'text', pdf: 'pdf',
  mp3: 'audio', m4a: 'audio', aac: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', opus: 'audio',
  mp4: 'video', m4v: 'video', mov: 'video', webm: 'video', ogv: 'video',
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
  const [outlineAvailable, setOutlineAvailable] = createSignal(false)
  const [outlineVisible, setOutlineVisible] = createSignal(false)
  const [poster, setPoster] = createSignal<string>()
  const [videoStarted, setVideoStarted] = createSignal(false)
  let video!: HTMLVideoElement
  let openWithButton!: HTMLButtonElement
  let openWithMenu!: HTMLDivElement
  const url = convertFileSrc(props.entry.path)
  let disposed = false
  let localPoster: string | undefined

  onMount(() => {
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
  })

  const mediaError = () => setError('当前系统无法播放此文件的编码格式')

  const positionOpenWith = () => {
    const bounds = openWithButton.getBoundingClientRect()
    openWithMenu.style.top = `${bounds.bottom + 6}px`
    openWithMenu.style.right = `${Math.max(8, window.innerWidth - bounds.right)}px`
    openWithMenu.style.maxHeight = `${Math.max(48, window.innerHeight - bounds.bottom - 14)}px`
  }

  const updateOpenWith = async () => {
    const visible = openWithMenu.matches(':popover-open')
    setMenuOpen(visible)
    if (!visible) return
    if (!applications()) {
      const items = await desktopWorkspace.fileApplications(props.root, props.entry.path).catch(() => [])
      if (disposed || !openWithMenu.matches(':popover-open')) return
      setApplications(items)
    }
    openWithMenu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }

  const openWith = (application?: string) => {
    openWithMenu.hidePopover()
    openWithButton.focus()
    props.onOpenExternal(application)
  }

  const onMenuKey = (event: KeyboardEvent) => {
    const entries = Array.from(openWithMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    const index = entries.indexOf(document.activeElement as HTMLButtonElement)
    let next: number
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        openWithMenu.hidePopover()
        openWithButton.focus()
        return
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
  const appIcon = (bytes?: number[]) => bytes?.length ? `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}` : undefined

  const firstFrame = (video: HTMLVideoElement) => {
    if (poster() || !video.videoWidth || !video.videoHeight) return
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 960 / video.videoWidth)
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    try {
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
      setPoster(canvas.toDataURL('image/jpeg', 0.85))
    } catch { /* The video element can still display its decoded frame. */ }
  }

  return (
    <section class="file-preview" aria-label="文件预览">
      <header class="file-preview-toolbar">
        <strong title={props.entry.name}>{props.entry.name}</strong>
        <Show when={outlineAvailable()}>
          <button type="button" aria-expanded={outlineVisible()} onClick={() => setOutlineVisible((visible) => !visible)}>目录</button>
        </Show>
        <button type="button" class="file-open-with" ref={openWithButton} aria-haspopup="menu" aria-expanded={menuOpen()}
          aria-controls="preview-open-with" popovertarget="preview-open-with" onClick={positionOpenWith}>打开方式<span aria-hidden="true" /></button>
        <div ref={openWithMenu} id="preview-open-with" class="file-open-with-menu" popover="auto" role="menu" aria-label="打开方式"
          onToggle={() => void updateOpenWith()} onKeyDown={onMenuKey}>
          <Show when={applications()} fallback={<span class="file-open-with-loading">正在查找应用…</span>}>
            <button type="button" role="menuitem" onClick={() => openWith()}>
              <span class="file-open-with-icon"><Show when={appIcon(defaultApp()?.icon)}>{(icon) => <img src={icon()} alt="" />}</Show></span>
              <span class="file-open-with-name">{defaultApp()?.name ?? '系统应用'}</span><small>默认</small>
            </button>
            <Show when={alternatives().length}><div role="separator" /></Show>
            <For each={alternatives()}>{(app) => (
              <button type="button" role="menuitem" onClick={() => openWith(app.path)}>
                <span class="file-open-with-icon"><Show when={appIcon(app.icon)}>{(icon) => <img src={icon()} alt="" />}</Show></span>
                <span class="file-open-with-name">{app.name}</span>
              </button>
            )}</For>
          </Show>
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
            <div class="file-video-stage">
              <video ref={video} controls playsinline preload="auto" crossorigin="anonymous"
                src={`${url}#t=0.001`} poster={poster()} onError={mediaError}
                onLoadedData={(event) => firstFrame(event.currentTarget)}
                onSeeked={(event) => { if (event.currentTarget.currentTime < 0.05) firstFrame(event.currentTarget) }}
                onPlay={() => setVideoStarted(true)} onEnded={(event) => {
                  setVideoStarted(false)
                  event.currentTarget.currentTime = 0.001
                }} />
              <Show when={!videoStarted() && poster()}>
                <div class="file-video-cover">
                  <img src={poster()} alt="视频预览图" />
                  <button type="button" aria-label="播放视频" onClick={() => void video.play().catch(mediaError)} />
                </div>
              </Show>
            </div>
          </div>
        </Match>
      </Switch>
    </section>
  )
}
