import type { Node } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'

export interface RelativeReference {
  href: string
  image: boolean
}

export function isRelativeResource(href: string) {
  return href.length > 0 && !/^(?:[/\\#?]|[a-z][a-z\d+.-]*:)/i.test(href)
}

export function relativeReferences(doc: Node): RelativeReference[] {
  const references = new Map<string, RelativeReference>()
  doc.descendants((node) => {
    if (!node.isInline) return
    for (const mark of node.marks) {
      const href = mark.type.name === 'link' ? mark.attrs.href : null
      if (href && isRelativeResource(href) && !references.has(href)) {
        references.set(href, { href, image: false })
      }
    }
    if (node.type.name === 'image' && isRelativeResource(node.attrs.src)) {
      references.set(node.attrs.src, { href: node.attrs.src, image: true })
    }
  })
  return [...references.values()]
}

export function rewriteAttachmentLinks(state: EditorState, rewrites: Record<string, string>) {
  const transaction = state.tr
  if (!Object.keys(rewrites).length) return transaction
  state.doc.descendants((node, pos) => {
    if (!node.isInline) return
    for (const mark of node.marks) {
      const href: string = mark.attrs.href
      if (mark.type.name !== 'link' || !Object.hasOwn(rewrites, href)) continue
      transaction.removeMark(pos, pos + node.nodeSize, mark)
      transaction.addMark(pos, pos + node.nodeSize, mark.type.create({ ...mark.attrs, href: rewrites[href] }))
    }
    if (node.type.name === 'image' && Object.hasOwn(rewrites, node.attrs.src)) {
      transaction.setNodeAttribute(pos, 'src', rewrites[node.attrs.src])
    }
  })
  return transaction
}
