import type { ViewerController, ViewerOptions, mountViewer } from '@file-viewer/web-full'
import { enableButtonClickTolerance, reachesDragThreshold } from '../core/buttonClickTolerance'
import { customizeArchivePreview } from './archivePreview'
import { createImageZoom, imageFit, isImagePreview, type ImagePreviewState } from './previewImage'
import './previewFrame.css'

const disableButtonClickTolerance = enableButtonClickTolerance(document)
import.meta.hot?.dispose(disableButtonClickTolerance)

const runtime = (window as Window & {
  FlyfishFileViewerWebFull?: { mountViewer: typeof mountViewer }
}).FlyfishFileViewerWebFull
const viewerHost = document.querySelector<HTMLElement>('#viewer')!
let viewer: ViewerController | undefined
let initialContent: MutationObserver | undefined
let previewLayout: ResizeObserver | undefined
let tiffPageLabel: MutationObserver | undefined
let stopArchiveLayout: (() => void) | undefined
let stopTextLayout: (() => void) | undefined
let reported = false

let imageZoom: ReturnType<typeof createImageZoom> | undefined
const imageContentSelector = '.image-stage img, .tiff-stage img'
const blockImageLightbox = (event: Event) => {
  if (event.target instanceof Element && event.target.matches(imageContentSelector)) {
    event.preventDefault()
    event.stopPropagation()
  }
}
const zoomImageWithWheel = (event: WheelEvent) => {
  const deltaY = event.deltaY
  if (event.defaultPrevented || !Number.isFinite(deltaY) || deltaY === 0 ||
    !(event.target instanceof Element) || !event.target.closest('.image-stage, .tiff-stage') ||
    Math.abs(deltaY) <= Math.abs(event.deltaX)) return
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewerHost.clientHeight : 1
  const delta = Math.min(180, Math.max(-180, deltaY * unit))
  if (imageZoom?.scaleBy(Math.exp(-delta * 0.002))) event.preventDefault()
}

const imageZoomStep = 1.2

