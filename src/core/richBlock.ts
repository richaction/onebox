import type { EChartsCoreOption } from 'echarts/core'
import { unwrapMermaidFence } from './mermaidFence'
import { paintPreview } from './previewPaint'
import { showExpandedPreview } from './expandedPreview'

type RichLanguage = 'echarts' | 'mermaid'

export function richLanguage(info: string): RichLanguage | undefined {
  const language = info.trim().split(/\s/u, 1)[0].toLowerCase()
  if (language === 'echarts' || language === 'mermaid') return language
}

let worker: Worker | undefined
let nextRequest = 0
const pending = new Map<number, { resolve: (option: EChartsCoreOption) => void; reject: (error: Error) => void }>()

function parseChart(source: string) {
  if (!worker) {
    worker = new Worker(new URL('./chartData.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }) => {
      const request = pending.get(data.id)
      pending.delete(data.id)
      if (data.error) request?.reject(new Error(data.error))
      else request?.resolve(data.option)
    }
    worker.onerror = () => {
      for (const request of pending.values()) request.reject(new Error('图表数据解析失败'))
      pending.clear()
      worker?.terminate()
      worker = undefined
    }
  }
  const id = ++nextRequest
  const activeWorker = worker
  return new Promise<EChartsCoreOption>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      activeWorker.postMessage({ id, source })
    } catch (error) {
      pending.delete(id)
      reject(error)
    }
  })
}

let mermaidEngine: ReturnType<typeof loadMermaid> | undefined
let nextDiagram = 0
let mermaidQueue = Promise.resolve()
let mermaidDark: boolean | undefined
const diagramCache = new Map<string, { svg: string; id: string }>()
// Keep ordinary flowchart and state nodes in the same palette as Redux sequence participants.
const reduxPalette = [
  ['#E879F9', '#FDF4FF'], ['#2DD4BF', '#F0FDFA'], ['#FB923C', '#FFF7ED'], ['#22D3EE', '#ECFEFF'],
]
const flowchartNode = '.node[id*="-flowchart-"][data-look="neo"]'
const stateNode = '.node.statediagram-state[data-look="neo"]'

async function loadMermaid() {
  const [{ default: mermaid }, { default: DOMPurify }] = await Promise.all([import('mermaid'), import('dompurify')])
  return { mermaid, DOMPurify }
}

async function diagram(source: string, isCurrent: () => boolean, target: HTMLElement) {
  if (source.length > 32_000) throw new Error('Mermaid 源码超过 32 KB')
  if (/%%\s*\{/u.test(source)) throw new Error('请用代码块开头的 YAML 指定 Mermaid 标题或布局')
  if (/@import|url\s*\(/iu.test(source)) throw new Error('Mermaid 预览只支持本地绘制')
  const id = `onebox-diagram-${++nextDiagram}`
  const theme = document.documentElement.dataset.theme
  const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  const key = `${dark ? 'dark' : 'light'}:${source}`
  const cached = diagramCache.get(key)
  if (cached) return cached.svg.replaceAll(cached.id, id)
  const { mermaid, DOMPurify } = await (mermaidEngine ??= loadMermaid())
  const prepared = /^---[ \t]*(?:\r?\n|$)/u.test(source)
    ? (await import('./mermaidSource')).prepareMermaidSource(source) : source
  if (!isCurrent()) return
  // Pass an attached scratch container so Mermaid removes its error output with the container.
  const scratch = document.createElement('div')
  scratch.style.cssText = 'position:fixed;inset-inline-start:-10000px;visibility:hidden'
  document.body.append(scratch)
  try {
    const task = mermaidQueue.then(() => {
      if (!isCurrent()) return
      if (mermaidDark !== dark) {
        mermaid.initialize({
          startOnLoad: false, securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true,
          maxTextSize: 32_000, maxEdges: 400,
          theme: dark ? 'redux-dark-color' : 'redux-color', look: 'neo',
          // Gantt derives its width from the hidden render container by default.
          gantt: { useWidth: 900 },
          themeCSS: reduxPalette.map(([stroke, lightFill], index) => {
            const fill = dark ? `color-mix(in srgb, ${stroke} 16%, #111113)` : lightFill
            const slot = `:nth-of-type(4n+${index + 1})`
            return `.nodes > ${flowchartNode}${slot} > .label-container,
              .nodes > ${stateNode}${slot} rect:is(.basic, .title-state) { fill: ${fill}; stroke: ${stroke}; }`
          }).join('\n') + `
            .nodes > ${flowchartNode} > rect.label-container:is(:not([rx]), [rx="0"]) { rx: 5px; ry: 5px; }
            .root:has(> .edgePaths .flowchart-link) > .edgeLabels .edgeLabel rect.background {
              fill: ${dark ? '#27252e' : '#fffdfa'};
              opacity: 1;
              rx: 4px;
            }
            .grid .tick line { opacity: 0.25; }
            line.today { stroke: ${dark ? '#a5b4fc' : '#5163a3'}; stroke-width: 1px; stroke-dasharray: 4 3; }
          `,
        })
        mermaidDark = dark
      }
      return paintPreview(() => isCurrent() ? mermaid.render(id, prepared, scratch) : undefined, target)
    })
    mermaidQueue = task.then(() => {}, () => {})
    const result = await task
    if (!result || !isCurrent()) return
    const { svg } = result
    const safe = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['foreignObject', 'image', 'a'],
      FORBID_ATTR: ['href', 'xlink:href'],
    })
    if (safe.length < 500_000) {
      if (diagramCache.size >= 12) diagramCache.delete(diagramCache.keys().next().value!)
      diagramCache.set(key, { svg: safe, id })
    }
    return safe
  } finally {
    scratch.remove()
  }
}

