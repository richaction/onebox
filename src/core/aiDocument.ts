import type { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { DOMSerializer, Fragment, Slice, type Node as DocumentNode } from '@tiptap/pm/model'
import { diffArrays } from 'diff'
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { aiAnswerHtml } from './aiAnswer'
import { parseMarkdown, serializeMarkdown } from './markdown'

type Anchor = { from: number; to: number; original: Slice }
type AnchorEdit = { add?: [number, Anchor]; remove?: number; clear?: boolean }
type InlineChange = { value: DocumentNode[]; added?: boolean; removed?: boolean }
type InlineChangeRun = { offset: number; parts: readonly InlineChange[] }
type BlockAddition = { offset: number; blocks: DocumentNode[] }
type PreviewOwner = number | symbol
type DraftPreview = { id: number; html: string; method: AiRevisionMethod; reference?: AiReference; insertion: number; inDocument?: true }
type InlineSource = {
  owner: PreviewOwner
  anchor?: number
  changes?: { runs: InlineChangeRun[]; additions?: BlockAddition[] }
  draft?: DraftPreview
}
const anchors = new PluginKey<ReadonlyMap<number, Anchor>>('onebox-ai-anchors')
const inlineSource = new PluginKey<InlineSource | null>('onebox-ai-inline-source')
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
        if (edit?.remove !== undefined) next.delete(edit.remove)
        return next
      },
    },
  })
}

export function aiInlineSourcePlugin() {
  return new Plugin<InlineSource | null>({
    key: inlineSource,
    state: {
      init: () => null,
      apply(tr, previous) {
        const next = tr.getMeta(inlineSource) as InlineSource | null | undefined
        return next === undefined ? previous : next
      },
    },
    props: {
      decorations(state) {
        const source = this.getState(state)
        if (source?.draft) return draftDecorations(state, source.draft)
        const anchor = resolveAnchor(state, source?.anchor)
        if (!anchor || anchor.from === anchor.to) return DecorationSet.empty
        if (source?.changes) {
          const decorations = typeof source.owner === 'number' ? [reviewAnchor(state, anchor.from)] : []
          for (const { offset, parts } of source.changes.runs) {
            let position = anchor.from + offset
            for (const part of parts) {
              if (!part.value.length) continue
              if (part.added) {
                decorations.push(addedContent(position, part.value))
              } else {
                const end = position + part.value.reduce((size, node) => size + node.nodeSize, 0)
                if (part.removed) decorations.push(Decoration.inline(position, end, { class: 'editor-ai-removed' }))
                position = end
              }
            }
          }
          for (const { offset, blocks } of source.changes.additions ?? []) {
            decorations.push(addedContent(anchor.from + offset, blocks, true))
          }
          return DecorationSet.create(state.doc, decorations)
        }
        return DecorationSet.create(state.doc, [Decoration.inline(anchor.from, anchor.to, { class: 'editor-ai-source' })])
      },
    },
  })
}

function addedContent(position: number, nodes: DocumentNode[], block = false) {
  return Decoration.widget(position, (view) => {
    const document = view.dom.ownerDocument
    const inserted = document.createElement(block ? 'div' : 'ins')
    inserted.className = block ? 'editor-ai-block-change' : 'editor-ai-added'
    const serializer = DOMSerializer.fromSchema(view.state.schema)
    if (block) {
      for (const node of nodes) {
        const paragraph = serializer.serializeNode(node, { document })
        const highlight = document.createElement('ins')
        highlight.className = 'editor-ai-added'
        highlight.append(...Array.from(paragraph.childNodes))
        paragraph.appendChild(highlight)
        inserted.appendChild(paragraph)
      }
    } else {
      inserted.append(serializer.serializeFragment(Fragment.fromArray(nodes), { document }))
    }
    return inserted
  }, { side: -1, ignoreSelection: true })
}

export function highlightAiSource(editor: Editor, anchor: number) {
  const { doc, tr } = editor.state
  const range = resolve(editor, anchor)
  if (!range) return
  const end = doc.resolve(range.to)
  const cursor = Selection.findFrom(end, -1, true) ?? Selection.findFrom(end, 1, true)
  if (cursor) tr.setSelection(cursor)
  editor.view.dispatch(tr.setMeta(inlineSource, { owner: anchor, anchor } satisfies InlineSource).setMeta('addToHistory', false))
}

function inlineTokens(content: Fragment) {
  const tokens: DocumentNode[] = []
  content.forEach((node) => {
    if (node.isText) for (const character of node.text!) tokens.push(node.type.schema.text(character, node.marks))
    else tokens.push(node)
  })
  return tokens
}

