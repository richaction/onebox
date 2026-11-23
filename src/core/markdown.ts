import { mathMarkdown, mathSource } from './mathMarkdown'
import MarkdownIt from 'markdown-it'
import footnote from 'markdown-it-footnote'
import {
  MarkdownParser,
  MarkdownSerializer,
  MarkdownSerializerState,
  defaultMarkdownSerializer,
} from 'prosemirror-markdown'
import type { Node, Schema } from '@tiptap/pm/model'

export type UnsupportedKind = 'footnote' | 'html'

function createTokenizer(html: boolean) {
  const md = MarkdownIt('commonmark', { html, linkify: false, typographer: false })
    .enable(['table', 'strikethrough'])
    .use(footnote)
    .use(mathMarkdown)
  // Preserve definition positions and definitions that happen to have no references.
  md.core.ruler.disable('footnote_tail')
  md.inline.ruler.disable('footnote_inline')
  return md
}

const tokenizer = createTokenizer(false)
const detector = createTokenizer(true)

const singleLineComment = /^<!--(?:(?!-->)[^\r\n])*-->$/
const footnoteLabel = /^[^\s\[\]\\]+$/u
type Token = ReturnType<typeof tokenizer.parse>[number]
const inlineFormatNames: Readonly<Record<string, string>> = { '<u>': 'underline', '<mark>': 'highlight' }
const inlineFormatTag = /^<(\/?)(u|mark)>/u

function pairedFormats(tokens: readonly Token[]) {
  const opening: Token[] = []
  const pairs = new Map<Token, string>()
  for (const token of tokens) {
    if (token.type !== 'html_inline' && token.type !== 'onebox_format') continue
    const tag = token.content
    if (inlineFormatNames[tag]) opening.push(token)
    else if (tag.startsWith('</') && opening.at(-1)?.content === '<' + tag.slice(2)) {
      const first = opening.pop()!
      const name = inlineFormatNames[first.content]
      pairs.set(first, `onebox_${name}_open`)
      pairs.set(token, `onebox_${name}_close`)
    }
  }
  return pairs
}

tokenizer.inline.ruler.before('html_inline', 'onebox_format', (state, silent) => {
  if (state.src[state.pos] !== '<') return false
  const match = inlineFormatTag.exec(state.src.slice(state.pos, state.pos + 7))
  if (!match || state.pos + match[0].length > state.posMax) return false
  if (!silent) state.push('onebox_format', '', 0).content = match[0]
  state.pos += match[0].length
  return true
})

tokenizer.core.ruler.push('onebox_inline_formats', ({ tokens }) => {
  for (const block of tokens) {
    if (!block.children?.some((token) => token.type === 'onebox_format')) continue
    const pairs = pairedFormats(block.children)
    for (const token of block.children) {
      if (token.type === 'onebox_format') token.type = pairs.get(token) ?? 'text'
    }
  }
})

tokenizer.core.ruler.push('onebox_quote_styles', (state) => {
  const output: Token[] = []
  for (let index = 0; index < state.tokens.length; index++) {
    const block = state.tokens[index]
    output.push(block)
    if (block.type !== 'blockquote_open' || state.tokens[index + 1]?.type !== 'paragraph_open') continue
    const inline = state.tokens[index + 2]
    const children = inline?.children
    if (!children?.length) continue
    const [first, second] = children
    if (first.type !== 'text' || (second && second.type !== 'softbreak')) continue
    const variant = first.content === '[!NOTE]' ? 'note' : first.content === '[!NOTE]-' ? 'fold' : undefined
    if (!variant || inline.content.split('\n', 1)[0].trimEnd() !== first.content) continue
    block.meta = { variant }
    children.splice(0, 2)
    if (children.length === 0 && state.tokens[index + 4]?.type !== 'blockquote_close') index += 3
  }
  state.tokens = output
})

