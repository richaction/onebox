import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

GlobalWorkerOptions.workerSrc = workerUrl

const binaryAssets = import.meta.glob<string>([
  '/node_modules/pdfjs-dist/cmaps/*.bcmap',
  '/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
  '/node_modules/pdfjs-dist/wasm/*.wasm',
  '/node_modules/pdfjs-dist/wasm/*_nowasm_fallback.js',
], { query: '?url', import: 'default', eager: true, exhaustive: true })

const binaryFolders: Record<string, string> = {
  cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm',
}

class PdfBinaryData {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const asset = binaryAssets[`/node_modules/pdfjs-dist/${binaryFolders[kind]}/${filename}`]
    if (!asset) throw new Error(`Missing PDF data: ${filename}`)
    const response = await fetch(asset)
    if (!response.ok) throw new Error(`Could not load PDF data: ${filename}`)
    return new Uint8Array(await response.arrayBuffer())
  }
}

type OutlineItem = NonNullable<Awaited<ReturnType<PDFDocumentProxy['getOutline']>>>[number]

function PdfPage(props: {
  pdf: PDFDocumentProxy
  number: number
  width: number
  zoom: number
  aspect: number
  observe: (element: HTMLElement, update: (visible: boolean) => void) => () => void
}) {
  let element!: HTMLDivElement
  let canvas!: HTMLCanvasElement
  const [near, setNear] = createSignal(false)
  const [aspect, setAspect] = createSignal<number>()
  const [failed, setFailed] = createSignal(false)
  const pageWidth = () => Math.max(1, Math.min(props.width - 32, 1100) * props.zoom)

  onMount(() => onCleanup(props.observe(element, setNear)))
  createEffect(() => {
    const available = pageWidth()
    if (!near()) {
      canvas.width = 0
      canvas.height = 0
      return
    }
    let disposed = false
    let render: RenderTask | undefined
    onCleanup(() => { disposed = true; render?.cancel() })
    void props.pdf.getPage(props.number).then(async (page) => {
      if (disposed) return
      const natural = page.getViewport({ scale: 1 })
      setAspect(natural.width / natural.height)
      const scale = available / natural.width
      const dpi = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(12_000_000 / (available * available * natural.height / natural.width)))
      const viewport = page.getViewport({ scale: scale * dpi })
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      render = page.render({ canvas, viewport })
      await render.promise
    }).catch(() => { if (!disposed) setFailed(true) })
  })

  return (
    <div class="pdf-preview-page" ref={element} data-pdf-page={props.number}
      style={{ width: `${pageWidth()}px`, 'aspect-ratio': String(aspect() ?? props.aspect) }}>
      <canvas ref={canvas} hidden={!near()} aria-label={`PDF 第 ${props.number} 页`} />
      <Show when={failed()}><p class="file-preview-message">第 {props.number} 页无法渲染</p></Show>
    </div>
  )
}

function OutlineList(props: { items: OutlineItem[]; jump: (item: OutlineItem) => void }) {
  return (
    <ul><For each={props.items}>{(item) => (
      <li>
        <button type="button" disabled={!item.dest} onClick={() => props.jump(item)}>{item.title}</button>
        <Show when={item.items.length}><OutlineList items={item.items} jump={props.jump} /></Show>
      </li>
    )}</For></ul>
  )
}