function diffInline(before: DocumentNode[], after: DocumentNode[]): readonly InlineChange[] {
  return diffArrays(before, after, { comparator: (a, b) => a.eq(b), timeout: 10, maxEditLength: 2048 })
    ?? [{ value: before, removed: true }, { value: after, added: true }]
}

function diffTextBlocks(original: Slice, replacement: Slice, baseOffset: number): InlineSource['changes'] {
  if (original.openStart || original.openEnd || replacement.openStart || replacement.openEnd) return
  const before: DocumentNode[] = []
  const after: DocumentNode[] = []
  original.content.forEach(node => before.push(node))
  replacement.content.forEach(node => after.push(node))
  const simple = (node: DocumentNode) => {
    if (!['paragraph', 'heading'].includes(node.type.name)) return false
    for (let index = 0; index < node.childCount; index++) {
      const child = node.child(index)
      if (!child.isText && child.type.name !== 'hardBreak') return false
    }
    return true
  }
  if (!before.every(simple) || !after.every(simple)) return
  const groups = diffArrays(before, after, { comparator: (a, b) => a.eq(b), timeout: 12, maxEditLength: 256 })
  if (!groups) return
  const runs: InlineChangeRun[] = []
  const additions: BlockAddition[] = []
  let offset = baseOffset
  let removed: DocumentNode[] = []
  let added: DocumentNode[] = []
  const flush = () => {
    for (const [index, node] of removed.entries()) {
      const next = added[index]
      const tokens = inlineTokens(node.content)
      if (next?.sameMarkup(node)) {
        runs.push({ offset: offset + 1, parts: diffInline(tokens, inlineTokens(next.content)) })
      } else {
        runs.push({ offset: offset + 1, parts: [{ value: tokens, removed: true }] })
        if (next) additions.push({ offset: offset + node.nodeSize, blocks: [next] })
      }
      offset += node.nodeSize
    }
    if (added.length > removed.length) additions.push({ offset, blocks: added.slice(removed.length) })
    removed = []
    added = []
  }
  for (const group of groups) {
    if (group.removed) removed.push(...group.value)
    else if (group.added) added.push(...group.value)
    else {
      flush()
      for (const node of group.value) offset += node.nodeSize
    }
  }
  flush()
  return { runs, additions }
}

function showInlineChanges(editor: Editor, owner: PreviewOwner, anchor: number, patch: NonNullable<ReturnType<typeof prepareRevision>>) {
  const { doc, tr, schema } = editor.state
  const range = resolve(editor, anchor)
  if (!range || range.original.size > 4000 || patch.slice.size > 4000) return false
  const display = (changes: NonNullable<InlineSource['changes']>) => {
    editor.view.dispatch(tr.setMeta(inlineSource, { owner, anchor, changes } satisfies InlineSource)
      .setMeta('addToHistory', false))
    return true
  }
  const start = doc.resolve(range.from)
  if (!start.sameParent(doc.resolve(range.to)) || !start.parent.isTextblock) {
    const changes = diffTextBlocks(doc.slice(patch.from, patch.to), patch.slice, patch.from - range.from)
    return changes ? display(changes) : false
  }
  const before = inlineTokens(range.original.content)
  const after: DocumentNode[] = []
  if (patch.from === range.from && patch.to === range.to) {
    after.push(...inlineTokens(patch.slice.content))
  } else {
    const paragraphs: DocumentNode[] = []
    patch.slice.content.forEach((node) => paragraphs.push(node))
    if (!paragraphs.every((node) => node.type === start.parent.type) || !schema.nodes.hardBreak) return false
    paragraphs.forEach((node, index) => {
      if (index) after.push(schema.nodes.hardBreak.create(), schema.nodes.hardBreak.create())
      after.push(...inlineTokens(node.content))
    })
  }
  const hasUnsupportedNode = (node: DocumentNode) => !node.isText && node.type !== schema.nodes.hardBreak
  if (before.some(hasUnsupportedNode) || after.some(hasUnsupportedNode)) return false
  return display({ runs: [{ offset: 0, parts: diffInline(before, after) }] })
}

export function clearAiSource(editor: Editor, anchor: number) {
  if (editor.isDestroyed) return
  const tr = editor.state.tr.setMeta(anchors, { remove: anchor } satisfies AnchorEdit).setMeta('addToHistory', false)
  if (inlineSource.getState(editor.state)?.owner === anchor) tr.setMeta(inlineSource, null)
  editor.view.dispatch(tr)
}

export type AiReference = {
  label: string
  text: string
  anchor?: number
  emptyLine?: true
  page?: true
  external?: true
  shortened?: true
}

