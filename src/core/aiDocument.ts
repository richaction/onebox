import type { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { Fragment, Slice, type Node as DocumentNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, Selection, TextSelection, type Transaction } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import { parseMarkdown, serializeMarkdown } from './markdown'

type Anchor = { from: number; to: number; original: Slice }
type AnchorEdit = { add?: [number, Anchor]; clear?: boolean }
const anchors = new PluginKey<ReadonlyMap<number, Anchor>>('onebox-ai-anchors')
let nextAnchor = 0

export function aiDocumentPlugin() {
  return new Plugin({
    key: anchors,
    state: {
      init: (): ReadonlyMap<number, Anchor> => new Map(),
      apply(tr, previous) {
        const edit = tr.getMeta(anchors) as AnchorEdit | undefined
        if (!edit && (!tr.docChanged || !previous.size)) return previous
        const next = new Map<number, Anchor>()
        if (!edit?.clear) {
          for (const [id, anchor] of previous) {
            if (!tr.docChanged) { next.set(id, anchor); continue }
            const start = tr.mapping.mapResult(anchor.from, 1)
            const end = tr.mapping.mapResult(anchor.to, anchor.from === anchor.to ? 1 : -1)
            if (!start.deletedAcross && !end.deletedAcross && start.pos <= end.pos) {
              next.set(id, { ...anchor, from: start.pos, to: end.pos })
            }
          }
        }
        if (edit?.add) next.set(...edit.add)
        return next
      },
    },
  })
}

export type AiReference = {
  label: string
  text: string
  anchor?: number
  page?: true
  external?: true
  shortened?: true
}

export type AiRevision = { markdown: string; reference: number | null }
export type AiUndo = { anchor: number; original: Slice; reference?: number }
const REFERENCE_LIMIT = 24_000
const PREVIEW_LIMIT = 120_000

function track(tr: Transaction, from: number, to: number, id = ++nextAnchor) {
  tr.setMeta(anchors, { add: [id, { from, to, original: tr.doc.slice(from, to) }] } satisfies AnchorEdit)
  return id
}

function resolve(editor: Editor, id: number | undefined) {
  const range = id === undefined ? undefined : anchors.getState(editor.state)?.get(id)
  if (range && editor.state.doc.slice(range.from, range.to).eq(range.original)) return range
}

function referenceText(doc: DocumentNode, from: number, to: number) {
  if (to - from > REFERENCE_LIMIT) {
    return doc.textBetween(from, Math.min(to, from + REFERENCE_LIMIT), '\n', ' ').slice(0, REFERENCE_LIMIT)
  }
  const slice = doc.slice(from, to)
  if (doc.resolve(from).sameParent(doc.resolve(to)) && doc.resolve(from).parent.isTextblock) {
    const paragraph = doc.type.schema.nodes.paragraph.create(null, slice.content)
    return serializeMarkdown(doc.copy(Fragment.from(paragraph)))
  }
  try { return serializeMarkdown(doc.copy(slice.content)) }
  catch { return doc.textBetween(from, to, '\n', ' ') }
}

export function captureAiReference(editor: Editor, kind: 'selection' | 'block' | 'page', title: string,
  range?: { from: number; to: number },
): AiReference | undefined {
  const { doc, selection, tr } = editor.state
  const { $from } = selection
  let { from, to } = kind === 'selection' && range ? range : selection
  if (kind === 'page') {
    const text = referenceText(doc, 0, doc.content.size)
    return text.trim() ? {
      label: title, page: true, text: text.slice(0, REFERENCE_LIMIT),
      shortened: doc.content.size > REFERENCE_LIMIT || text.length > REFERENCE_LIMIT ? true : undefined,
    } : undefined
  }
  if (kind === 'block') {
    const level = blockDepth($from)
    if (!level) return
    from = $from.before(level)
    to = $from.after(level)
  }
  if (from < 0 || from >= to || to > doc.content.size) return
  const text = referenceText(doc, from, to)
  if (!text.trim()) return
  const anchor = track(tr, from, to)
  editor.view.dispatch(tr.setMeta('addToHistory', false))
  return {
    label: kind === 'block' ? '当前区块' : '选中文字', anchor,
    text: text.slice(0, REFERENCE_LIMIT),
    shortened: to - from > REFERENCE_LIMIT || text.length > REFERENCE_LIMIT ? true : undefined,
  }
}

function blockDepth(position: ReturnType<DocumentNode['resolve']>) {
  if (!position.depth) return 0
  return Math.min(position.depth, position.node(1).type.name === 'viewportGroup' ? 2 : 1)
}

export function captureAiInsertion(editor: Editor) {
  const { selection, tr } = editor.state
  const $end = selection.$to
  const depth = blockDepth($end)
  const pos = depth ? $end.after(depth) : $end.pos
  const anchor = track(tr, pos, pos)
  editor.view.dispatch(tr.setMeta('addToHistory', false))
  return anchor
}

export function clearAiAnchors(editor: Editor) {
  if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(anchors, { clear: true }).setMeta('addToHistory', false))
}

