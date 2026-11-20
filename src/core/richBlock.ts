import type { EChartsCoreOption } from 'echarts/core'

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

async function loadMermaid() {
  const [{ default: mermaid }, { default: DOMPurify }] = await Promise.all([import('mermaid'), import('dompurify')])
  return { mermaid, DOMPurify }
}

function mermaidTheme(dark: boolean) {
  const surface = dark ? '#25282d' : '#f6f7f9'
  const border = dark ? '#6e7a8d' : '#78869a'
  const label = dark ? '#e6eaf0' : '#252c39'
  const accent = dark ? '#273950' : '#eaf1fa'
  return {
    darkMode: dark, fontFamily: 'system-ui, sans-serif', fontSize: '14px',
    background: dark ? '#191919' : '#ffffff',
    primaryColor: surface, primaryBorderColor: border, primaryTextColor: label,
    secondaryColor: accent, secondaryBorderColor: border, secondaryTextColor: label,
    tertiaryColor: surface, tertiaryBorderColor: border, tertiaryTextColor: label,
    lineColor: border, textColor: label, edgeLabelBackground: surface,
    actorBkg: accent, actorBorder: border, actorTextColor: label,
    signalColor: border, signalTextColor: label,
    clusterBkg: surface, clusterBorder: border,
  }
}

async function diagram(source: string) {
  if (source.length > 32_000) throw new Error('Mermaid 源码超过 32 KB')
  if (/^\s*---|%%\s*\{/u.test(source)) throw new Error('Mermaid 预览不支持覆盖渲染配置')
  if (/@import|url\s*\(/iu.test(source)) throw new Error('Mermaid 预览只支持本地绘制')
  const id = `onebox-diagram-${++nextDiagram}`
  const theme = document.documentElement.dataset.theme
  const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  const key = `${dark ? 'dark' : 'light'}:${source}`
  const cached = diagramCache.get(key)
  if (cached) return cached.svg.replaceAll(cached.id, id)
  const { mermaid, DOMPurify } = await (mermaidEngine ??= loadMermaid())
  // Pass an attached scratch container so Mermaid removes its error output with the container.
  const scratch = document.createElement('div')
  scratch.style.cssText = 'position:fixed;inset-inline-start:-10000px;visibility:hidden'
  document.body.append(scratch)
  try {
    const task = mermaidQueue.then(() => {
      if (mermaidDark !== dark) {
        mermaid.initialize({
          startOnLoad: false, securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true,
          maxTextSize: 32_000, maxEdges: 400, theme: 'base', look: 'classic',
          flowchart: { curve: 'rounded', nodeSpacing: 34, rankSpacing: 48 },
          themeVariables: mermaidTheme(dark),
        })
        mermaidDark = dark
      }
      return mermaid.render(id, source, scratch)
    })
    mermaidQueue = task.then(() => {}, () => {})
    const { svg } = await task
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

export function watchRichBlock(target: HTMLElement, language: RichLanguage, initial: string) {
  let source = initial
  let visible = false
  let revision = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposeChart: (() => void) | undefined
  const stop = () => {
    revision++
    clearTimeout(timer)
  }
  const clear = () => {
    disposeChart?.()
    disposeChart = undefined
    target.replaceChildren()
  }
  const render = async (expected: number) => {
    const value = source.trim()
    if (!value) {
      clear()
      target.textContent = '暂无预览'
      return
    }
    try {
      if (language === 'mermaid') {
        const svg = await diagram(value)
        if (expected === revision) {
          target.style.minBlockSize = ''
          target.innerHTML = svg
        }
      } else {
        if (value.length > 4_000_000) throw new Error('ECharts 数据超过 4 MB')
        const [option, { drawChart }] = await Promise.all([parseChart(value), import('./echartsEngine')])
        if (expected !== revision) return
        clear()
        // Reuse the name for this chart's inline GeoJSON between edits.
        disposeChart = drawChart(target, option, target.id)
      }
    } catch (error) {
      if (expected !== revision) return
      clear()
      target.textContent = '预览失败 · ' + (error instanceof Error ? error.message : String(error))
    }
  }
  const schedule = (delay: number) => {
    stop()
    if (visible) {
      const expected = revision
      timer = setTimeout(() => void render(expected), delay)
    }
  }
  const observer = new IntersectionObserver(([entry]) => {
    if (visible === entry.isIntersecting) return
    visible = entry.isIntersecting
    if (!visible) {
      if (language === 'mermaid' && target.firstElementChild) {
        target.style.minBlockSize = `${target.offsetHeight}px`
      }
      clear()
    }
    schedule(0)
  }, { rootMargin: '160px' })
  observer.observe(target)
  return {
    update(next: string) {
      if (source === next) return
      source = next
      schedule(350)
    },
    destroy() {
      observer.disconnect()
      stop()
      clear()
    },
  }
}
