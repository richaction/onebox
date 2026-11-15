import { describe, expect, it } from 'vitest'
import { EditorState } from '@tiptap/pm/state'
import { collectMetrics } from '../src/core/metrics'
import { parseMarkdown } from '../src/core/markdown'
import { schema } from '../src/core/schema'

describe('collectMetrics', () => {
  it('counts total blocks, rendered content and descendant elements', () => {
    const dom = document.createElement('div')
    dom.innerHTML = '<div class="onebox-block" data-visible="true"><p>a</p></div>' +
      '<div class="onebox-block" data-visible="false"></div>'
    const state = EditorState.create({ doc: parseMarkdown('a\n\nb', schema) })
    expect(collectMetrics({ dom, state })).toEqual({ totalBlocks: 2, visibleBlocks: 1, domNodes: 3 })
  })
})
