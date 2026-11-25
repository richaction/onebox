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
    const attachMap = (item: unknown) => item && typeof item === 'object' ? ({ ...item, map: mapName }) : item
    if (configuration.geo) configuration.geo = Array.isArray(configuration.geo)
      ? configuration.geo.map(attachMap) : attachMap(configuration.geo)
    const attachMapSeries = (item: unknown) => item && typeof item === 'object' && 'type' in item && item.type === 'map'
      ? attachMap(item) : item
    if (configuration.series) configuration.series = Array.isArray(configuration.series)
      ? configuration.series.map(attachMapSeries) : attachMapSeries(configuration.series)
  }
  if (tooltip) configuration.tooltip = (Array.isArray(tooltip) ? tooltip : [tooltip])
    .map((entry) => ({ ...entry, renderMode: 'richText' }))
  if (configuration.grid == null && configuration.xAxis && configuration.yAxis
    && !configuration.title && !configuration.legend && !configuration.dataZoom && !configuration.visualMap) {
    // Let ECharts fit the axis labels inside the canvas with its default overflow prevention.
    configuration.grid = { left: 10, right: 10, top: 12, bottom: 10 }
  }
  return { ...configuration, animation: false }
}

export function drawChart(target: HTMLElement, option: EChartsCoreOption, mapName: string, onClick?: () => void) {
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
    if (onClick) canvas.getZr().on('click', onClick)
  } catch (error) {
    dispose()
    throw error
  }
  const size = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect
    const nextWidth = Math.floor(width)
    const nextHeight = Math.floor(height)
    if (nextWidth > 0 && nextHeight > 0 && (nextWidth !== canvas.getWidth() || nextHeight !== canvas.getHeight())) {
      canvas.resize({ width: nextWidth, height: nextHeight })
    }
  })
  size.observe(target)
  return () => {
    size.disconnect()
    dispose()
  }
}
