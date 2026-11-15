import { getSchema, type Extensions } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import type { Schema } from '@tiptap/pm/model'
import {
  FootnoteDefinition, FootnoteReference, MarkdownDocument, MarkdownImage, MarkdownListItem,
  markdownTableExtensions, ViewportGroup,
} from './markdownNodes'

export const extensions: Extensions = [
  StarterKit.configure({
    document: false, underline: false, trailingNode: false, listItem: false, link: { openOnClick: false },
  }),
  MarkdownDocument,
  ViewportGroup,
  MarkdownListItem,
  MarkdownImage,
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
