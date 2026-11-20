const blockedKeys = new Set(['__proto__', 'prototype', 'constructor', 'image', 'link', 'sourcelink', 'targetlink'])

function validate(value: unknown, depth = 0): void {
  if (depth > 48) throw new Error('图表配置嵌套过深')
  if (typeof value === 'string' && /(?:image|url)\s*:\/\/|url\s*\(/iu.test(value)) {
    throw new Error('图表只支持内嵌数据和矢量图标')
  }
  if (Array.isArray(value)) {
    for (const item of value) validate(item, depth + 1)
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (blockedKeys.has(key.toLowerCase())) throw new Error('图表配置包含不支持的字段：' + key)
      validate(item, depth + 1)
    }
  }
}

self.onmessage = ({ data }: MessageEvent<{ id: number; source: string }>) => {
  const { source, id } = data
  try {
    const option = JSON.parse(source)
    if (!option || typeof option !== 'object' || Array.isArray(option)) throw new Error('需要一个 ECharts JSON 对象')
    validate(option)
    for (const series of Array.isArray(option.series) ? option.series : [option.series]) {
      if (series?.type === 'line' && Array.isArray(series.data) && series.data.length > 3_000) {
        series.sampling ??= 'lttb'
        series.showSymbol ??= false
      }
    }
    self.postMessage({ id, option })
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
}

export {}