function imageAlt(tokens: NonNullable<ReturnType<typeof tokenizer.parse>[number]['children']>): string {
  return tokens.map((token) => {
    if (token.children) return imageAlt(token.children)
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' '
    return token.type === 'text' || token.type === 'text_special' || token.type === 'code_inline'
      ? token.content
      : ''
  }).join('')
}

tokenizer.core.ruler.before('inline', 'onebox_task_items', ({ tokens }) => {
  for (let i = 0; i < tokens.length - 2; i++) {
    const item = tokens[i]
    const inline = tokens[i + 2]
    if (item.type !== 'list_item_open' || tokens[i + 1].type !== 'paragraph_open' || inline.type !== 'inline') {
      continue
    }
    const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(inline.content)
    if (!task) continue
    item.meta = { checked: task[1] !== ' ' }
    inline.content = inline.content.slice(task[0].length)
  }
})

// commonmark 预设把段内单换行输出为 softbreak token。转成字面 '\n' 文本，
// 使往返保持原样，而不是被规范化成 GFM 硬换行（反斜杠或双空格）。
tokenizer.core.ruler.push('onebox_softbreak_to_text', (state) => {
  for (const block of state.tokens) {
    if (!block.children) continue
    block.children = block.children.map((tok) => {
      if (tok.type !== 'softbreak') return tok
      const text = new state.Token('text', '', 0)
      text.content = '\n'
      return text
    })
  }
})

tokenizer.core.ruler.push('onebox_table_paragraphs', (state) => {
  state.tokens = state.tokens.flatMap((token) => {
    if (token.type === 'th_open' || token.type === 'td_open') {
      return [token, new state.Token('paragraph_open', 'p', 1)]
    }
    if (token.type === 'th_close' || token.type === 'td_close') {
      return [new state.Token('paragraph_close', 'p', -1), token]
    }
    return [token]
  })
})

function buildParser(schema: Schema): MarkdownParser {
  return new MarkdownParser(schema, tokenizer, {
    blockquote: { block: 'blockquote', getAttrs: (tok) => ({ variant: tok.meta?.variant ?? null }) },
    paragraph: { block: 'paragraph' },
    list_item: { block: 'listItem', getAttrs: (tok) => ({ checked: tok.meta?.checked ?? null }) },
    bullet_list: { block: 'bulletList' },
    ordered_list: {
      block: 'orderedList',
      getAttrs: (tok) => ({ start: Number(tok.attrGet('start') ?? 1) }),
    },
    heading: { block: 'heading', getAttrs: (tok) => ({ level: Number(tok.tag.slice(1)) }) },
    code_block: { block: 'codeBlock', noCloseToken: true },
    fence: {
      block: 'codeBlock',
      getAttrs: (tok) => ({ language: tok.info.trim() || null }),
      noCloseToken: true,
    },
    hr: { node: 'horizontalRule' },
    hardbreak: { node: 'hardBreak' },
    onebox_math: { node: 'math', getAttrs: (tok) => ({ latex: tok.content, display: tok.meta.display }) },
    text: { node: 'text' },
    image: {
      node: 'image',
      getAttrs: (tok) => ({
        src: tok.attrGet('src'),
        title: tok.attrGet('title'),
        alt: imageAlt(tok.children ?? []),
      }),
    },
    table: { block: 'table' },
    thead: { ignore: true },
    tbody: { ignore: true },
    tr: { block: 'tableRow' },
    th: { block: 'tableHeader', getAttrs: (tok) => alignment(tok.attrGet('style')) },
    td: { block: 'tableCell', getAttrs: (tok) => alignment(tok.attrGet('style')) },
    footnote_reference: { block: 'footnoteDefinition', getAttrs: (tok) => ({ label: tok.meta.label }) },
    footnote_ref: { node: 'footnoteReference', getAttrs: (tok) => ({ label: tok.meta.label }) },
    em: { mark: 'italic' },
    strong: { mark: 'bold' },
    s: { mark: 'strike' },
    onebox_underline: { mark: 'underline' },
    onebox_highlight: { mark: 'highlight' },
    code_inline: { mark: 'code', noCloseToken: true },
    link: { mark: 'link', getAttrs: (tok) => ({ href: tok.attrGet('href'), title: tok.attrGet('title') }) },
  })
}

