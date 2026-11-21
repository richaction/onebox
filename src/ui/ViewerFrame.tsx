import { convertFileSrc } from '@tauri-apps/api/core'
import { createEffect, createSignal, on, onCleanup, onMount, Show } from 'solid-js'
import { desktopWorkspace, type WorkspaceEntry } from '../io/tauri'
import PreviewLoading from './PreviewLoading'
import type { ImagePreviewAction, ImagePreviewState } from './previewImage'

export default function ViewerFrame(props: {
  root?: string
  entry: WorkspaceEntry
  onClose: () => void
  onSettled: (ready: boolean) => void
  imageCommand?: { action: ImagePreviewAction }
  onImageState: (state?: ImagePreviewState) => void
  pdfOutlineOpen: boolean
}) {
  let frame!: HTMLIFrameElement
  const [loading, setLoading] = createSignal(true)
  const [visible, setVisible] = createSignal(false)
  const [error, setError] = createSignal('')
  let disposed = false
  let connected = false
  let sent = false
  let url: string | undefined
  let renderName = props.entry.name
  let temporaryPath: string | undefined

  createEffect(on(() => props.imageCommand, (command) => {
    if (command && visible()) frame.contentWindow?.postMessage({ type: 'onebox-preview-image-command', ...command }, '*')
  }, { defer: true }))

  createEffect(on(() => props.pdfOutlineOpen, (open) => {
    if (visible() && /\.pdf$/iu.test(renderName)) frame.contentWindow?.postMessage({ type: 'onebox-preview-pdf-outline', open }, '*')
  }, { defer: true }))

  onMount(() => {
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
      frame.contentWindow?.postMessage({ type: 'onebox-preview-source', url, name: renderName }, '*')
    }
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return
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
          finish('无法预览此文件。可以使用「打开方式」。')
          break
        case 'onebox-preview-close':
          props.onClose()
          break
      }
    }
    window.addEventListener('message', receive)
    const releaseTemporary = () => {
      if (!temporaryPath) return
      void desktopWorkspace.releasePreview(temporaryPath).catch(() => {})
      temporaryPath = undefined
    }
    void desktopWorkspace.preparePreview(props.root, props.entry.path).then((preview) => {
      if (typeof preview !== 'string') {
        temporaryPath = preview.path
        renderName = preview.convertedName
      }
      if (disposed) {
        releaseTemporary()
        return
      }
      url = convertFileSrc(typeof preview === 'string' ? preview : preview.path)
      send()
    }).catch((error: unknown) => {
      if (!disposed) finish(typeof error === 'string' ? error : '无法读取此文件')
    })
    onCleanup(() => {
      disposed = true
      clearTimeout(timeout)
      window.removeEventListener('message', receive)
      releaseTemporary()
    })
  })

  return (
    <div class="preview-surface" classList={{ 'preview-surface-text': /\.txt$/iu.test(props.entry.name) }}>
      <iframe ref={frame} title={`只读预览：${props.entry.name}`}
        classList={{ 'preview-frame-ready': visible() }} inert={!visible()}
        src={`${import.meta.env.BASE_URL}preview-frame.html`} sandbox="allow-scripts allow-same-origin" />
      <Show when={loading()}><PreviewLoading label="正在打开预览…" /></Show>
      <Show when={error()}>
        <div class="preview-status" role="status">
          <p>{error()}</p>
        </div>
      </Show>
    </div>
  )
}
