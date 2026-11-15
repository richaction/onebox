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
  return {
    domNodes: view.dom.querySelectorAll('*').length,
    totalBlocks: view.state.doc.childCount,
    visibleBlocks: view.dom.querySelectorAll(':scope > .onebox-block[data-visible="true"]').length,
  }
}