function alignment(style: string | null) {
  return { align: style?.match(/^text-align:(left|center|right)$/)?.[1] ?? null }
}

const base = defaultMarkdownSerializer.nodes

const serializer = new MarkdownSerializer(
  {
    viewportGroup(state, node) {
      state.renderContent(node)
    },
    paragraph: base.paragraph,
    blockquote(state, node) {
      const variant = node.attrs.variant
      if (!variant) { base.blockquote(state, node, node, 0); return }
      state.wrapBlock('> ', null, node, () => {
        state.write(variant === 'fold' ? '[!NOTE]-\n' : '[!NOTE]\n')
        state.write('\n')
        state.renderContent(node)
      })
    },
    heading: base.heading,
    horizontalRule: base.horizontal_rule,
    hardBreak: base.hard_break,
    text(state, node) {
      const text = node.text!
      // Preserve existing single-line comments. Escape literal angle brackets in normal text.
      state.text(text, !singleLineComment.test(text))
    },
    math(state, node) {
      state.text(mathSource(node.attrs.latex, node.attrs.display), false)
    },
    bulletList: base.bullet_list,
    listItem(state, node) {
      if (node.attrs.checked !== null) state.write(node.attrs.checked ? '[x] ' : '[ ] ')
      state.renderContent(node)
    },
    image: base.image,
    table(state, node) {
      const header = node.firstChild!
      node.forEach((row, _offset, index) => {
        const cells: string[] = []
        if (row.childCount !== header.childCount || !row.childCount) {
          throw new Error('Markdown tables need the same number of cells in each row')
        }
        row.forEach((cell) => {
          const expectedType = index === 0 ? 'tableHeader' : 'tableCell'
          const { colspan, rowspan } = cell.attrs
          if (cell.type.name !== expectedType || colspan !== 1 || rowspan !== 1) {
            throw new Error('Markdown tables need one header row and unmerged cells')
          }
          const text = tableCellSerializer.serialize(cell)
          if (text.includes('\n')) throw new Error('Markdown table cells need a single line')
          cells.push(text.replace(/\|/g, '\\|'))
        })
        state.write('| ' + cells.join(' | ') + ' |\n')
        if (index === 0) {
          const separators: string[] = []
          header.forEach((cell) => {
            const align = cell.attrs.align
            separators.push(align === 'center' ? ':---:' : align === 'left' ? ':---' : align === 'right' ? '---:' : '---')
          })
          state.write('| ' + separators.join(' | ') + ' |\n')
        }
      })
      state.closeBlock(node)
    },
    footnoteReference(state, node) {
      if (!footnoteLabel.test(node.attrs.label)) throw new Error('Invalid footnote label')
      state.write(`[^${node.attrs.label}]`)
    },
    footnoteDefinition(state, node) {
      if (!footnoteLabel.test(node.attrs.label)) throw new Error('Invalid footnote label')
      state.wrapBlock('    ', `[^${node.attrs.label}]: `, node, () => state.renderContent(node))
    },
    // Tiptap 用 language / start，prosemirror-markdown 默认用 params / order
    codeBlock(state, node) {
      const text = node.textContent
      const language = (node.attrs.language as string | null) ?? ''
      const marker = language.includes('`') ? '~' : '`'
      // 围栏必须长于内容中任何行首围栏串，否则内层围栏提前闭合、正文被截断改写。
      // 代码块是受支持语法，没有只读闸门兜底，所以这里必须自身正确。
      let longest = 0
      for (const line of text.split('\n')) {
        // CommonMark 允许闭合围栏缩进 ≤3 空格，扫描必须同样容忍，
        // 否则缩进的 ``` 不被计入、外层围栏取 3、内容被提前闭合截断
        const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
        if (m) longest = Math.max(longest, m[1].length)
      }
      const fence = marker.repeat(Math.max(3, longest + 1))
      const separator = language.startsWith(marker) ? ' ' : ''
      state.write(fence + separator + language + '\n')
      state.text(text, false)
      state.ensureNewLine()
      state.write(fence)
      state.closeBlock(node)
    },
    orderedList(state, node) {
      const start = (node.attrs.start as number) ?? 1
      const maxW = String(start + node.childCount - 1).length
      const space = ' '.repeat(maxW + 2)
      state.renderList(node, space, (i) => {
        const n = String(start + i)
        return ' '.repeat(maxW - n.length) + n + '. '
      })
    },
  },
  {
    // 默认 marks 的键是 em/strong，本项目 schema 的键是 italic/bold，必须逐个改名而非展开
    bold: defaultMarkdownSerializer.marks.strong,
    italic: defaultMarkdownSerializer.marks.em,
    code: defaultMarkdownSerializer.marks.code,
    link: defaultMarkdownSerializer.marks.link,
    strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
    underline: { open: '<u>', close: '</u>' },
    highlight: { open: '<mark>', close: '</mark>' },
  },
  { escapeExtraCharacters: /[<&|$]/g, hardBreakNodeName: 'hardBreak' },
)

