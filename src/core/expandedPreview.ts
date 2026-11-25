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
  const close = document.createElement('button')
  close.type = 'button'
  close.dataset.activateOnRelease = ''
  close.setAttribute('aria-label', '关闭放大预览')
  close.title = '关闭（Esc）'
  close.textContent = '×'
  close.autofocus = true
  close.onclick = () => dialog.close()
  bar.append(title, close)

  const viewport = document.createElement('div')
  viewport.className = 'rich-preview-dialog-viewport'
  viewport.tabIndex = 0
  viewport.setAttribute('aria-label', '放大预览区域')
  const content = document.createElement('div')
  content.className = 'rich-preview-dialog-content'
  content.dataset.kind = kind
  viewport.append(content)
  dialog.append(bar, viewport)

  let dispose: (() => void) | void
  const destroy = () => {
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

  document.body.append(dialog)
  dialog.showModal()
  try {
    dispose = draw(content)
  } catch (error) {
    content.textContent = '预览失败 · ' + (error instanceof Error ? error.message : String(error))
  }
  return destroy
}
