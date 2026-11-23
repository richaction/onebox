import { describe, expect, it } from 'vitest'
import { TOP_LEVEL_BLOCK_TYPES, schema } from '../src/core/schema'

describe('GFM schema', () => {
  it('registers the two supported inline HTML marks', () => {
    expect(Object.keys(schema.marks)).toContain('underline')
    expect(Object.keys(schema.marks)).toContain('highlight')
  })

  it('registers GFM marks', () => {
    for (const name of ['bold', 'italic', 'code', 'strike', 'link']) {
      expect(schema.marks[name], name).toBeDefined()
    }
  })

  it('registers every top-level block type', () => {
    for (const name of TOP_LEVEL_BLOCK_TYPES) {
      expect(schema.nodes[name], name).toBeDefined()
    }
  })

  it('registers tables, inline images and footnotes', () => {
    for (const name of ['table', 'tableCell', 'image', 'footnoteReference', 'footnoteDefinition']) {
      expect(schema.nodes[name], name).toBeDefined()
    }
    expect(schema.nodes.listItem.spec.attrs?.checked).toBeDefined()
  })

  it('uses Tiptap attribute names', () => {
    expect(schema.nodes.heading.spec.attrs?.level).toBeDefined()
    expect(schema.nodes.codeBlock.spec.attrs?.language).toBeDefined()
    expect(schema.nodes.orderedList.spec.attrs?.start).toBeDefined()
  })
})
