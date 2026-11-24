import { createPlateEditor } from 'platejs/react'
import { describe, expect, it, vi } from 'vitest'
import sample from '../examples/manual-testing/00 开始测试.md?raw'
import { preserveMarkdownSource } from '../src/react/editor/markdownSource'
import { editorPlugins, initMarkdown, serializeMarkdown } from '../src/react/editor/plugins'
import { SaveSession } from '../src/react/workspace/saveSession'

function load(markdown: string) {
  let supported = false
  const editor = createPlateEditor({ plugins: editorPlugins, value: (editor) => {
    const result = initMarkdown(editor, markdown)
    supported = result.supported
    return result.value
  } })
  return { editor, supported }
}

describe('Plate workspace', () => {
  it('round-trips the Onebox Markdown sample with headings, tables and tasks', () => {
    const { editor, supported } = load(sample)
    expect(supported).toBe(true)
    expect(editor.children.map(({ type }) => type)).toContain('table')
    expect(editor.children.some((node) => node.checked === false)).toBe(true)
    expect(preserveMarkdownSource(sample, serializeMarkdown(editor))).toBe(sample)
  })

  it('preserves unchanged source bytes and line endings when a block is edited', () => {
    const original = '# A ###\r\n\r\nold\r\n\r\n* item\r\n\r\n'
    expect(preserveMarkdownSource(original, '# A\n\nnew\n\n- item\n')).toBe(original.replace('old', 'new'))
  })

  it('does not open lossy HTML conversion as editable Markdown', () => {
    expect(load('<aside>Do not silently discard this</aside>\n').supported).toBe(false)
  })

  it('does not write an unedited, reverted or composing document', async () => {
    const read = vi.fn(async () => '# A ###\n')
    const write = vi.fn(async () => {})
    const document = { serialize: () => '# A\n', composing: () => false }
    const session = new SaveSession('sample.md', '# A ###\n', { read, write })
    expect(await session.flush()).toBe(true)
    expect(read).not.toHaveBeenCalled()
    session.document = { ...document, composing: () => true }
    session.markEdited()
    expect(await session.flush()).toBe(false)
    session.document = document
    expect(await session.flush()).toBe(true)
    expect(write).not.toHaveBeenCalled()
  })

  it('serializes concurrent writes and refuses to overwrite a file changed outside the editor', async () => {
    let source = 'First\n'
    const read = vi.fn(async () => source)
    const write = vi.fn(async (_path: string, markdown: string) => { source = markdown })
    const session = new SaveSession('sample.md', source, { read, write })
    session.document = { serialize: () => 'Second\n', composing: () => false }
    session.markEdited()
    const saving = session.flush()
    session.document = { serialize: () => 'Third\n', composing: () => false }
    session.markEdited()
    await Promise.all([saving, session.flush()])
    expect(write.mock.calls).toEqual([['sample.md', 'Second\n'], ['sample.md', 'Third\n']])
    source = 'External change\n'
    session.document = { serialize: () => 'Fourth\n', composing: () => false }
    session.markEdited()
    await expect(session.flush()).rejects.toThrow('磁盘上的文件已被修改')
    expect(source).toBe('External change\n')
    expect(session.dirty).toBe(true)
  })
})