export type AiRevision = { markdown: string; reference: number | null }
export type AiRevisionMethod = 'replace' | 'below'
export type AiUndo = { anchor: number; original: Slice; reference?: number }
const REFERENCE_LIMIT = 24_000
const PREVIEW_LIMIT = 120_000

function track(tr: Transaction, from: number, to: number, id = ++nextAnchor) {
  tr.setMeta(anchors, { add: [id, { from, to, original: tr.doc.slice(from, to) }] } satisfies AnchorEdit)
  return id
}

function resolveAnchor(state: EditorState, id: number | undefined) {
  const range = id === undefined ? undefined : anchors.getState(state)?.get(id)
  if (range && state.doc.slice(range.from, range.to).eq(range.original)) return range
}

function resolve(editor: Editor, id: number | undefined) {
  return resolveAnchor(editor.state, id)
}

export function aiReferenceRange(editor: Editor, reference: AiReference) {
  return resolve(editor, reference.anchor)
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
  const list = listSliceParent(doc, from, to, slice)
  if (list) return serializeMarkdown(doc.copy(Fragment.from(list.copy(slice.content))))
  try { return serializeMarkdown(doc.copy(slice.content)) }
  catch { return doc.textBetween(from, to, '\n', ' ') }
}

function listSliceParent(doc: DocumentNode, from: number, to: number, slice: Slice) {
  const $from = doc.resolve(from)
  const parent = $from.node($from.sharedDepth(to))
  if ((parent.type.name === 'bulletList' || parent.type.name === 'orderedList') &&
    slice.content.firstChild?.type.name === 'listItem') return parent
}