export function jumpToAiReference(editor: Editor, reference: AiReference) {
  const { doc, tr } = editor.state
  const range = resolve(editor, reference.anchor)
  if (!reference.page && !range) return false
  const selection = range
    ? TextSelection.between(doc.resolve(range.from), doc.resolve(range.to))
    : Selection.atStart(doc)
  editor.view.dispatch(tr.setSelection(selection).scrollIntoView())
  editor.view.focus()
  return true
}

function change(editor: Editor, from: number, to: number, slice: Slice, trackUndo: boolean, reference?: number) {
  const { doc } = editor.state
  const original = doc.slice(from, to)
  const tr = closeHistory(editor.state.tr)
  const step = new ReplaceStep(from, to, slice)
  if (tr.maybeStep(step).failed || tr.doc.eq(doc)) return
  const anchor = trackUndo ? track(tr, from, from + slice.size)
    : reference === undefined ? 0 : track(tr, from, from + slice.size, reference)
  editor.view.dispatch(tr)
  editor.view.dispatch(closeHistory(editor.state.tr).setMeta('addToHistory', false))
  return { anchor, original, reference }
}

export function applyAiRevision(editor: Editor, revision: AiRevision, method: 'replace' | 'below', reference: AiReference | undefined, insertion: number) {
  if (!editor.isEditable || editor.view.composing || !revision.markdown.trim() || revision.markdown.length > PREVIEW_LIMIT) return
  const { doc, schema } = editor.state
  const range = resolve(editor, reference?.anchor)
  const parsed = parseMarkdown(revision.markdown, schema)
  if (method === 'replace') {
    if (!range || reference?.shortened) return
    const $start = doc.resolve(range.from)
    const $end = doc.resolve(range.to)
    if ($start.sameParent($end) && $start.parent.isTextblock) {
      if (parsed.childCount !== 1 || !parsed.firstChild?.isTextblock) return
      const content = $start.parent.type.spec.code ? Fragment.from(schema.text(revision.markdown)) : parsed.firstChild.content
      return change(editor, range.from, range.to, new Slice(content, 0, 0), true, reference?.anchor)
    }
    return change(editor, range.from, range.to, new Slice(parsed.content, range.original.openStart, range.original.openEnd), true, reference?.anchor)
  }
  const fallback = resolve(editor, insertion)
  if (!range && !fallback) return
  const $end = doc.resolve(range?.to ?? fallback!.to)
  const depth = range && $end.parent.type.name !== 'viewportGroup' ? blockDepth($end) : 0
  const pos = depth ? $end.after(depth) : $end.pos
  return change(editor, pos, pos, new Slice(parsed.content, 0, 0), true)
}

export function undoAiRevision(editor: Editor, undo: AiUndo) {
  if (!editor.isEditable || editor.view.composing) return false
  const range = resolve(editor, undo.anchor)
  return !!range && !!change(editor, range.from, range.to, undo.original, false, undo.reference)
}
