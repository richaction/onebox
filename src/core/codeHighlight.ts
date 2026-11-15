import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { codeLanguage, type CodeToken } from './codeLanguages'

interface VisibleCode {
  container: HTMLElement
  code: HTMLElement
  node: ProseMirrorNode
  visible: boolean
  timer?: ReturnType<typeof setTimeout>
  ranges: [Highlight, Range][]
}

function paint(entry: VisibleCode, tokens: CodeToken[]) {
  const document = entry.code.ownerDocument
  const walker = document.createTreeWalker(entry.code, NodeFilter.SHOW_TEXT)
  const textNodes: { node: Text; start: number; end: number }[] = []
  let end = 0
  for (let text = walker.nextNode() as Text | null; text; text = walker.nextNode() as Text | null) {
    if (!text.length) continue
    textNodes.push({ node: text, start: end, end: end + text.length })
    end += text.length
  }
  let index = 0
  for (const [from, to, tone] of tokens) {
    while (index < textNodes.length && textNodes[index].end <= from) index++
    const first = textNodes[index]
    if (!first || to > end) break
    while (textNodes[index].end < to) index++
    const last = textNodes[index]
    const range = document.createRange()
    range.setStart(first.node, from - first.start)
    range.setEnd(last.node, to - last.start)
    const name = `onebox-code-${tone}`
    const highlight = CSS.highlights.get(name) ?? new Highlight()
    if (!CSS.highlights.has(name)) CSS.highlights.set(name, highlight)
    highlight.add(range)
    entry.ranges.push([highlight, range])
  }
}

function clear(entry: VisibleCode) {
  for (const [highlight, range] of entry.ranges) highlight.delete(range)
  entry.ranges.length = 0
}

export function createCodeHighlight(root: HTMLElement) {
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined' ||
      typeof Worker === 'undefined' || typeof IntersectionObserver === 'undefined') return

  const entries = new Map<Element, VisibleCode>()
  const queued = new Map<VisibleCode, ProseMirrorNode>()
  const cache = new WeakMap<ProseMirrorNode, CodeToken[]>()
  let active: { entry: VisibleCode; node: ProseMirrorNode } | undefined
  let worker: Worker | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let destroyed = false

  function finish(tokens: CodeToken[]) {
    clearTimeout(timeout)
    const job = active
    active = undefined
    if (job) {
      cache.set(job.node, tokens)
      if (job.entry.visible && job.entry.node === job.node && entries.has(job.entry.container) &&
          job.entry.code.textContent === job.node.textContent) {
        paint(job.entry, tokens)
      }
    }
    run()
  }

  function resetWorker() {
    worker?.terminate()
    worker = undefined
    finish([])
  }

  function run() {
    if (destroyed || active || !queued.size) return
    const [entry, node] = queued.entries().next().value!
    queued.delete(entry)
    active = { entry, node }
    try {
      if (!worker) {
        worker = new Worker(new URL('./codeHighlightWorker.ts', import.meta.url), { type: 'module' })
        worker.onmessage = ({ data }: MessageEvent<CodeToken[]>) => finish(data)
        worker.onerror = resetWorker
      }
      worker.postMessage({ language: codeLanguage(node.attrs.language).id, text: node.textContent })
      timeout = setTimeout(resetWorker, 2_500)
    } catch {
      resetWorker()
    }
  }

  function request(entry: VisibleCode, delay: number) {
    clearTimeout(entry.timer)
    queued.delete(entry)
    if (!entry.visible || !codeLanguage(entry.node.attrs.language).id ||
        !entry.node.content.size || entry.node.content.size > 12_000) return
    entry.timer = setTimeout(() => {
      if (!entry.visible || !entries.has(entry.container)) return
      const tokens = cache.get(entry.node)
      if (tokens) {
        if (entry.code.textContent === entry.node.textContent) paint(entry, tokens)
      } else if (active?.entry !== entry || active.node !== entry.node) {
        queued.set(entry, entry.node)
        run()
      }
    }, delay)
  }

  const observer = new IntersectionObserver((changes) => {
    for (const { target, isIntersecting } of changes) {
      const entry = entries.get(target)
      if (!entry || entry.visible === isIntersecting) continue
      entry.visible = isIntersecting
      if (!isIntersecting) clear(entry)
      request(entry, 0)
    }
  }, { root, rootMargin: '120px 0px' })

  return {
    watch(container: HTMLElement, code: HTMLElement, node: ProseMirrorNode) {
      const entry: VisibleCode = { container, code, node, visible: false, ranges: [] }
      entries.set(container, entry)
      observer.observe(container)
      return {
        update(next: ProseMirrorNode) {
          if (next === entry.node) return
          entry.node = next
          clear(entry)
          request(entry, 120)
        },
        destroy() {
          observer.unobserve(container)
          clearTimeout(entry.timer)
          clear(entry)
          queued.delete(entry)
          entries.delete(container)
        },
      }
    },
    destroy() {
      destroyed = true
      clearTimeout(timeout)
      observer.disconnect()
      for (const entry of entries.values()) {
        clearTimeout(entry.timer)
        clear(entry)
      }
      worker?.terminate()
      queued.clear()
      entries.clear()
    },
  }
}
