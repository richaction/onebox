import { MarkdownMath } from './mathNode'
import { Extension, getSchema, Mark, type Extensions } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import type { Schema } from '@tiptap/pm/model'
import {
  FootnoteDefinition, FootnoteReference, MarkdownDocument, MarkdownImage, MarkdownListItem,
  markdownTableExtensions, ViewportGroup,
} from './markdownNodes'

export const extensions: Extensions = [
  StarterKit.configure({
    document: false, trailingNode: false, listItem: false, link: { openOnClick: false },
  }),
  Mark.create({
    name: 'highlight',
    parseHTML: () => [{ tag: 'mark' }],
    renderHTML: () => ['mark', 0],
  }),
  Extension.create({
    name: 'markdownQuoteStyles',
    addGlobalAttributes: () => [{
      types: ['blockquote'],
      attributes: { variant: {
        default: null,
        parseHTML(element: HTMLElement) {
          const variant = element.dataset.quoteVariant
          return variant === 'note' || variant === 'fold' ? variant : null
        },
        renderHTML: ({ variant }) => variant ? { 'data-quote-variant': variant } : {},
      } },
    }],
  }),
  MarkdownDocument,
  ViewportGroup,
  MarkdownListItem,
  MarkdownImage,
  MarkdownMath,
  FootnoteReference,
  FootnoteDefinition,
  ...markdownTableExtensions,
]

export const schema: Schema = getSchema(extensions)

export const TOP_LEVEL_BLOCK_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'bulletList',
  'orderedList',
  'horizontalRule',
  'table',
  'footnoteDefinition',
  'viewportGroup',
] as const
