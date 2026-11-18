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
  aspect: number
  observe: (element: HTMLElement, update: (visible: boolean) => void) => () => void
}) {
  let element!: HTMLDivElement
  let canvas!: HTMLCanvasElement
  const [near, setNear] = createSignal(false)
  const [aspect, setAspect] = createSignal<number>()
  const [failed, setFailed] = createSignal(false)
  const pageWidth = () => Math.max(1, Math.min(props.width - 32, 1100))

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
  const [pdf, setPdf] = createSignal<PDFDocumentProxy>()
  const [width, setWidth] = createSignal(0)
  const [aspect, setAspect] = createSignal(1 / Math.sqrt(2))
  const [outline, setOutline] = createSignal<OutlineItem[]>([])
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
      resize.disconnect()
      observer?.disconnect()
      props.onOutline(false)
      void loading.destroy().catch(() => {})
    })
  })

  const jump = async (item: OutlineItem) => {
    const document = pdf()
    if (!document || !item.dest) return
    const destination = typeof item.dest === 'string' ? await document.getDestination(item.dest) : item.dest
    const reference = destination?.[0]
    if (reference == null) return
    const index = typeof reference === 'number' ? reference : await document.getPageIndex(reference)
    stage.querySelector(`[data-pdf-page="${index + 1}"]`)?.scrollIntoView({ block: 'start' })
  }

  return (
    <div class="pdf-preview-layout">
      <Show when={props.outlineVisible && outline().length > 0}>
        <nav class="pdf-outline" aria-label="PDF 目录"><OutlineList items={outline()} jump={(item) => void jump(item).catch(() => {})} /></nav>
      </Show>
      <div class="pdf-preview-stage" ref={stage} aria-label="PDF 页面" tabindex="0">
        <Show when={pdf()} keyed fallback={<p class="file-preview-message" role="status">正在载入 PDF…</p>}>
          {(document) => <For each={Array.from({ length: document.numPages }, (_, index) => index + 1)}>{(number) => (
            <PdfPage pdf={document} number={number} width={width()} aspect={aspect()} observe={observe} />
          )}</For>}
        </Show>
      </div>
    </div>
  )
}