const handleImageCommand = (action: unknown) => {
  if (!viewer) return
  switch (action) {
    case 'rotate':
      imageZoom?.cancel()
      void viewer.applyViewState({ rotation: ((viewer.getViewState()?.rotation ?? 0) + 90) % 360 }).catch(() => {})
      break
    case 'zoom-out': imageZoom?.scaleBy(1 / imageZoomStep); break
    case 'fit':
      imageZoom?.cancel()
      void viewer.fitToView(imageFit).catch(() => {})
      break
    case 'zoom-in': imageZoom?.scaleBy(imageZoomStep); break
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

const alignTextLayout = () => {
  if (stopTextLayout) return
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
  stopTextLayout = () => parent.removeEventListener('resize', update)
}

const markdownRenderer: ViewerOptions['renderers'] = {
  id: 'onebox-markdown',
  handlers: [{
    rendererId: 'markdown',
    async handler(buffer, target, _type, context) {
      const { createEditor } = await import('../core/editor')
      context?.signal?.throwIfAborted()
      alignTextLayout()

      const [firstByte, secondByte] = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 2))
      const encoding = firstByte === 0xff && secondByte === 0xfe ? 'utf-16le'
        : firstByte === 0xfe && secondByte === 0xff ? 'utf-16be' : 'utf-8'
      let markdown: string
      try {
        markdown = new TextDecoder(encoding, { fatal: true }).decode(buffer)
      } catch {
        markdown = new TextDecoder(context?.options?.text?.fallbackEncoding ?? encoding).decode(buffer)
      }

      const shell = document.createElement('div')
      shell.className = 'editor-shell onebox-markdown-preview'
      const scrollRoot = document.createElement('div')
      scrollRoot.className = 'editor-scroll'
      const element = document.createElement('div')
      element.className = 'editor-mount'
      scrollRoot.append(element)
      shell.append(scrollRoot)
      target.append(shell)
      const editor = createEditor({ element, scrollRoot, markdown, editable: false, onUpdate() {} })
      return {
        $el: shell,
        destroy() {
          editor.destroy()
          shell.remove()
        },
      }
    },
  }],
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
  handle.dataset.pointerDragHandle = ''
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
  let drag: { pointer: number; x: number; width: number; limits: ReturnType<typeof bounds>; moved: boolean } | undefined
  handle.addEventListener('pointerdown', (event) => {
    if (event.defaultPrevented || event.button !== 0 || drag) return
    drag = { pointer: event.pointerId, x: event.clientX, width: pane.offsetWidth, limits: bounds(), moved: false }
    handle.setPointerCapture(event.pointerId)
    handle.classList.add('is-resizing')
    event.preventDefault()
  })
  const finish = (event: PointerEvent) => {
    if (event.pointerId !== drag?.pointer) return
    drag = undefined
    handle.classList.remove('is-resizing')
  }
  handle.addEventListener('pointermove', (event) => {
    if (event.pointerId !== drag?.pointer) return
    if (!(event.buttons & 1)) { finish(event); return }
    const delta = drag.x - event.clientX
    if (!drag.moved && !reachesDragThreshold(delta, 0, event.pointerType)) return
    drag.moved = true
    setWidth(drag.width + delta, drag.limits)
  })
  handle.addEventListener('pointerup', finish)
  handle.addEventListener('pointercancel', finish)
  handle.addEventListener('lostpointercapture', finish)
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

const showArchiveSaveError = () => {
  const toolbar = viewerHost.querySelector('.ob-archive > .archive-preview > .archive-preview-toolbar')
  if (!toolbar || toolbar.querySelector('.ob-archive-save-error')) return
  const error = document.createElement('span')
  error.className = 'ob-archive-save-error'
  error.setAttribute('role', 'alert')
  error.textContent = '保存失败'
  toolbar.append(error)
  setTimeout(() => error.remove(), 4000)
}

// Document links stay inside the preview. Opening the original is a separate Onebox action.
const blockNavigation = (event: MouseEvent) => {
  const link = event.composedPath().find((target): target is Element =>
    target instanceof Element && target.matches('a[href], area[href]'))
  if (!link || link.getAttribute('href')?.startsWith('#')) return
  event.preventDefault()
  // The archive renderer appends its own export link directly to the frame body.
  if (event.type !== 'click' || !(link instanceof HTMLAnchorElement) ||
    link.parentElement !== document.body || !link.download ||
    !link.href.startsWith('blob:') || !viewerHost.querySelector('.ob-archive')) return
  const name = link.download
  void fetch(link.href).then((response) => response.arrayBuffer()).then((bytes) => {
    parent.postMessage({ type: 'onebox-preview-save-archive-entry', name, bytes }, '*', [bytes])
  }).catch(() => showArchiveSaveError())
}
document.addEventListener('click', blockNavigation, true)
document.addEventListener('auxclick', blockNavigation, true)
document.addEventListener('pointerdown', (event) => {
  if (event.button === 0) parent.postMessage('onebox-preview-interact', '*')
}, { capture: true, passive: true })
window.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return
  if (event.key === 'Escape') parent.postMessage('onebox-preview-close', '*')
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !event.isComposing && event.key.toLowerCase() === 's') {
    event.preventDefault()
    parent.postMessage('onebox-preview-save-hint', '*')
  }
})
window.addEventListener('pagehide', () => {
  imageZoom?.cancel()
  initialContent?.disconnect()
  previewLayout?.disconnect()
  tiffPageLabel?.disconnect()
  stopTextLayout?.()
  stopArchiveLayout?.()
  viewer?.destroy()
})

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== parent) return
  if (event.data?.type === 'onebox-preview-archive-save-error') {
    showArchiveSaveError()
    return
  }
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
  if (plainText) alignTextLayout()
  const imagePreview = isImagePreview(name)
  let imageState: ImagePreviewState | undefined
  const publishImageState = (state: ImagePreviewState) => {
    if (imageState && imageState.label === state.label && imageState.canZoomIn === state.canZoomIn &&
      imageState.canZoomOut === state.canZoomOut && imageState.pages === state.pages) return
    imageState = state
    parent.postMessage({ type: 'onebox-preview-image-state', state }, '*')
  }
  viewerHost.classList.toggle('preview-image', imagePreview)
  if (imagePreview) {
    const zoom = createImageZoom(viewerHost, () => viewer, publishImageState)
    imageZoom = zoom
    viewerHost.addEventListener('wheel', zoomImageWithWheel, { passive: false })
    window.addEventListener('resize', zoom.finish)
    viewerHost.addEventListener('pointerdown', zoom.finish, true)
    viewerHost.addEventListener('touchstart', (event) => {
      if (event.touches.length === 2) zoom.finish()
    }, { passive: true })
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
  let tiffMeter: Element | null | undefined
  const updateTiffPage = () => {
    const pages = tiffMeter?.textContent ?? undefined
    if (imageState) publishImageState({ ...imageState, pages })
  }
  viewer = runtime.mountViewer(viewerHost, {
    url,
    filename: name,
    options: {
      autoRenderers: false,
      renderers: markdownRenderer,
      styleIsolation: 'none',
      locale: 'zh-CN',
      toolbar: false,
      search: false,
      ai: false,
      drawing: { preferOfficial: false },
      zoomGestures: imagePreview && { wheel: false },
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
      messages: {
        'spreadsheet.state.rowsAndColumns': '共 {rows} 行 · {cols} 列',
        'archive.stats.summary': '{count} 个文件 · {size}',
        'archive.warning.encrypted': '此压缩包包含加密文件',
        'archive.preview.downloadFile': '另存为…',
      },
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
        publishImageState({ label, canZoomIn, canZoomOut, pages })
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
        const archive = viewerHost.querySelector<HTMLElement>('.archive-shell, .archive-viewer')
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
          if (archive && !/\.(epub|cbz|cbr|cb7|cbt)$/iu.test(name)) {
            stopArchiveLayout = customizeArchivePreview(archive)
          } else if (plainText) spacePlainTextParagraphs()
          else fitSlideSpacing()
          report('rendered')
        }
      }
    },
  })
})

parent.postMessage('onebox-preview-ready', '*')