export function watchRichBlock(target: HTMLElement, language: RichLanguage, initial: string, previewTrigger: HTMLButtonElement, mermaid?: {
  visibilityTarget: HTMLElement
  report: (message: string) => void
}) {
  let source = initial
  let visible = false
  let revision = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposeChart: (() => void) | undefined
  let lastDiagram: string | undefined
  let renderedSource: string | undefined
  let drawExpanded: Parameters<typeof showExpandedPreview>[2] | undefined
  let closeExpanded: (() => void) | undefined
  const setExpandedDrawing = (draw?: typeof drawExpanded) => {
    drawExpanded = draw
    previewTrigger.disabled = !draw
    target.toggleAttribute('data-expandable', !!draw)
  }
  const openExpanded = () => {
    if (!drawExpanded || closeExpanded) return
    closeExpanded = showExpandedPreview(previewTrigger, language, drawExpanded, () => { closeExpanded = undefined })
  }
  setExpandedDrawing()
  previewTrigger.onclick = openExpanded
  const stop = () => {
    revision++
    clearTimeout(timer)
  }
  const clear = () => {
    disposeChart?.()
    disposeChart = undefined
    setExpandedDrawing()
    target.replaceChildren()
  }
  const showDiagram = (svg?: string) => {
    if (!svg) {
      target.textContent = '暂无预览'
    } else if (svg !== lastDiagram || !target.firstElementChild) {
      const { scrollTop, scrollLeft } = target
      target.innerHTML = svg
      target.scrollTop = scrollTop
      target.scrollLeft = scrollLeft
    }
    lastDiagram = svg
    const id = target.firstElementChild?.id
    setExpandedDrawing(svg && id ? (content) => { content.innerHTML = svg.replaceAll(id, `${id}-expanded`) } : undefined)
  }
  const render = async (expected: number) => {
    const input = source
    const value = input.trim()
    const isCurrent = () => expected === revision
    if (!value) {
      if (mermaid && lastDiagram) {
        showDiagram(lastDiagram)
        mermaid.report('请输入 Mermaid 源码 · 保留上次预览')
        return
      }
      clear()
      showDiagram()
      mermaid?.report('')
      return
    }
    try {
      if (language === 'mermaid') {
        const svg = await diagram(unwrapMermaidFence(input) ?? value, isCurrent, target)
        if (svg && isCurrent()) {
          showDiagram(svg)
          mermaid?.report('')
        }
      } else {
        if (value.length > 4_000_000) throw new Error('ECharts 数据超过 4 MB')
        const [option, { drawChart }] = await Promise.all([parseChart(value), import('./echartsEngine')])
        await paintPreview(() => {
          if (!isCurrent()) return
          clear()
          // Reuse the name for this chart's inline GeoJSON between edits.
          disposeChart = drawChart(target, option, target.id, openExpanded)
          setExpandedDrawing((content) => drawChart(content, option, `${target.id}-expanded`))
        }, target)
      }
    } catch (error) {
      if (!isCurrent()) return
      if (mermaid) {
        const { mermaidErrorMessage } = await import('./mermaidSource')
        if (!isCurrent()) return
        showDiagram(lastDiagram)
        const message = mermaidErrorMessage(error, input)
        mermaid.report(lastDiagram ? `${message} · 保留上次预览` : message)
        return
      }
      clear()
      target.textContent = '预览失败 · ' + (error instanceof Error ? error.message : String(error))
    }
  }
  const schedule = (delay: number) => {
    stop()
    if (visible && source !== renderedSource) {
      const expected = revision
      const input = source
      timer = setTimeout(() => {
        void render(expected).then(() => {
          if (expected === revision) renderedSource = input
        })
      }, delay)
    }
  }
  const observer = new IntersectionObserver(([entry]) => {
    if (visible === entry.isIntersecting) return
    visible = entry.isIntersecting
    // Leave the finished preview mounted. The editor tears down the node view
    // when it leaves the viewport of a large document or the document closes.
    schedule(0)
  }, { rootMargin: '160px' })
  observer.observe(mermaid?.visibilityTarget ?? target)
  return {
    update(next: string) {
      if (source === next) return
      source = next
      schedule(mermaid ? 300 : 350)
    },
    destroy() {
      observer.disconnect()
      stop()
      closeExpanded?.()
      clear()
    },
  }
}
