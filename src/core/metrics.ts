import type { EditorView } from '@tiptap/pm/view'

export interface Metrics {
  domNodes: number
  totalBlocks: number
  visibleBlocks: number
}

export interface ViewportMetrics {
  created: number
  destroyed: number
  transactions: number
  lastTransactionMs: number
  maxTransactionMs: number
}

export function collectMetrics(view: Pick<EditorView, 'state' | 'dom'>): Metrics {
  let totalBlocks = 0
  view.state.doc.forEach((block) => {
    totalBlocks += block.type.name === 'viewportGroup' ? block.childCount : 1
  })
  let visibleBlocks = 0
  for (const block of view.dom.querySelectorAll(':scope > .onebox-block[data-visible="true"]')) {
    const content = block.firstElementChild
    visibleBlocks += content?.classList.contains('viewport-group') ? content.children.length : 1
  }
  return {
    domNodes: view.dom.querySelectorAll('*').length,
    totalBlocks,
    visibleBlocks,
  }
}
