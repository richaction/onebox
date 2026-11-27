import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { createEffect, createSignal, onCleanup, onSettled, Show } from 'solid-js'
import { desktopWorkspace, type WorkspaceEntry } from '../io/tauri'
import PreviewLoading from './PreviewLoading'
import type { ImagePreviewAction, ImagePreviewState } from './previewImage'

const unsupportedPreview = /\.(typ(?:st)?|ai|ait|psd|psb|abr|asl|csh|grd|pat|ase|aco|indd|indt|idml|icml|idms|inx|eps[fi]?|ps|fla|xfl|xd)$/iu
const unavailableMessage = '无法预览此文件。可以使用「打开方式」。'

export default function ViewerFrame(props: {
  root?: string
  entry: WorkspaceEntry
  onSaveHint: () => void
  onClose: () => void
  onInteract: () => void
  onSettled: (ready: boolean) => void
  imageCommand?: { action: ImagePreviewAction }
  onImageState: (state?: ImagePreviewState) => void
  pdfOutlineOpen: boolean
}) {
  const name = props.entry.name
  const supported = !unsupportedPreview.test(name)
  let frame!: HTMLIFrameElement
  const [loading, setLoading] = createSignal(supported)
  const [visible, setVisible] = createSignal(false)
  const [error, setError] = createSignal(supported ? '' : unavailableMessage)
  let disposed = false
  let connected = false
  let sent = false
  let savingArchiveEntry = false
  let url: string | undefined

  createEffect(() => props.imageCommand, (command) => {
    if (command && visible()) frame.contentWindow?.postMessage({ type: 'onebox-preview-image-command', ...command }, '*')
  }, { defer: true })

  createEffect(() => props.pdfOutlineOpen, (open) => {
    if (visible() && /\.pdf$/iu.test(name)) frame.contentWindow?.postMessage({ type: 'onebox-preview-pdf-outline', open }, '*')
  }, { defer: true })

  onSettled(() => {
    if (!supported) {
      props.onSettled(false)
      return
    }
    const timeout = setTimeout(() => finish('预览未能加载'), 30000)
    const finish = (message = '') => {
      clearTimeout(timeout)
      setLoading(false)
      setError(message)
      setVisible(!message)
      props.onSettled(!message)
    }
    const send = () => {
      if (disposed || !connected || !url || sent) return
      sent = true
      frame.contentWindow?.postMessage({ type: 'onebox-preview-source', url, name }, '*')
    }
    const saveArchiveEntry = async (name: unknown, bytes: unknown) => {
      if (savingArchiveEntry || typeof name !== 'string' || !(bytes instanceof ArrayBuffer) ||
        !name || name === '.' || name === '..' || /[/\\\0]/u.test(name)) return
      savingArchiveEntry = true
      try {
        const path = await save({ defaultPath: name })
        if (path) await invoke('plugin:fs|write_file', bytes, { headers: { path: encodeURIComponent(path) } })
      } catch {
        if (!disposed) frame.contentWindow?.postMessage({ type: 'onebox-preview-archive-save-error' }, '*')
      } finally {
        savingArchiveEntry = false
      }
    }
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return
      if (event.origin === location.origin && event.data?.type === 'onebox-preview-save-archive-entry') {
        void saveArchiveEntry(event.data.name, event.data.bytes)
        return
      }
      if (event.data?.type === 'onebox-preview-image-state') {
        props.onImageState(event.data.state)
        return
      }
      switch (event.data) {
        case 'onebox-preview-ready':
          connected = true
          send()
          break
        case 'onebox-preview-rendered':
          finish()
          break
        case 'onebox-preview-error':
          props.onImageState()
          finish(unavailableMessage)
          break
        case 'onebox-preview-close':
          props.onClose()
          break
        case 'onebox-preview-interact':
          props.onInteract()
          break
        case 'onebox-preview-save-hint':
          props.onSaveHint()
          break
      }
    }
    window.addEventListener('message', receive)
    void desktopWorkspace.preparePreview(props.root, props.entry.path).then((path) => {
      if (disposed) return
      url = convertFileSrc(path)
      send()
    }).catch((error: unknown) => {
      if (!disposed) finish(typeof error === 'string' ? error : '无法读取此文件')
    })
    return () => {
      disposed = true
      clearTimeout(timeout)
      window.removeEventListener('message', receive)
    }
  })

  return (
    <div class={['preview-surface', { 'preview-surface-text': /\.txt$/iu.test(props.entry.name) }]}>
      <Show when={supported}>
        <iframe ref={frame} title={`只读预览：${name}`}
          class={{ 'preview-frame-ready': visible() }} inert={!visible()}
          src={`${import.meta.env.BASE_URL}preview-frame.html`} sandbox="allow-scripts allow-same-origin" />
      </Show>
      <Show when={loading()}><PreviewLoading label="正在打开预览…" /></Show>
      <Show when={error()}>
        <div class="preview-status" role="status">
          <p>{error()}</p>
        </div>
      </Show>
    </div>
  )
}