export function captureAiReference(editor: Editor, kind: 'selection' | 'empty-line' | 'block' | 'page', title: string,
  range?: { from: number; to: number },
): AiReference | undefined {
  const { doc, selection, tr } = editor.state
  const { $from } = selection
  if (kind === 'empty-line') {
    const line = range ? doc.resolve(range.from) : $from
    if (line.parent.type !== editor.schema.nodes.paragraph || line.parent.content.size) return
    const anchor = track(tr, line.before(), line.after())
    editor.view.dispatch(tr.setMeta('addToHistory', false))
    return { label: '空白行', text: '', anchor, emptyLine: true }
  }
  let { from, to } = kind === 'selection' && range ? range : selection
  if (kind === 'page') {
    const text = referenceText(doc, 0, doc.content.size)
    if (!text.trim()) return
    const shortened = doc.content.size > REFERENCE_LIMIT || text.length > REFERENCE_LIMIT
    const anchor = shortened ? undefined : track(tr, 0, doc.content.size)
    if (anchor !== undefined) editor.view.dispatch(tr.setMeta('addToHistory', false))
    return { label: title, page: true, text: text.slice(0, REFERENCE_LIMIT), anchor, shortened: shortened ? true : undefined }
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

function revisionLocation(state: EditorState, method: AiRevisionMethod, reference: AiReference | undefined, insertion: number) {
  const range = resolveAnchor(state, reference?.anchor)
  if (method === 'replace') {
    if (!range || reference?.shortened) return
    return { from: range.from, to: range.to, original: range.original }
  }
  const fallback = resolveAnchor(state, insertion)
  if (!range && !fallback) return
  const end = state.doc.resolve(range?.to ?? fallback!.to)
  const depth = range && end.parent.type.name !== 'viewportGroup' ? blockDepth(end) : 0
  const pos = depth ? end.after(depth) : end.pos
  return { from: pos, to: pos, original: null }
}

function reviewAnchor(state: EditorState, from: number) {
  const start = state.doc.resolve(from)
  return Decoration.widget(start.parent.isTextblock ? start.before() : from, (view) => {
    const anchor = view.dom.ownerDocument.createElement('div')
    anchor.className = 'editor-ai-review-anchor'
    anchor.setAttribute('aria-hidden', 'true')
    return anchor
  }, { side: -1, ignoreSelection: true, key: 'ai-review-anchor' })
}

function draftDecorations(state: EditorState, draft: DraftPreview) {
  const location = revisionLocation(state, draft.method, draft.reference, draft.insertion)
  if (!location) return DecorationSet.empty

  const decorations: Decoration[] = []
  let pos = location.to
  if (draft.method === 'replace') {
    if (draft.inDocument) decorations.push(reviewAnchor(state, location.from))
    decorations.push(Decoration.inline(location.from, location.to, { class: 'editor-ai-removed' }))
    const end = state.doc.resolve(pos)
    const depth = blockDepth(end)
    if (depth) pos = end.after(depth)
  }
  decorations.push(Decoration.widget(pos, (view) => {
    const doc = view.dom.ownerDocument
    const card = doc.createElement('div')
    card.className = 'editor-ai-block-change editor-ai-added'
    const body = doc.createElement('div')
    body.innerHTML = draft.html
    card.append(body)
    return card
  }, { side: -1, ignoreSelection: true, key: `ai-draft-${draft.id}` }))
  return DecorationSet.create(state.doc, decorations)
}

function prepareRevision(editor: Editor, revision: AiRevision, method: AiRevisionMethod,
  reference: AiReference | undefined, insertion: number,
) {
  if (!editor.isEditable || editor.view.composing || !revision.markdown.trim() || revision.markdown.length > PREVIEW_LIMIT) return
  const { doc, schema } = editor.state
  const location = revisionLocation(editor.state, method, reference, insertion)
  if (!location) return
  const { from, to, original } = location
  const parsed = parseMarkdown(revision.markdown, schema)
  if (!original) return { from, to, slice: new Slice(parsed.content, 0, 0) }

  const start = doc.resolve(from)
  const end = doc.resolve(to)
  if (start.sameParent(end) && start.parent.isTextblock) {
    if (parsed.childCount !== 1 || !parsed.firstChild?.isTextblock) {
      if (start.parent.type !== schema.nodes.paragraph || start.parentOffset !== 0 || end.parentOffset !== start.parent.content.size) return
      return { from: start.before(), to: end.after(), slice: new Slice(parsed.content, 0, 0) }
    }
    const content = start.parent.type.spec.code ? Fragment.from(schema.text(revision.markdown)) : parsed.firstChild.content
    return { from, to, slice: new Slice(content, 0, 0) }
  }
  const list = listSliceParent(doc, from, to, original)
  if (list && (parsed.childCount !== 1 || parsed.firstChild?.type !== list.type)) return
  const content = list ? parsed.firstChild!.content : parsed.content
  return { from, to, slice: new Slice(content, original.openStart, original.openEnd) }
}

let nextDraftPreview = 0

export function showAiRevisionPreview(editor: Editor, owner: PreviewOwner, revision: AiRevision, method: AiRevisionMethod,
  reference: AiReference | undefined, insertion: number,
) {
  if (typeof owner === 'symbol' && typeof inlineSource.getState(editor.state)?.owner === 'number') return false
  const patch = prepareRevision(editor, revision, method, reference, insertion)
  if (!patch) return false
  const tr = editor.state.tr
  if (tr.maybeStep(new ReplaceStep(patch.from, patch.to, patch.slice)).failed || tr.doc.eq(editor.state.doc)) return false
  const anchor = reference?.anchor
  if (method === 'replace' && anchor !== undefined && showInlineChanges(editor, owner, anchor, patch)) {
    return true
  }
  const draft: DraftPreview = {
    id: ++nextDraftPreview, html: aiAnswerHtml(revision.markdown, 0), method, reference, insertion,
    inDocument: typeof owner === 'number' ? true : undefined,
  }
  editor.view.dispatch(editor.state.tr.setMeta(inlineSource, { owner, draft } satisfies InlineSource).setMeta('addToHistory', false))
  return true
}

export function previewInlineAiRevision(editor: Editor, reference: AiReference & { anchor: number }, revision: AiRevision) {
  return showAiRevisionPreview(editor, reference.anchor, revision, 'replace', reference, 0)
}

export function hasAiRevisionPreview(editor: Editor, owner: symbol) {
  if (editor.isDestroyed || !editor.isEditable) return false
  const { state } = editor
  const source = inlineSource.getState(state)
  if (!source || source.owner !== owner) return false
  const draft = source.draft
  return !!(draft ? revisionLocation(state, draft.method, draft.reference, draft.insertion) : resolveAnchor(state, source.anchor))
}

export function clearAiRevisionPreview(editor: Editor, owner: symbol) {
  if (!editor.isDestroyed && inlineSource.getState(editor.state)?.owner === owner) {
    editor.view.dispatch(editor.state.tr.setMeta(inlineSource, null).setMeta('addToHistory', false))
  }
}

export function applyAiRevision(editor: Editor, revision: AiRevision, method: AiRevisionMethod,
  reference: AiReference | undefined, insertion: number,
) {
  const patch = prepareRevision(editor, revision, method, reference, insertion)
  if (patch) return change(editor, patch.from, patch.to, patch.slice, true, method === 'replace' ? reference?.anchor : undefined)
}

export function undoAiRevision(editor: Editor, undo: AiUndo) {
  if (!editor.isEditable || editor.view.composing) return false
  const range = resolve(editor, undo.anchor)
  return !!range && !!change(editor, range.from, range.to, undo.original, false, undo.reference)
}
