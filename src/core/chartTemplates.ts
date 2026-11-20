const months = ['一月', '二月', '三月', '四月', '五月']
const cartesian = { xAxis: { type: 'category', data: months }, yAxis: { type: 'value' } }
const values = [12, 19, 14, 23, 30]
const categories = months.map((name, index) => ({ name, value: values[index] }))

export const chartTemplates = [
  { label: '柱状图', key: 'bar', option: { ...cartesian, series: [{ type: 'bar', data: values }] } },
  { label: '折线图', key: 'line', option: { ...cartesian, series: [{ type: 'line', data: values }] } },
  { label: '饼图', key: 'pie', option: { series: [{ type: 'pie', radius: ['35%', '65%'], data: categories }] } },
  { label: '散点图', key: 'scatter', option: { xAxis: {}, yAxis: {}, series: [{ type: 'scatter', data: [[2, 5], [5, 4], [7, 11], [9, 8], [12, 15]] }] } },
  { label: '雷达图', key: 'radar', option: {
    radar: { indicator: ['速度', '质量', '成本', '稳定', '易用'].map((name) => ({ name, max: 100 })) },
    series: [{ type: 'radar', data: [{ value: [77, 83, 60, 92, 88] }] }],
  } },
  { label: '热力图', key: 'heatmap', option: {
    xAxis: cartesian.xAxis, yAxis: { type: 'category', data: ['上午', '下午'] },
    visualMap: { min: 0, max: 30, show: false },
    series: [{ type: 'heatmap', data: values.flatMap((value, i) => [[i, 0, value], [i, 1, 30 - value]]) }],
  } },
  { label: 'K 线图', key: 'candlestick', option: {
    ...cartesian, series: [{ type: 'candlestick', data: values.map((value) => [value, value + 4, value - 2, value + 6]) }],
  } },
  { label: '箱线图', key: 'boxplot', option: {
    ...cartesian, series: [{ type: 'boxplot', data: values.map((value) => [value - 5, value - 2, value, value + 3, value + 7]) }],
  } },
  { label: '矩形树图', key: 'treemap', option: { series: [{ type: 'treemap', data: categories }] } },
  { label: '漏斗图', key: 'funnel', option: { series: [{ type: 'funnel', data: categories }] } },
  { label: '仪表盘', key: 'gauge', option: { series: [{ type: 'gauge', data: [{ value: 72 }] }] } },
  { label: '桑基图', key: 'sankey', option: {
    series: [{ type: 'sankey', data: ['访问', '注册', '付费'].map((name) => ({ name })), links: [
      { source: '访问', target: '注册', value: 30 }, { source: '注册', target: '付费', value: 12 },
    ] }],
  } },
]
