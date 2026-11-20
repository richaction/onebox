import { init, registerMap, use, type EChartsCoreOption } from 'echarts/core'
import {
  BarChart, BoxplotChart, CandlestickChart, EffectScatterChart, FunnelChart, GaugeChart, GraphChart,
  HeatmapChart, LineChart, MapChart, ParallelChart, PictorialBarChart, PieChart, RadarChart, SankeyChart,
  ScatterChart, SunburstChart, ThemeRiverChart, TreeChart, TreemapChart,
} from 'echarts/charts'
import {
  AriaComponent, AxisPointerComponent, CalendarComponent, DataZoomComponent, DatasetComponent,
  GeoComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent,
  MarkPointComponent, ParallelComponent, PolarComponent, RadarComponent, SingleAxisComponent, TitleComponent,
  TooltipComponent, TransformComponent, VisualMapComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

use([
  BarChart, BoxplotChart, CandlestickChart, EffectScatterChart, FunnelChart, GaugeChart, GraphChart,
  HeatmapChart, LineChart, MapChart, ParallelChart, PictorialBarChart, PieChart, RadarChart, SankeyChart,
  ScatterChart, SunburstChart, ThemeRiverChart, TreeChart, TreemapChart,
  AriaComponent, AxisPointerComponent, CalendarComponent, DataZoomComponent, DatasetComponent,
  GeoComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent,
  MarkPointComponent, ParallelComponent, PolarComponent, RadarComponent, SingleAxisComponent, TitleComponent,
  TooltipComponent, TransformComponent, VisualMapComponent, CanvasRenderer,
])

export function chartConfiguration(option: EChartsCoreOption, mapName: string) {
  const { geoJSON, tooltip, ...configuration } = option
  if (geoJSON) {
    if (typeof geoJSON !== 'object' || !('type' in geoJSON) || geoJSON.type !== 'FeatureCollection') {
      throw new Error('地图需要内嵌的 GeoJSON FeatureCollection')
    }
    registerMap(mapName, geoJSON as Parameters<typeof registerMap>[1])
    const attachMap = (item: EChartsCoreOption) => { item.map = mapName }
    const geos = Array.isArray(configuration.geo) ? configuration.geo : [configuration.geo]
    geos.filter(Boolean).forEach(attachMap)
    const series = Array.isArray(configuration.series) ? configuration.series : [configuration.series]
    series.filter((item) => item?.type === 'map').forEach(attachMap)
  }
  if (tooltip) configuration.tooltip = (Array.isArray(tooltip) ? tooltip : [tooltip])
    .map((entry) => ({ ...entry, renderMode: 'richText' }))
  return { ...configuration, animation: false }
}

export function drawChart(target: HTMLElement, option: EChartsCoreOption, mapName: string) {
  const configuration = chartConfiguration(option, mapName)
  const preferred = document.documentElement.dataset.theme
  const dark = preferred === 'dark' || (preferred !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  const canvas = init(target, dark ? 'dark' : undefined, {
    renderer: 'canvas', devicePixelRatio: Math.min(devicePixelRatio, 2),
  })
  const dispose = () => {
    canvas.dispose()
    // ECharts retains registered maps after dispose. Drop the heavy GeoJSON for this chart.
    if (option.geoJSON) registerMap(mapName, { type: 'FeatureCollection', features: [] })
  }
  try {
    canvas.setOption(configuration)
  } catch (error) {
    dispose()
    throw error
  }
  const size = new ResizeObserver(() => canvas.resize())
  size.observe(target)
  return () => {
    size.disconnect()
    dispose()
  }
}
