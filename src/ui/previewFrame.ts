import type { ViewerController, mountViewer } from '@file-viewer/web-full'
import { imageFit, isImagePreview, type ImagePreviewState } from './previewImage'
import './previewFrame.css'

const runtime = (window as Window & {
  FlyfishFileViewerWebFull?: { mountViewer: typeof mountViewer }
}).FlyfishFileViewerWebFull
const viewerHost = document.querySelector<HTMLElement>('#viewer')!
let viewer: ViewerController | undefined
let initialContent: MutationObserver | undefined
let previewLayout: ResizeObserver | undefined
let tiffPageLabel: MutationObserver | undefined
let stopPlainTextLayout: (() => void) | undefined
let reported = false

let imageWheelDelta = 0
let lastImageWheel = 0
const imageContentSelector = '.image-stage img, .tiff-stage img'
const blockImageLightbox = (event: Event) => {
  if (event.target instanceof Element && event.target.matches(imageContentSelector)) {
    event.preventDefault()
    event.stopPropagation()
  }
}
const zoomImageWithWheel = (event: WheelEvent) => {
  if (!viewer || event.ctrlKey || event.metaKey || event.defaultPrevented ||
    !(event.target instanceof Element) || !event.target.closest('.image-stage, .tiff-stage') ||
    Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
  event.preventDefault()
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewerHost.clientHeight : 1
  if (event.timeStamp - lastImageWheel > 180 || Math.sign(event.deltaY) !== Math.sign(imageWheelDelta)) imageWheelDelta = 0
  lastImageWheel = event.timeStamp
  imageWheelDelta += event.deltaY * unit
  if (Math.abs(imageWheelDelta) < 40) return
  const zoom = imageWheelDelta < 0 ? viewer.zoomIn() : viewer.zoomOut()
  imageWheelDelta = 0
  void zoom.catch(() => {})
}

const handleImageCommand = (action: unknown) => {
  if (!viewer) return
  switch (action) {
    case 'rotate':
      void viewer.applyViewState({ rotation: ((viewer.getViewState()?.rotation ?? 0) + 90) % 360 }).catch(() => {})
      break
    case 'zoom-out': void viewer.zoomOut().catch(() => {}); break
    case 'fit': void viewer.fitToView(imageFit).catch(() => {}); break
    case 'zoom-in': void viewer.zoomIn().catch(() => {}); break
  }
}

const report = (kind: 'rendered' | 'error') => {
  initialContent?.disconnect()
  if (reported && kind === 'rendered') return
  reported = true
  parent.postMessage(`onebox-preview-${kind}`, '*')
}

const centerWorksheet = () => {
  const host = viewerHost.querySelector<HTMLElement>('.excel-wrapper .table-host')
  const canvas = host?.querySelector('canvas.e-virt-table-canvas')
  if (!host || !canvas) return
  const update = () => {
    const width = canvas.getBoundingClientRect().width
    if (width <= 0) return
    host.style.setProperty('--ob-sheet-width', `${width}px`)
    host.style.setProperty('--ob-sheet-inset', `${Math.max(0, (host.clientWidth - width) / 2)}px`)
  }
  update()
  previewLayout = new ResizeObserver(update)
  previewLayout.observe(host)
  previewLayout.observe(canvas)
}

const fitSlideSpacing = () => {
  const content = viewerHost.querySelector<HTMLElement>('.flyfish-pptx-content')
  const scaleBox = content?.closest('.flyfish-pptx-scale-box')
  if (!content || !scaleBox) return
  const update = () => {
    const scale = content.getBoundingClientRect().width / content.offsetWidth
    if (!Number.isFinite(scale) || scale <= 0) return
    const value = String(scale)
    if (content.style.getPropertyValue('--ob-slide-scale') !== value) content.style.setProperty('--ob-slide-scale', value)
  }
  update()
  previewLayout = new ResizeObserver(update)
  previewLayout.observe(scaleBox)
}

const alignPlainTextLayout = () => {
  // Use the window's text gutters even when the sidebar narrows the iframe.
  const update = () => {
    const theme = parent.getComputedStyle(parent.document.documentElement)
    for (const property of ['--ob-page-padding-block', '--ob-page-padding-inline']) {
      viewerHost.style.setProperty(property, theme.getPropertyValue(property))
    }
    viewerHost.style.setProperty('--ob-page-viewport-width', `${parent.innerWidth}px`)
  }
  update()
  parent.addEventListener('resize', update)
  stopPlainTextLayout = () => parent.removeEventListener('resize', update)
}

const spacePlainTextParagraphs = () => {
  const code = viewerHost.querySelector<HTMLElement>('.code-area code')
  const text = code?.textContent
  if (!code || !text) return
  // Leave very large previews with the renderer's streaming/virtual text layout.
  if (text.length > 256_000) return
  const parts = text.split(/(\r?\n(?:[\t ]*\r?\n)+)/u)
  if (parts.length === 1) return
  const content = document.createDocumentFragment()
  content.append(parts[0])
  for (let index = 1; index < parts.length; index += 2) {
    const gap = document.createElement('span')
    gap.className = 'plain-text-paragraph-gap'
    gap.textContent = parts[index]
    const extraLines = (parts[index].match(/\n/gu)?.length ?? 2) - 2
    if (extraLines > 0) gap.style.setProperty('--ob-extra-text-lines', String(extraLines))
    content.append(gap, parts[index + 1])
  }
  code.replaceChildren(content)
  document.addEventListener('copy', (event) => {
    const selection = document.getSelection()
    if (!selection?.rangeCount || selection.isCollapsed || !event.clipboardData) return
    if (!code.contains(selection.anchorNode) || !code.contains(selection.focusNode)) return
    // Copy the original line breaks without the browser's extra block separators.
    event.preventDefault()
    event.clipboardData.setData('text/plain', selection.getRangeAt(0).cloneContents().textContent ?? '')
  })
}

const enablePdfOutlineResize = (pdf: HTMLElement) => {
  const content = pdf.querySelector<HTMLElement>('.pdf-content')
  const pane = content?.querySelector<HTMLElement>('.pdf-nav-pane')
  if (!content || !pane) return
  const handle = document.createElement('div')
  handle.className = 'pdf-outline-resize'
  handle.tabIndex = 0
  handle.setAttribute('role', 'separator')
  handle.setAttribute('aria-label', '调整目录宽度')
  handle.setAttribute('aria-orientation', 'vertical')
  content.append(handle)

  const bounds = () => {
    const width = content.clientWidth
    return { min: Math.round(Math.min(132, width * 0.4)), max: Math.round(width * 0.6) }
  }
  const setWidth = (width: number, { min, max }: ReturnType<typeof bounds>) => {
    const next = Math.round(Math.min(max, Math.max(min, width)))
    content.style.setProperty('--ob-pdf-outline-width', `${next}px`)
    handle.setAttribute('aria-valuemin', String(min))
    handle.setAttribute('aria-valuemax', String(max))
    handle.setAttribute('aria-valuenow', String(next))
  }
  let drag: { pointer: number; x: number; width: number; limits: ReturnType<typeof bounds> } | undefined
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag) return
    drag = { pointer: event.pointerId, x: event.clientX, width: pane.offsetWidth, limits: bounds() }
    handle.setPointerCapture(event.pointerId)
    handle.classList.add('is-resizing')
    event.preventDefault()
  })
  handle.addEventListener('pointermove', (event) => {
    if (event.pointerId === drag?.pointer) setWidth(drag.width + drag.x - event.clientX, drag.limits)
  })
  handle.addEventListener('lostpointercapture', () => {
    drag = undefined
    handle.classList.remove('is-resizing')
  })
  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    setWidth(pane.offsetWidth + (event.key === 'ArrowLeft' ? 16 : -16), bounds())
  })
}

