import { enableExpandedPreviewZoom } from './expandedPreviewZoom'

export function showExpandedPreview(
  trigger: HTMLButtonElement, kind: 'mermaid' | 'echarts' | 'image',
  draw: (target: HTMLElement) => (() => void) | void, onClose: () => void,
) {
  const document = trigger.ownerDocument
  const label = kind === 'image' ? '图片预览' : kind === 'mermaid' ? 'Mermaid 图' : 'ECharts 图表'
  const dialog = document.createElement('dialog')
  dialog.className = 'rich-preview-dialog'
  dialog.setAttribute('aria-label', label)
  const bar = document.createElement('header')
  bar.className = 'rich-preview-dialog-bar'
  const title = document.createElement('span')
  title.textContent = label
  title.tabIndex = -1
  title.autofocus = true
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'rich-preview-close'
  close.dataset.activateOnRelease = ''
  close.setAttribute('aria-label', '关闭放大预览')
  close.title = '关闭（Esc）'
  close.onclick = () => dialog.close()
  bar.append(title, close)

  const viewport = document.createElement('div')
  viewport.className = 'rich-preview-dialog-viewport'
  viewport.tabIndex = 0
  viewport.setAttribute('role', 'region')
  viewport.setAttribute('aria-label', '放大预览区域')
  const content = document.createElement('div')
  content.className = 'rich-preview-dialog-content'
  content.dataset.kind = kind
  viewport.append(content)
  dialog.append(bar, viewport)

  let dispose: (() => void) | void
  let navigation: ReturnType<typeof enableExpandedPreviewZoom> | undefined
  const destroy = () => {
    navigation?.destroy()
    navigation = undefined
    const cleanup = dispose
    dispose = undefined
    cleanup?.()
    dialog.remove()
  }
  dialog.addEventListener('close', () => {
    if (!dialog.isConnected) return
    destroy()
    onClose()
    if (trigger.isConnected) trigger.focus({ preventScroll: true })
  })
  let pressedBackdrop = false
  dialog.addEventListener('pointerdown', (event) => { pressedBackdrop = event.target === dialog })
  dialog.addEventListener('click', (event) => {
    if (pressedBackdrop && event.target === dialog) dialog.close()
    pressedBackdrop = false
  })

  const host = trigger.closest('.app') ?? document.body
  host.append(dialog)
  dialog.showModal()
  try {
    dispose = draw(content)
    const media = content.firstElementChild
    if (media instanceof SVGSVGElement || media instanceof HTMLImageElement) {
      navigation = enableExpandedPreviewZoom(viewport, content, media)
      bar.insertBefore(navigation.toolbar, close)
    }
  } catch (error) {
    content.textContent = '预览失败 · ' + (error instanceof Error ? error.message : String(error))
  }
  return destroy
}
