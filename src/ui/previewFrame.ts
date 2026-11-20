import type { ViewerController, mountViewer } from '@file-viewer/web-full'
import './previewFrame.css'

const runtime = (window as Window & {
  FlyfishFileViewerWebFull?: { mountViewer: typeof mountViewer }
}).FlyfishFileViewerWebFull
const viewerHost = document.querySelector<HTMLElement>('#viewer')!
let viewer: ViewerController | undefined
let initialContent: MutationObserver | undefined
let sheetLayout: ResizeObserver | undefined
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
  sheetLayout = new ResizeObserver(update)
  sheetLayout.observe(host)
  sheetLayout.observe(canvas)
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
  sheetLayout?.disconnect()
  viewer?.destroy()
})

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== parent || viewer || event.data?.type !== 'onebox-preview-source') return
  const { url, name } = event.data
  if (typeof url !== 'string' || typeof name !== 'string') return
  if (!runtime) {
    parent.postMessage('onebox-preview-error', '*')
    return
  }
  const plainText = /\.txt$/iu.test(name)
  viewerHost.classList.toggle('preview-plain-text', plainText)
  const imagePreview = /\.(png|jpe?g|svg|gif|webp|avif|bmp|ico|heic|heif|tiff?)$/iu.test(name)
  const zoomControls = imagePreview ? document.createElement('div') : undefined
  const zoomButton = zoomControls ? document.createElement('button') : undefined
  if (zoomControls && zoomButton) {
    zoomControls.className = 'image-zoom-controls'
    zoomButton.type = 'button'
    zoomButton.className = 'image-zoom-meter'
    zoomButton.title = '恢复到 100% 原始大小'
    zoomButton.addEventListener('click', () => {
      void viewer?.fitToView('actual').catch(() => {})
    })
    for (const [symbol, label, action] of [
      ['−', '缩小图片', 'zoomOut'],
      ['+', '放大图片', 'zoomIn'],
    ] as const) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = symbol
      button.title = label
      button.setAttribute('aria-label', label)
      button.addEventListener('click', () => { void viewer?.[action]().catch(() => {}) })
      zoomControls.append(button)
    }
    zoomControls.children[0].after(zoomButton)
  }
  if (imagePreview) {
    viewerHost.addEventListener('wheel', zoomImageWithWheel, { passive: false })
    viewerHost.addEventListener('click', blockImageLightbox, true)
    viewerHost.addEventListener('dblclick', blockImageLightbox, true)
    viewerHost.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') blockImageLightbox(event)
    }, true)
  }
  const spreadsheetPreview = /\.(xls[xmb]?|ods|csv|tsv|dbf)$/iu.test(name)
  const actualSize = imagePreview || /\.pdf$/iu.test(name)
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
      pdf: { darkMode: false, defaultNavigationVisible: false, zoomToolbar: false },
      fit: actualSize ? { mode: 'actual', resize: 'initial' }
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
      if (ready && zoomControls && zoomButton && zoom) {
        const label = `${zoom.label} · 恢复到 100% 原始大小`
        if (zoomButton.textContent !== zoom.label) {
          zoomButton.textContent = zoom.label
          zoomButton.setAttribute('aria-label', label)
        }
        if (!zoomControls.isConnected) {
          const toolbar = viewerHost.querySelector('.image-toolbar, .tiff-toolbar')
          toolbar?.setAttribute('aria-label', '图片工具栏')
          toolbar?.append(zoomControls)
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
        const pdf = viewerHost.querySelector('.pdf-shell')
        // Shell readiness can arrive before the first rows or the first PDF page.
        if (sheet) watchInitialContent(sheet, () => {
          if (sheet.querySelector('.error:not(.hidden)')) report('error')
          else if (!sheet.querySelector('.loading:not(.hidden)')) {
            centerWorksheet()
            report('rendered')
          }
        })
        else if (pdf) watchInitialContent(pdf, () => {
          if (pdf.querySelector('.pdf-state--error')) report('error')
          else if (pdf.querySelector('.page[data-loaded]:not(.loadingIcon) :is(canvas, .xfaLayer)')) report('rendered')
        })
        else report('rendered')
      }
    },
  })
})

parent.postMessage('onebox-preview-ready', '*')