const watchInitialContent = (root: Element, check: () => void) => {
  initialContent = new MutationObserver(check)
  initialContent.observe(root, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'hidden', 'data-loaded'],
  })
  check()
}

// Document links stay inside the preview. Opening the original is a separate Onebox action.
const blockNavigation = (event: MouseEvent) => {
  const link = event.composedPath().find((target): target is Element =>
    target instanceof Element && target.matches('a[href], area[href]'))
  if (link && !link.getAttribute('href')?.startsWith('#')) event.preventDefault()
}
document.addEventListener('click', blockNavigation, true)
document.addEventListener('auxclick', blockNavigation, true)
window.addEventListener('keydown', (event) => {
  if (!event.defaultPrevented && event.key === 'Escape') parent.postMessage('onebox-preview-close', '*')
})
window.addEventListener('pagehide', () => {
  initialContent?.disconnect()
  previewLayout?.disconnect()
  tiffPageLabel?.disconnect()
  stopPlainTextLayout?.()
  viewer?.destroy()
})

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== parent) return
  if (event.data?.type === 'onebox-preview-image-command' && viewerHost.classList.contains('preview-image')) {
    handleImageCommand(event.data.action)
    return
  }
  if (event.data?.type === 'onebox-preview-pdf-outline' && viewer?.getViewState()?.renderer === 'pdf') {
    const visible = event.data.open === true
    void viewer.applyViewState({ navigation: { visible, mode: 'outline' } }, { action: 'navigation-toggle' }).catch(() => {})
    return
  }
  if (viewer || event.data?.type !== 'onebox-preview-source') return
  const { url, name } = event.data
  if (typeof url !== 'string' || typeof name !== 'string') return
  if (!runtime) {
    parent.postMessage('onebox-preview-error', '*')
    return
  }
  const plainText = /\.txt$/iu.test(name)
  viewerHost.classList.toggle('preview-plain-text', plainText)
  if (plainText) alignPlainTextLayout()
  const imagePreview = isImagePreview(name)
  viewerHost.classList.toggle('preview-image', imagePreview)
  if (imagePreview) {
    viewerHost.addEventListener('wheel', zoomImageWithWheel, { passive: false })
    viewerHost.addEventListener('click', blockImageLightbox, true)
    viewerHost.addEventListener('dblclick', blockImageLightbox, true)
    viewerHost.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') blockImageLightbox(event)
    }, true)
  }
  const spreadsheetPreview = /\.(xls[xmb]?|ods|csv|tsv|dbf)$/iu.test(name)
  const pdfPreview = /\.pdf$/iu.test(name)
  const legacyPresentation = /\.ppt$/iu.test(name)
  // PDF.js can request byte ranges on HTTP sources. The macOS asset scheme uses the buffered path.
  const pdfStreaming = pdfPreview && /^https?:/iu.test(url)
  let imageState: ImagePreviewState | undefined
  let tiffMeter: Element | null | undefined
  const updateTiffPage = () => {
    const pages = tiffMeter?.textContent ?? undefined
    if (!imageState || pages === imageState.pages) return
    imageState = { ...imageState, pages }
    parent.postMessage({ type: 'onebox-preview-image-state', state: imageState }, '*')
  }
  viewer = runtime.mountViewer(viewerHost, {
    url,
    filename: name,
    options: {
      autoRenderers: false,
      styleIsolation: 'none',
      locale: 'zh-CN',
      toolbar: false,
      search: false,
      ai: false,
      zoomGestures: imagePreview,
      image: imagePreview ? { handTool: true } : undefined,
      pdf: {
        darkMode: false, defaultNavigationVisible: false, toolbar: false, thumbnails: false,
        initialViewState: { navigation: { visible: false, mode: 'outline' } },
        streaming: pdfStreaming, disableStream: pdfStreaming, disableAutoFetch: pdfStreaming,
      },
      fit: imagePreview ? imageFit
        : pdfPreview || legacyPresentation ? { mode: 'width', maxScale: 1, padding: 12 }
          : spreadsheetPreview ? { mode: 'width', minScale: 1, maxScale: 1.25, resize: 'initial' }
            : undefined,
      docx: { externalLinkPolicy: 'block', externalResourcePolicy: 'block', renderAltChunks: false },
      text: plainText
        ? { fallbackEncoding: 'gb18030', toolbar: false, lineNumbers: false, wrapLongLines: true }
        : { fallbackEncoding: 'gb18030' },
      // In read-only previews the used range determines when scrolling is needed.
      spreadsheet: { fillViewport: false },
      messages: { 'spreadsheet.state.rowsAndColumns': '共 {rows} 行 · {cols} 列' },
    },
    onStateChange: ({ ready, error, zoom }) => {
      if (ready && imagePreview && zoom) {
        if (tiffMeter === undefined) {
          const tiffStage = viewerHost.querySelector('.tiff-stage')
          tiffMeter = tiffStage && tiffStage.childElementCount > 1 ? viewerHost.querySelector('.tiff-page-meter') : null
          if (tiffMeter) {
            tiffPageLabel = new MutationObserver(updateTiffPage)
            tiffPageLabel.observe(tiffMeter, { childList: true })
          }
        }
        const pages = tiffMeter?.textContent ?? undefined
        const { label, canZoomIn, canZoomOut } = zoom
        if (!imageState || label !== imageState.label || canZoomIn !== imageState.canZoomIn || canZoomOut !== imageState.canZoomOut || pages !== imageState.pages) {
          imageState = { label, canZoomIn, canZoomOut, pages }
          parent.postMessage({ type: 'onebox-preview-image-state', state: imageState }, '*')
        }
      }
      if (error) report('error')
      else if (ready && !reported && !initialContent) {
        if (imagePreview) viewerHost.querySelectorAll(imageContentSelector).forEach((image) => {
          image.removeAttribute('tabindex')
          image.removeAttribute('role')
          image.removeAttribute('aria-haspopup')
        })
        const sheet = viewerHost.querySelector('.excel-wrapper')
        const pdf = viewerHost.querySelector<HTMLElement>('.pdf-shell')
        // Shell readiness can arrive before the first rows or the first PDF page.
        if (sheet) watchInitialContent(sheet, () => {
          if (sheet.querySelector('.error:not(.hidden)')) report('error')
          else if (!sheet.querySelector('.loading:not(.hidden)')) {
            centerWorksheet()
            report('rendered')
          }
        })
        else if (pdf) {
          enablePdfOutlineResize(pdf)
          watchInitialContent(pdf, () => {
            if (pdf.querySelector('.pdf-state--error')) report('error')
            else if (pdf.querySelector('.pdfViewer .page')?.matches('[data-loaded]:not(.loadingIcon):has(canvas, .xfaLayer)')) report('rendered')
          })
        }
        else {
          if (plainText) spacePlainTextParagraphs()
          else fitSlideSpacing()
          report('rendered')
        }
      }
    },
  })
})

parent.postMessage('onebox-preview-ready', '*')
