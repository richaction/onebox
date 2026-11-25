import { mergeAttributes, Node } from '@tiptap/core'
import { ListItem } from '@tiptap/extension-list'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { Plugin } from '@tiptap/pm/state'
import { tableEditingKey } from '@tiptap/pm/tables'
import { trackTablePointerSelection } from './tablePointerSelection'

export const MarkdownDocument = Node.create({
  name: 'doc',
  topNode: true,
  content: '(block | viewportGroup)+',
})

// A view container for large documents. It never becomes a Markdown token.
export const ViewportGroup = Node.create({
  name: 'viewportGroup',
  content: 'block+',
  renderHTML() {
    return ['div', { class: 'viewport-group' }, 0]
  },
})

export const MarkdownImage = Node.create({
  name: 'image',
  inline: true,
  group: 'inline',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: '' },
      alt: { default: '' },
      title: { default: null },
      widthPercent: {
        default: null,
        parseHTML: (element) => imageWidthPercent(Number(element.getAttribute('data-onebox-image-width'))),
        renderHTML: ({ widthPercent }) => widthPercent === null ? {} : { 'data-onebox-image-width': widthPercent },
      },
    }
  },
  parseHTML() {
    return [{ tag: 'img[src]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes, { loading: 'lazy', decoding: 'async' })]
  },
})

export const defaultImageWidth = 90
export const minImageWidth = 20
export const maxImageWidth = 100

export function imageWidthPercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= minImageWidth && value <= maxImageWidth ? value : null
}

export const MarkdownListItem = ListItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      checked: {
        default: null,
        rendered: false,
        parseHTML: (element) => {
          const checked = element.getAttribute('data-checked')
          return checked === null ? null : checked === 'true'
        },
      },
    }
  },
  renderHTML({ node, HTMLAttributes }) {
    if (node.attrs.checked === null) return ['li', HTMLAttributes, 0]
    return [
      'li', { ...HTMLAttributes, 'data-checked': String(node.attrs.checked) },
      ['button', {
        type: 'button',
        contenteditable: 'false',
        class: 'task-toggle',
        role: 'checkbox',
        'aria-label': '完成任务',
        'aria-checked': String(node.attrs.checked),
        'data-task-toggle': '',
      }],
      ['div', 0],
    ]
  },
})

export const FootnoteReference = Node.create({
  name: 'footnoteReference',
  inline: true,
  group: 'inline',
  atom: true,
  addAttributes() {
    return { label: { default: 'note', rendered: false } }
  },
  parseHTML() {
    return [{ tag: 'sup[data-footnote-ref]', getAttrs: (el) => ({ label: el.dataset.footnoteRef }) }]
  },
  renderHTML({ node }) {
    return ['sup', { 'data-footnote-ref': node.attrs.label, class: 'footnote-reference' }, `[${node.attrs.label}]`]
  },
  renderText({ node }) {
    return `[^${node.attrs.label}]`
  },
})

export const FootnoteDefinition = Node.create({
  name: 'footnoteDefinition',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return { label: { default: 'note', rendered: false } }
  },
  parseHTML() {
    return [{
      tag: 'aside[data-footnote-label]',
      contentElement: '[data-footnote-content]',
      getAttrs: (el) => ({ label: el.dataset.footnoteLabel }),
    }]
  },
  renderHTML({ node }) {
    return [
      'aside', { 'data-footnote-label': node.attrs.label, class: 'footnote-definition' },
      ['span', { contenteditable: 'false' }, `[${node.attrs.label}]`],
      ['div', { 'data-footnote-content': '' }, 0],
    ]
  },
})

export const markdownTableExtensions = [
  Table.extend({
    // The viewport plugin owns the top-level wrapper and its observer.
    addNodeView() { return null },
    addProseMirrorPlugins() {
      return (this.parent?.() ?? []).map((plugin) => plugin.spec.key !== tableEditingKey ? plugin : new Plugin({
        ...plugin.spec,
        // Keep paste, keyboard selection, and normalization. Track drags on the pointer event stream.
        props: { ...plugin.spec.props, handleDOMEvents: undefined },
        view: (view) => ({ destroy: trackTablePointerSelection(view) }),
      }))
    },
  }),
  TableRow,
  TableCell.extend({ content: 'paragraph' }),
  TableHeader.extend({ content: 'paragraph' }).configure({ HTMLAttributes: { scope: 'col' } }),
]
