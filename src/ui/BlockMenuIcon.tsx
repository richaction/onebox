import { Show } from 'solid-js'
import type { ChartTemplateKey } from '../core/chartTemplates'

const paths = {
  'ai-quote': 'M9 4.5H4a1 1 0 0 0-1 1V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V11 M12 17v-5 M12 3h5v5 M17 3l-7 7',
  'ai-edit': 'M4 12.5 13.5 3a1.4 1.4 0 0 1 2 0L17 4.5a1.4 1.4 0 0 1 0 2L7.5 16 3 17z M12 4.5l3.5 3.5 M4 12.5L7.5 16',
  charts: 'M4 3h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M6.5 13.5v-3 M10 13.5v-7 M13.5 13.5V9',
  bar: 'M3 17h14 M5 16.5V10h2.5v6.5 M9 16.5V5h2.5v11.5 M13 16.5V8h2.5v8.5',
  line: 'M3 4v13h14 M5.5 13l3-4 3 2 4.5-5',
  pie: 'M9 3a7 7 0 1 0 8 8H9z M11 3a6 6 0 0 1 6 6h-6z',
  scatter: 'M3 3v14h14 M6.5 12.5h.01 M7.5 7h.01 M10.5 10h.01 M13.5 6.5h.01 M15 11.5h.01',
  radar: 'M10 2.5l7.5 5.4-2.9 8.6H5.4L2.5 7.9z M10 6l4 2.9-1.6 4.4H7.8L6 9z M10 2.5V6',
  heatmap: 'M3 3h14v14H3z M3 7.7h14 M3 12.3h14 M7.7 3v14 M12.3 3v14 M9.4 5.3h1.2 M4.8 10h1.2 M14 14.7h1.3',
  candlestick: 'M5 4v3 M5 12v4 M3.5 7h3v5h-3z M10 2v4 M10 11v3 M8.5 6h3v5h-3z M15 5v4 M15 13v4 M13.5 9h3v4h-3z',
  boxplot: 'M7 2.5h6 M10 2.5V6 M6.5 6h7v8h-7z M6.5 9.5h7 M10 14v3.5 M7 17.5h6',
  treemap: 'M3 3h14v14H3z M9 3v14 M9 10h8 M13 10v7 M3 12h6',
  funnel: 'M3 4h14l-2 3H5z M5.5 9h9l-2 3h-5z M8 14h4l-.7 2h-2.6z',
  gauge: 'M3.5 14a6.5 6.5 0 1 1 13 0 M10 6.5v1.5 M5.2 9l1 1 M14.8 9l-1 1 M10 13.5l3-3.5 M9.5 14.5h1',
  sankey: 'M3 4h2v5H3z M3 12h2v4H3z M15 4h2v4h-2z M15 10h2v6h-2z M5 5h2c4 0 4 1 8 1 M5 8h1c4 0 5 4 9 4 M5 14h3c3 0 4 1 7 1',
  flowchart: 'M2.5 7h5v6h-5z M12.5 3h5v5h-5z M12.5 12h5v5h-5z M7.5 10H10V5.5h2.5 M10 10v4.5h2.5',
} satisfies Record<ChartTemplateKey | 'ai-quote' | 'ai-edit' | 'charts' | 'flowchart', string>

export default function BlockMenuIcon(props: { name: string }) {
  const path = () => Object.hasOwn(paths, props.name) ? paths[props.name as keyof typeof paths] : undefined
  return (
    <span class="block-menu-icon" aria-hidden="true">
      <Show when={path()} fallback={props.name}>
        {(draw) => <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.55"
          stroke-linecap="round" stroke-linejoin="round">
          <path d={draw()} />
        </svg>}
      </Show>
    </span>
  )
}
