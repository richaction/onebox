import { describe, expect, it } from 'vitest'
import { TOP_LEVEL_BLOCK_TYPES, schema } from '../src/core/schema'

describe('GFM schema', () => {
  it('does not register underline (not GFM)', () => {
    expect(schema.marks.underline).toBeUndefined()
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

  it('does not register types deferred to later phases', () => {
    for (const name of ['table', 'taskList', 'taskItem', 'image']) {
      expect(schema.nodes[name], name).toBeUndefined()
    }
  })

  it('uses Tiptap attribute names', () => {
    expect(schema.nodes.heading.spec.attrs?.level).toBeDefined()
    expect(schema.nodes.codeBlock.spec.attrs?.language).toBeDefined()
    expect(schema.nodes.orderedList.spec.attrs?.start).toBeDefined()
  })
})