export default function PdfPreview(props: {
  url: string
  onError: (message: string) => void
  outlineVisible: boolean
  onOutline: (available: boolean) => void
}) {
  let stage!: HTMLDivElement
  let pages!: HTMLDivElement
  let scrollFrame = 0
  let navigationFrame = 0
  let navigationTop: number | undefined
  const [pdf, setPdf] = createSignal<PDFDocumentProxy>()
  const [width, setWidth] = createSignal(0)
  const [aspect, setAspect] = createSignal(1 / Math.sqrt(2))
  const [outline, setOutline] = createSignal<OutlineItem[]>([])
  const [zoom, setZoom] = createSignal(1)
  const [page, setPage] = createSignal(1)
  const visibility = new Map<Element, (visible: boolean) => void>()
  let observer: IntersectionObserver | undefined

  const observe = (element: HTMLElement, update: (visible: boolean) => void) => {
    visibility.set(element, update)
    observer?.observe(element)
    return () => { observer?.unobserve(element); visibility.delete(element) }
  }

  onMount(() => {
    const resize = new ResizeObserver(() => setWidth(stage.clientWidth))
    resize.observe(stage)
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) visibility.get(entry.target)?.(entry.isIntersecting)
    }, { root: stage, rootMargin: '650px 0px' })
    const loading = getDocument({ url: props.url, useWorkerFetch: false, BinaryDataFactory: PdfBinaryData })
    let disposed = false
    void loading.promise.then(async (document) => {
      const first = await document.getPage(1)
      if (disposed) return
      const viewport = first.getViewport({ scale: 1 })
      setAspect(viewport.width / viewport.height)
      setPdf(document)
      const items = await document.getOutline().catch(() => [])
      if (disposed || !items?.length) return
      setOutline(items)
      props.onOutline(true)
    }).catch((error) => {
      if (!disposed) props.onError(error?.name === 'PasswordException' ? '此 PDF 需要密码，请用系统应用打开' : '无法载入 PDF')
    })
    onCleanup(() => {
      disposed = true
      cancelAnimationFrame(scrollFrame)
      cancelAnimationFrame(navigationFrame)
      resize.disconnect()
      observer?.disconnect()
      props.onOutline(false)
      void loading.destroy().catch(() => {})
    })
  })

  const goToPage = (number: number) => {
    const target = pages?.children[number - 1] as HTMLElement | undefined
    if (!target) return
    setPage(number)
    // The outline may have just opened and changed the available page width.
    setWidth(stage.clientWidth)
    cancelAnimationFrame(navigationFrame)
    navigationFrame = requestAnimationFrame(() => {
      stage.scrollTop = target.offsetTop
      navigationTop = stage.scrollTop
      setPage(number)
    })
  }

  const trackPage = () => {
    if (scrollFrame) return
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0
      if (!pages) return
      if (navigationTop === stage.scrollTop) return
      navigationTop = undefined
      const position = stage.scrollTop + Math.min(100, stage.clientHeight / 3)
      let low = 0
      let high = pages.children.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if ((pages.children[middle] as HTMLElement).offsetTop <= position) low = middle + 1
        else high = middle
      }
      setPage(stage.scrollTop > 0 && stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2
        ? pages.children.length : Math.max(1, low))
    })
  }

  const changeZoom = (value: number) => {
    const target = pages?.children[page() - 1] as HTMLElement | undefined
    const fraction = target ? (stage.scrollTop - target.offsetTop) / Math.max(1, target.offsetHeight) : 0
    setZoom(Math.max(0.5, Math.min(4, value)))
    if (target) {
      // Solid batches event handlers. Read the new page layout after the zoom style is applied.
      queueMicrotask(() => {
        stage.scrollTop = target.offsetTop + target.offsetHeight * fraction
        navigationTop = stage.scrollTop
      })
    }
  }

  const jump = async (item: OutlineItem) => {
    const document = pdf()
    if (!document || !item.dest) return
    const destination = typeof item.dest === 'string' ? await document.getDestination(item.dest) : item.dest
    const reference = destination?.[0]
    if (reference == null) return
    const index = typeof reference === 'number' ? reference : await document.getPageIndex(reference)
    goToPage(index + 1)
  }

  return (
    <div class="pdf-viewer">
      <Show when={pdf()}>
        {(document) => <div class="preview-controls" role="group" aria-label="分页预览控制">
          <button type="button" aria-label="上一页" disabled={page() <= 1} onClick={() => goToPage(page() - 1)}>‹</button>
          <output aria-label="页码">{page()} / {document().numPages}</output>
          <button type="button" aria-label="下一页" disabled={page() >= document().numPages} onClick={() => goToPage(page() + 1)}>›</button>
          <span class="preview-control-separator" aria-hidden="true" />
          <button type="button" aria-label="缩小" disabled={zoom() <= 0.5} onClick={() => changeZoom(zoom() / 1.25)}>−</button>
          <button type="button" aria-label="放大" disabled={zoom() >= 4} onClick={() => changeZoom(zoom() * 1.25)}>+</button>
          <button type="button" title="恢复适合宽度" onClick={() => changeZoom(1)}>{zoom() === 1 ? '适合宽度' : `${Math.round(zoom() * 100)}%`}</button>
        </div>}
      </Show>
      <div class="pdf-preview-layout">
        <Show when={props.outlineVisible && outline().length > 0}>
          <nav class="pdf-outline" aria-label="文档目录"><OutlineList items={outline()} jump={(item) => void jump(item).catch(() => {})} /></nav>
        </Show>
        <div class="pdf-preview-stage" ref={stage} aria-label="文档页面" tabindex="0" onScroll={trackPage}>
          <Show when={pdf()} keyed fallback={<p class="file-preview-message" role="status">正在载入 PDF…</p>}>
            {(document) => <div class="pdf-preview-pages" ref={pages}>
              <For each={Array.from({ length: document.numPages }, (_, index) => index + 1)}>{(number) => (
                <PdfPage pdf={document} number={number} width={width()} zoom={zoom()} aspect={aspect()} observe={observe} />
              )}</For>
            </div>}
          </Show>
        </div>
      </div>
    </div>
  )
}
