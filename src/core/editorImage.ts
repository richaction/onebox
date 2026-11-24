import { closeHistory } from '@tiptap/pm/history'
import type { Node } from '@tiptap/pm/model'
import type { EditorView, NodeView } from '@tiptap/pm/view'
import { isRelativeResource } from './attachmentLinks'
import { defaultImageWidth, imageWidthPercent, maxImageWidth, minImageWidth } from './markdownNodes'

export function editorImage(node: Node, view: EditorView, getPos: () => number | undefined, assets: {
  read?: (href: string) => Promise<Blob | undefined>
  context?: () => string | null
  refreshers: Set<() => void>
}): NodeView {
  const document = view.dom.ownerDocument
  const dom = document.createElement('span')
  dom.className = 'editor-image'
  dom.contentEditable = 'false'
  const image = document.createElement('img')
  const { src, alt, title } = node.attrs
  image.alt = alt
  if (title) image.title = title
  image.decoding = 'async'
  dom.append(image)

  let current = node
  let objectUrl: string | undefined
  let disposed = false
  let request = 0
  let previousContext: string | null | undefined
  const refresh = () => {
    const context = assets.context?.()
    if (request > 0 && previousContext === context) return
    previousContext = context
    const generation = ++request
    if (objectUrl) {
      image.removeAttribute('src')
      URL.revokeObjectURL(objectUrl)
      objectUrl = undefined
    }
    void assets.read?.(src).then((blob) => {
      if (!blob || disposed || generation !== request) return
      objectUrl = URL.createObjectURL(blob)
      image.src = objectUrl
    }).catch(() => {})
  }
  if (isRelativeResource(src)) {
    assets.refreshers.add(refresh)
    refresh()
  } else if (/^https?:\/\//i.test(src)) image.src = src

  const savedWidth = () => imageWidthPercent(current.attrs.widthPercent) ?? defaultImageWidth
  const clamp = (width: number) => Math.min(maxImageWidth, Math.max(minImageWidth, Math.round(width)))
  const handles = [-1, 1].map((side) => {
    const grip = document.createElement('button')
    grip.type = 'button'
    grip.className = 'editor-image-resize'
    grip.dataset.side = side < 0 ? 'left' : 'right'
    grip.title = '拖动调整宽度，双击恢复 80%'
    grip.setAttribute('role', 'slider')
    grip.setAttribute('aria-label', side < 0 ? '从左侧调整图片宽度' : '从右侧调整图片宽度')
    grip.setAttribute('aria-valuemin', String(minImageWidth))
    grip.setAttribute('aria-valuemax', String(maxImageWidth))
    dom.append(grip)
    return grip
  })
  const paint = (width: number) => {
    dom.style.setProperty('--editor-image-width', width + '%')
    for (const grip of handles) {
      grip.setAttribute('aria-valuenow', String(width))
      grip.setAttribute('aria-valuetext', width + '%')
    }
  }
  const commit = (width: number) => {
    const pos = getPos()
    if (!view.editable || pos === undefined || view.state.doc.nodeAt(pos) !== current || width === savedWidth()) {
      paint(savedWidth())
      return
    }
    view.dispatch(closeHistory(view.state.tr.setNodeAttribute(pos, 'widthPercent', width === defaultImageWidth ? null : width)))
  }
  for (const [index, grip] of handles.entries()) {
    const direction = index === 0 ? -1 : 1
    let drag: { id: number; x: number; available: number; initial: number; width: number } | undefined
    grip.onpointerdown = (event) => {
      if (!view.editable || drag || event.button !== 0) return
      const paragraph = dom.closest('p[data-standalone-image]')
      const available = paragraph?.getBoundingClientRect().width ?? 0
      if (!available) return
      event.preventDefault()
      const width = savedWidth()
      grip.setPointerCapture(event.pointerId)
      drag = { id: event.pointerId, x: event.clientX, available, initial: width, width }
      dom.setAttribute('data-resizing', '')
    }
    grip.onpointermove = (event) => {
      if (!drag || event.pointerId !== drag.id) return
      const delta = (event.clientX - drag.x) / drag.available * 100
      drag.width = clamp(drag.initial + 2 * direction * delta)
      paint(drag.width)
    }
    grip.onpointerup = (event) => {
      if (!drag || event.pointerId !== drag.id) return
      const { width } = drag
      drag = undefined
      dom.removeAttribute('data-resizing')
      commit(width)
    }
    const cancel = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return
      drag = undefined
      dom.removeAttribute('data-resizing')
      paint(savedWidth())
    }
    grip.onpointercancel = cancel
    grip.onlostpointercapture = cancel
    grip.ondblclick = (event) => {
      event.preventDefault()
      commit(defaultImageWidth)
    }
    grip.onkeydown = (event) => {
      const width = savedWidth()
      const next = event.key === 'Home' ? minImageWidth : event.key === 'End' ? maxImageWidth
        : event.key === 'ArrowLeft' ? width - 5 : event.key === 'ArrowRight' ? width + 5 : undefined
      if (next === undefined) return
      event.preventDefault()
      commit(clamp(next))
    }
  }
  paint(savedWidth())

  return {
    dom,
    stopEvent: (event) => event.target instanceof Element && !!event.target.closest('.editor-image-resize'),
    update(next) {
      if (next.type !== current.type || next.attrs.src !== src || next.attrs.alt !== alt || next.attrs.title !== title) return false
      current = next
      paint(savedWidth())
      return true
    },
    destroy() {
      disposed = true
      assets.refreshers.delete(refresh)
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    },
  }
}
