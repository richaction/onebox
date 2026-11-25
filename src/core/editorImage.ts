import { closeHistory } from '@tiptap/pm/history'
import type { Node } from '@tiptap/pm/model'
import { NodeSelection } from '@tiptap/pm/state'
import type { EditorView, NodeView } from '@tiptap/pm/view'
import { isRelativeResource } from './attachmentLinks'
import { isReorderedPointerRelease, reachesDragThreshold } from './buttonClickTolerance'
import { defaultImageWidth, imageWidthPercent, maxImageWidth, minImageWidth } from './markdownNodes'
import { showExpandedPreview } from './expandedPreview'

export type ImageDimensions = { context: string | null | undefined; width: number; height: number }

export function editorImage(node: Node, view: EditorView, getPos: () => number | undefined, assets: {
  read?: (href: string) => Promise<Blob | undefined>
  context?: () => string | null
  refreshers: Set<() => void>
  dimensions: WeakMap<Node, ImageDimensions>
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
  const expand = document.createElement('button')
  expand.type = 'button'
  expand.className = 'editor-image-expand'
  expand.textContent = '⤢'
  expand.title = '放大图片'
  expand.setAttribute('aria-label', expand.title)
  expand.dataset.activateOnRelease = ''
  expand.hidden = true
  dom.append(image, expand)

  let current = node
  let objectUrl: string | undefined
  let disposed = false
  let request = 0
  let previousContext: string | null | undefined
  let closeExpanded: (() => void) | undefined
  const setDimensions = (dimensions: ImageDimensions | undefined) => {
    if (dimensions) {
      image.width = dimensions.width
      image.height = dimensions.height
    } else {
      image.removeAttribute('width')
      image.removeAttribute('height')
    }
  }
  image.onload = () => {
    if (!image.naturalWidth || !image.naturalHeight) return
    const dimensions = { context: previousContext, width: image.naturalWidth, height: image.naturalHeight }
    assets.dimensions.set(current, dimensions)
    setDimensions(dimensions)
    expand.hidden = false
  }
  image.onerror = () => { expand.hidden = true }
  const refresh = () => {
    const context = assets.context?.()
    if (request > 0 && previousContext === context) return
    previousContext = context
    const cached = assets.dimensions.get(current)
    setDimensions(cached?.context === context ? cached : undefined)
    const generation = ++request
    if (objectUrl) {
      closeExpanded?.()
      closeExpanded = undefined
      expand.hidden = true
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
  } else if (/^https?:\/\//i.test(src)) {
    setDimensions(assets.dimensions.get(current))
    image.src = src
  }

  let imagePress: PointerEvent | undefined
  let imageRelease: { event: PointerEvent; received: number } | undefined
  const now = () => document.defaultView!.performance.now()
  const isImageTap = (event: MouseEvent) => view.editable && !view.composing && event.button === 0
    && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
  const selectImage = () => {
    const pos = getPos()
    if (pos === undefined || view.state.doc.nodeAt(pos) !== current) return
    const selection = NodeSelection.create(view.state.doc, pos)
    if (!selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection))
    if (!view.hasFocus()) view.focus()
  }
  image.addEventListener('click', (event) => {
    if (isImageTap(event)) selectImage()
  })
  image.addEventListener('pointerdown', (event) => {
    if (!isImageTap(event) || event.pointerType !== 'mouse' || event.defaultPrevented) return
    const release = imageRelease
    imageRelease = undefined
    imagePress = undefined
    if (release && isReorderedPointerRelease(event, release.event, now() - release.received)) {
      event.preventDefault()
      selectImage()
    } else imagePress = event
  })
  image.addEventListener('pointerup', (event) => {
    if (!isImageTap(event) || event.pointerType !== 'mouse') return
    const down = imagePress
    imagePress = undefined
    if (!down) imageRelease = { event, received: now() }
    else if (down.pointerId === event.pointerId && down.timeStamp <= event.timeStamp &&
      !reachesDragThreshold(event.clientX - down.clientX, event.clientY - down.clientY)) selectImage()
  })
  const cancelImageTap = () => {
    imagePress = undefined
    imageRelease = undefined
  }
  image.addEventListener('pointercancel', cancelImageTap)
  const standaloneParagraph = () => dom.closest('p[data-standalone-image]')
  const openExpanded = () => {
    if (closeExpanded || expand.hidden || !standaloneParagraph()) return false
    closeExpanded = showExpandedPreview(expand, 'image', (content) => {
      const copy = document.createElement('img')
      copy.alt = image.alt
      copy.src = image.currentSrc || image.src
      copy.draggable = false
      content.append(copy)
    }, () => { closeExpanded = undefined })
    return true
  }
  expand.onclick = openExpanded
  image.ondblclick = (event) => {
    if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && openExpanded()) event.preventDefault()
  }
  dom.addEventListener('dragstart', (event) => {
    cancelImageTap()
    if (standaloneParagraph()) event.preventDefault()
  })

  const savedWidth = () => imageWidthPercent(current.attrs.widthPercent) ?? defaultImageWidth
  const clamp = (width: number) => Math.min(maxImageWidth, Math.max(minImageWidth, Math.round(width)))
  const ratio = document.createElement('span')
  ratio.className = 'editor-image-ratio'
  ratio.setAttribute('aria-hidden', 'true')
  dom.append(ratio)
  const handles = [-1, 1].map((side) => {
    const grip = document.createElement('button')
    grip.type = 'button'
    grip.className = 'editor-image-resize'
    grip.dataset.side = side < 0 ? 'left' : 'right'
    grip.dataset.pointerDragHandle = ''
    grip.title = `拖动调整宽度，双击恢复 ${defaultImageWidth}%`
    grip.setAttribute('role', 'slider')
    grip.setAttribute('aria-label', side < 0 ? '从左侧调整图片宽度' : '从右侧调整图片宽度')
    grip.setAttribute('aria-valuemin', String(minImageWidth))
    grip.setAttribute('aria-valuemax', String(maxImageWidth))
    dom.append(grip)
    return grip
  })
  const paint = (width: number) => {
    const percentage = width + '%'
    dom.style.setProperty('--editor-image-width', percentage)
    ratio.textContent = percentage
    for (const grip of handles) {
      grip.setAttribute('aria-valuenow', String(width))
      grip.setAttribute('aria-valuetext', percentage)
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
  let lastTap: { grip: HTMLButtonElement; event: PointerEvent } | undefined
  const registerTap = (grip: HTMLButtonElement, event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return
    const previous = lastTap?.event
    const elapsed = previous ? event.timeStamp - previous.timeStamp : Infinity
    if (previous && lastTap?.grip === grip && previous.pointerId === event.pointerId && elapsed > 0 && elapsed <= 500 &&
      !reachesDragThreshold(event.clientX - previous.clientX, event.clientY - previous.clientY)) {
      lastTap = undefined
      commit(defaultImageWidth)
    } else {
      lastTap = { grip, event }
    }
  }
  for (const [index, grip] of handles.entries()) {
    const direction = index === 0 ? -1 : 1
    let drag: { press: PointerEvent; available: number; initial: number; width: number; moved: boolean } | undefined
    let earlyRelease: { event: PointerEvent; received: number } | undefined
    grip.addEventListener('pointerdown', (event) => {
      if (!isImageTap(event) || drag) return
      const release = earlyRelease
      earlyRelease = undefined
      if (release && isReorderedPointerRelease(event, release.event, now() - release.received)) {
        // A delayed press can finish a handle tap without a native double-click.
        event.preventDefault()
        registerTap(grip, release.event)
        return
      }
      if (event.defaultPrevented) return
      const available = standaloneParagraph()?.getBoundingClientRect().width ?? 0
      if (!available) return
      event.preventDefault()
      const width = savedWidth()
      grip.setPointerCapture(event.pointerId)
      drag = { press: event, available, initial: width, width, moved: false }
      dom.setAttribute('data-resizing', '')
    })
    grip.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.press.pointerId || event.timeStamp < drag.press.timeStamp) return
      const dx = event.clientX - drag.press.clientX
      if (!drag.moved && !reachesDragThreshold(dx, 0, event.pointerType)) return
      drag.moved = true
      lastTap = undefined
      const width = clamp(drag.initial + 200 * direction * dx / drag.available)
      if (drag.width !== width) {
        drag.width = width
        paint(width)
      }
    })
    grip.addEventListener('pointerup', (event) => {
      if (!isImageTap(event)) return
      if (!drag) {
        if (event.pointerType === 'mouse') earlyRelease = { event, received: now() }
        return
      }
      if (event.pointerId !== drag.press.pointerId || event.timeStamp < drag.press.timeStamp) return
      const { width, moved, press } = drag
      drag = undefined
      dom.removeAttribute('data-resizing')
      if (moved) commit(width)
      else if (!reachesDragThreshold(event.clientX - press.clientX, event.clientY - press.clientY, event.pointerType)) {
        registerTap(grip, event)
      } else lastTap = undefined
    })
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === earlyRelease?.event.pointerId) earlyRelease = undefined
      if (!drag || event.pointerId !== drag.press.pointerId) return
      drag = undefined
      lastTap = undefined
      dom.removeAttribute('data-resizing')
      paint(savedWidth())
    }
    grip.addEventListener('pointercancel', cancel)
    grip.addEventListener('lostpointercapture', cancel)
    grip.ondblclick = (event) => {
      event.preventDefault()
      lastTap = undefined
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
    stopEvent: (event) => event.target === expand || (event.target instanceof Element && !!event.target.closest('.editor-image-resize')),
    update(next) {
      if (next.type !== current.type || next.attrs.src !== src || next.attrs.alt !== alt || next.attrs.title !== title) return false
      const dimensions = assets.dimensions.get(current)
      if (dimensions) assets.dimensions.set(next, dimensions)
      const changedWidth = current.attrs.widthPercent !== next.attrs.widthPercent
      current = next
      if (changedWidth) paint(savedWidth())
      return true
    },
    destroy() {
      disposed = true
      closeExpanded?.()
      assets.refreshers.delete(refresh)
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    },
  }
}