const tableCellSerializer = new MarkdownSerializer(
  serializer.nodes, serializer.marks, { escapeExtraCharacters: /[<&$]/g, hardBreakNodeName: 'hardBreak' },
)

export function parseMarkdown(text: string, schema: Schema): Node {
  return buildParser(schema).parse(text) ?? schema.node('doc', null, [schema.node('paragraph')])
}

export function serializeMarkdown(doc: Node): string {
  if (doc.content.size < 8_192) return serializer.serialize(doc)

  // prosemirror-markdown 1.13.9 checks the last output character on each
  // write. Cap the active string to avoid flattening a growing rope per block.
  // Keep the last two characters for the serializer's delimiter and escape checks.
  const State = MarkdownSerializerState as unknown as new (
    nodes: typeof serializer.nodes,
    marks: typeof serializer.marks,
    options: typeof serializer.options,
  ) => MarkdownSerializerState & { out: string }
  const state = new State(serializer.nodes, serializer.marks, { ...serializer.options })
  const output: string[] = []
  doc.forEach((node, _offset, index) => {
    state.render(node, doc, index)
    if (state.out.length >= 8_192) {
      output.push(state.out.slice(0, -2))
      state.out = state.out.slice(-2)
    }
  })
  output.push(state.out)
  return output.join('')
}

export function serializeMarkdownForFile(doc: Node): string {
  const text = serializeMarkdown(doc)
  if (detectUnsupported(text).length) throw new Error('Serialized Markdown contains unsupported syntax')
  return text
}

export function detectUnsupported(text: string): UnsupportedKind[] {
  const found = new Set<UnsupportedKind>()
  const definitions = new Set<string>()
  for (const block of detector.parse(text, {})) {
    if (block.type === 'html_block' && !singleLineComment.test(block.content.trim())) found.add('html')
    if (block.type === 'footnote_reference_open') {
      const label: string = block.meta.label
      if (definitions.has(label) || !footnoteLabel.test(label)) found.add('footnote')
      definitions.add(label)
    }
    const children = block.children
    if (!children?.some((tok) => tok.type === 'html_inline' && !singleLineComment.test(tok.content))) continue
    const formats = pairedFormats(children)
    for (const tok of children) {
      if (tok.type === 'html_inline' && !singleLineComment.test(tok.content) && !formats.has(tok)) found.add('html')
    }
  }
  return [...found]
}
