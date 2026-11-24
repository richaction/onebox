/** @jsxImportSource react */
'use client'

import {
  BlockquotePlugin, BoldPlugin, CodePlugin, H1Plugin, H2Plugin, H3Plugin, H4Plugin, H5Plugin, H6Plugin,
  HorizontalRulePlugin, ItalicPlugin, StrikethroughPlugin, UnderlinePlugin,
} from '@platejs/basic-nodes/react'
import { CodeBlockPlugin, CodeLinePlugin } from '@platejs/code-block/react'
import { FootnoteDefinitionPlugin, FootnoteReferencePlugin } from '@platejs/footnote/react'
import { LinkPlugin } from '@platejs/link/react'
import { ListPlugin } from '@platejs/list/react'
import { MarkdownPlugin } from '@platejs/markdown'
import { BaseEquationPlugin, BaseInlineEquationPlugin } from '@platejs/math'
import { ImagePlugin } from '@platejs/media/react'
import { BlockSelectionPlugin } from '@platejs/selection/react'
import { TableCellHeaderPlugin, TableCellPlugin, TablePlugin, TableRowPlugin } from '@platejs/table/react'
import { ParagraphPlugin, PlateElement, PlateLeaf, toPlatePlugin, type PlateEditor, type PlateElementProps, type PlateLeafProps } from 'platejs/react'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { BlockSelection, CodeBlock, Formula, Image, Link, Paragraph, Rule, Table } from './elements'
import { sameMarkdownContent } from './markdownSource'

const block = (tag: 'blockquote' | 'div' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'td' | 'th' | 'tr') =>
  function Element(props: PlateElementProps) { return <PlateElement as={tag} {...props} /> }
const mark = (tag: 'code' | 'em' | 's' | 'strong' | 'u') =>
  function Leaf(props: PlateLeafProps) { return <PlateLeaf as={tag} {...props} /> }

export const editorPlugins = [
  BlockSelectionPlugin.configure({
    options: { isSelectable: (_element, path) => path.length === 1 },
    render: { belowRootNodes: BlockSelection },
  }),
  ParagraphPlugin.withComponent(Paragraph),
  H1Plugin.withComponent(block('h1')), H2Plugin.withComponent(block('h2')), H3Plugin.withComponent(block('h3')),
  H4Plugin.withComponent(block('h4')), H5Plugin.withComponent(block('h5')), H6Plugin.withComponent(block('h6')),
  BlockquotePlugin.withComponent(block('blockquote')), HorizontalRulePlugin.withComponent(Rule),
  BoldPlugin.withComponent(mark('strong')), ItalicPlugin.withComponent(mark('em')), UnderlinePlugin.withComponent(mark('u')),
  StrikethroughPlugin.withComponent(mark('s')), CodePlugin.withComponent(mark('code')),
  ListPlugin,
  CodeBlockPlugin.withComponent(CodeBlock), CodeLinePlugin.withComponent(block('div')),
  LinkPlugin.withComponent(Link), ImagePlugin.withComponent(Image),
  TablePlugin.withComponent(Table), TableRowPlugin.withComponent(block('tr')),
  TableCellPlugin.withComponent(block('td')), TableCellHeaderPlugin.withComponent(block('th')),
  toPlatePlugin(BaseEquationPlugin).withComponent(Formula), toPlatePlugin(BaseInlineEquationPlugin).withComponent(Formula),
  FootnoteDefinitionPlugin, FootnoteReferencePlugin,
  MarkdownPlugin.configure({ options: { remarkPlugins: [remarkGfm, remarkMath] } }),
]

export function initMarkdown(editor: PlateEditor, markdown: string) {
  const api = editor.getApi(MarkdownPlugin).markdown
  const value = api.deserialize(markdown, { withoutMdx: true })
  const roundTrip = api.serialize({ value })
  return { value, supported: sameMarkdownContent(markdown, roundTrip) }
}

export function serializeMarkdown(editor: PlateEditor) {
  return editor.getApi(MarkdownPlugin).markdown.serialize()
}
