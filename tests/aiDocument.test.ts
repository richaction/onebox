import type { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { aiAnswerHtml, aiChangeText, decodeAiAnswer, partialAiAnswer } from '../src/core/aiAnswer'
import {
  applyAiRevision, captureAiInsertion, captureAiReference, jumpToAiReference, undoAiRevision,
} from '../src/core/aiDocument'
import { createEditor, type EditorHandle } from '../src/core/editor'

let handle: EditorHandle | undefined
let root: HTMLDivElement | undefined

function mount(text: string) {
  root = document.createElement('div')
  document.body.append(root)
  const element = document.createElement('div')
  root.append(element)
  handle = createEditor({ element, scrollRoot: root, markdown: text, onUpdate() {} })
  return handle.editor
}

function select(editor: Editor, text: string) {
  let start = -1
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text!.includes(text)) start = pos + node.text!.indexOf(text)
  })
  expect(start).toBeGreaterThan(0)
  editor.commands.setTextSelection({ from: start, to: start + text.length })
  return start
}

afterEach(() => {
  handle?.destroy()
  root?.remove()
  handle = undefined
})

describe('AI changes in Markdown', () => {
  it('quotes the range captured when the menu opened after the live selection collapses', () => {
    const editor = mount('Keep the quoted passage.')
    const from = select(editor, 'quoted passage')
    const to = editor.state.selection.to
    editor.commands.setTextSelection(1)
    const ref = captureAiReference(editor, 'selection', 'Draft.md', { from, to })!
    expect(ref.text).toBe('quoted passage')
    expect(editor.state.selection.empty).toBe(true)
  })

  it('tracks a reference through nearby edits and undoes only its own replacement', () => {
    const editor = mount('Keep this passage. Another sentence.')
    select(editor, 'this passage')
    const ref = captureAiReference(editor, 'selection', 'Draft.md')!
    const insertion = captureAiInsertion(editor)
    expect(ref.text).toBe('this passage')
    editor.view.dispatch(editor.state.tr.insertText('Please ', 1))

    const undo = applyAiRevision(editor, { markdown: '**this paragraph**', reference: 1 }, 'replace', ref, insertion)!
    expect(handle!.toMarkdown()).toBe('Please Keep **this paragraph**. Another sentence.')
    editor.view.dispatch(editor.state.tr.insertText('Later ', 1))
    expect(undoAiRevision(editor, undo)).toBe(true)
    expect(handle!.toMarkdown()).toBe('Later Please Keep this passage. Another sentence.')
    expect(jumpToAiReference(editor, ref)).toBe(true)
    expect(applyAiRevision(editor, { markdown: 'the original passage', reference: 1 }, 'replace', ref, insertion)).toBeDefined()
    expect(handle!.toMarkdown()).toBe('Later Please Keep the original passage. Another sentence.')
  })

  it('preserves a manually edited passage and does not undo a proposal after another edit inside it', () => {
    const editor = mount('Keep the target sentence.')
    const position = select(editor, 'target')
    const ref = captureAiReference(editor, 'selection', 'Draft.md')!
    const insertion = captureAiInsertion(editor)
    editor.view.dispatch(editor.state.tr.insertText('X', position + 2))
    expect(jumpToAiReference(editor, ref)).toBe(false)
    expect(applyAiRevision(editor, { markdown: 'updated', reference: 1 }, 'replace', ref, insertion)).toBeUndefined()
    expect(handle!.toMarkdown()).toBe('Keep the taXrget sentence.')

    const undo = applyAiRevision(editor, { markdown: '## A new section\n\nMore text', reference: null }, 'below', undefined, insertion)!
    expect(handle!.toMarkdown()).toContain('## A new section')
    const changed = select(editor, 'new section')
    editor.view.dispatch(editor.state.tr.insertText('manual ', changed + 4))
    expect(undoAiRevision(editor, undo)).toBe(false)
    expect(handle!.toMarkdown()).toContain('manual ')
  })

  it('inserts below a cited viewport-group block and supports normal editor undo', () => {
    const editor = mount('')
    handle!.loadBlocks(['One', 'Two'].map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })), true)
    select(editor, 'One')
    const ref = captureAiReference(editor, 'block', 'Draft.md')!
    const insertion = captureAiInsertion(editor)
    expect(applyAiRevision(editor, { markdown: 'New paragraph', reference: 1 }, 'below', ref, insertion)).toBeDefined()
    expect(handle!.toMarkdown()).toBe('One\n\nNew paragraph\n\nTwo')
    expect(editor.commands.undo()).toBe(true)
    expect(handle!.toMarkdown()).toBe('One\n\nTwo')
  })
})

describe('AI reply rendering', () => {
  it('keeps complete characters on each side of the change highlight', () => {
    expect(aiChangeText('状态 🟢 完成', '状态 🔵 完成')).toEqual({
      prefix: '状态 ', removed: '🟢', added: '🔵', suffix: ' 完成',
    })
  })

  it('streams a structured answer and exposes only valid citations as controls', () => {
    const reply = JSON.stringify({ answer: 'See [1]\n**note** [9]', revision: { reference: 1, markdown: 'Proposed edit' } })
    expect(partialAiAnswer(reply.slice(0, 25))).toContain('See [1]')
    expect(decodeAiAnswer(reply).revision?.markdown).toBe('Proposed edit')
    const html = aiAnswerHtml(decodeAiAnswer(reply).answer + '\n\n<img src=x> ![x](https://example.com/a)', 1)
    expect(html).toContain('data-reference="0"')
    expect(html).toContain('<strong>note</strong> [9]')
    expect(html).not.toContain('<img')
  })
})
