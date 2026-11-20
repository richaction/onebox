// @vitest-environment node
import { readFileSync } from 'node:fs'
import { init, use } from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import { expect, it, vi } from 'vitest'
import { chartConfiguration } from '../src/core/echartsEngine'

use([SVGRenderer])

const examples = readFileSync(new URL('../examples/manual-testing/01 编辑器/图表数字与公式.md', import.meta.url), 'utf8')
const chartExamples = [...examples.matchAll(/^## (.+)\n\n```echarts\n([\s\S]*?)\n```/gmu)]
  .map(([, label, source]) => [label, source] as const)

it.each(chartExamples)('renders %s to SVG', (_label, source) => {
  const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 640, height: 320 })
  try {
    chart.setOption(chartConfiguration(JSON.parse(source), 'onebox-test-map'))
    expect(chart.renderToSVGString()).toMatch(/<(?:path|rect|circle)\b/)
  } finally {
    chart.dispose()
  }
})

it('parses 50,000 values in the worker, samples dense lines, and rejects unsafe keys', async () => {
  const postMessage = vi.fn()
  const scope = { postMessage, onmessage: (_event: { data: object }) => {} }
  vi.stubGlobal('self', scope)
  try {
    await import('../src/core/chartData.worker')
    const data = Array.from({ length: 50_000 }, (_, index) => [index, Math.sin(index)])
    scope.onmessage({ data: { id: 1, source: JSON.stringify({ series: [{ type: 'line', data }] }) } })
    const { option } = postMessage.mock.lastCall?.[0]
    expect(option.series[0]).toMatchObject({ sampling: 'lttb', showSymbol: false })
    expect(option.series[0].data).toHaveLength(50_000)
    const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 640, height: 320 })
    try {
      chart.setOption(chartConfiguration({ ...option, xAxis: { type: 'value' }, yAxis: {} }, 'onebox-dense-test'))
      const svg = chart.renderToSVGString()
      expect(svg).toContain('<path')
      expect(svg.length).toBeLessThan(180_000)
    } finally {
      chart.dispose()
    }
    scope.onmessage({ data: { id: 2, source: '{"series":[{"__proto__":{"unsafe":1}}]}' } })
    expect(postMessage.mock.lastCall?.[0]).toMatchObject({ id: 2, error: expect.any(String) })
  } finally {
    vi.unstubAllGlobals()
  }
})
