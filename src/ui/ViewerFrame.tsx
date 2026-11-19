import { convertFileSrc } from '@tauri-apps/api/core'
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { desktopWorkspace, type WorkspaceEntry } from '../io/tauri'

const LOADING_DELAY_MS = 300

export default function ViewerFrame(props: { root?: string; entry: WorkspaceEntry; onClose: () => void }) {
  let frame!: HTMLIFrameElement
  const [loading, setLoading] = createSignal(false)
  const [visible, setVisible] = createSignal(false)
  const [error, setError] = createSignal('')
  let disposed = false
  let connected = false
  let sent = false
  let url: string | undefined
  let renderName = props.entry.name
  let temporaryPath: string | undefined

  onMount(() => {
    const hint = setTimeout(() => setLoading(true), LOADING_DELAY_MS)
    const timeout = setTimeout(() => finish('预览未能加载'), 30000)
    const finish = (message = '') => {
      clearTimeout(hint)
      clearTimeout(timeout)
      setLoading(false)
      setError(message)
    }
    const send = () => {
      if (disposed || !connected || !url || sent) return
      sent = true
      frame.contentWindow?.postMessage({ type: 'onebox-preview-source', url, name: renderName }, '*')
    }
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return
      switch (event.data) {
        case 'onebox-preview-ready':
          connected = true
          send()
          break
        case 'onebox-preview-rendered':
          setVisible(true)
          finish()
          break
        case 'onebox-preview-error':
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
      clearTimeout(hint)
      clearTimeout(timeout)
      window.removeEventListener('message', receive)
      releaseTemporary()
    })
  })

  return (
    <div class="preview-surface">
      <iframe ref={frame} title={`只读预览：${props.entry.name}`}
        classList={{ 'preview-frame-ready': visible() }} inert={!visible()}
        src={`${import.meta.env.BASE_URL}preview-frame.html`} sandbox="allow-scripts allow-same-origin" />
      <Show when={loading() || error()}>
        <div class="preview-status" role="status">
          <Show when={!error()}><span class="preview-spinner" aria-hidden="true" /></Show>
          <p>{error() || '正在打开预览…'}</p>
        </div>
      </Show>
    </div>
  )
}
