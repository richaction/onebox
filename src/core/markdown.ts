import MarkdownIt from 'markdown-it'
import {
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownSerializer,
} from 'prosemirror-markdown'
import type { Node, Schema } from '@tiptap/pm/model'

export type UnsupportedKind = 'table' | 'taskList' | 'footnote' | 'html' | 'image'

const tokenizer = MarkdownIt('commonmark', { html: false, linkify: false, typographer: false })
tokenizer.enable('strikethrough')
const detector = MarkdownIt('commonmark', { html: true }).enable(['table', 'strikethrough'])

const singleLineComment = /^<!--(?:(?!-->)[^\r\n])*-->$/

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

function buildParser(schema: Schema): MarkdownParser {
  return new MarkdownParser(schema, tokenizer, {
    blockquote: { block: 'blockquote' },
    paragraph: { block: 'paragraph' },
    list_item: { block: 'listItem' },
    bullet_list: { block: 'bulletList' },
    ordered_list: {
      block: 'orderedList',
      getAttrs: (tok) => ({ start: Number(tok.attrGet('start')) || 1 }),
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
    text: { node: 'text' },
    // 无 image 节点。忽略而非抛异常：不支持的文件走只读闸门，磁盘内容不受影响，
    // 但解析必须成功，否则文件根本打不开。
    // markdown-it 的 image 是单 token（无 _open/_close），必须显式 noCloseToken，
    // 否则 ignore 只注册 image_open/image_close，image 本身仍无 handler 而抛异常。
    image: { ignore: true, noCloseToken: true },
    em: { mark: 'italic' },
    strong: { mark: 'bold' },
    s: { mark: 'strike' },
    code_inline: { mark: 'code', noCloseToken: true },
    link: { mark: 'link', getAttrs: (tok) => ({ href: tok.attrGet('href') }) },
  })
}

const base = defaultMarkdownSerializer.nodes

const serializer = new MarkdownSerializer(
  {
    paragraph: base.paragraph,
    blockquote: base.blockquote,
    heading: base.heading,
    horizontalRule: base.horizontal_rule,
    hardBreak: base.hard_break,
    text(state, node) {
      const text = node.text!
      // Preserve existing single-line comments. Escape literal angle brackets in normal text.
      state.text(text, !singleLineComment.test(text))
    },
    bulletList: base.bullet_list,
    listItem: base.list_item,
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
  },
  { escapeExtraCharacters: /[<&|]/g, hardBreakNodeName: 'hardBreak' },
)

export function parseMarkdown(text: string, schema: Schema): Node {
  return buildParser(schema).parse(text) ?? schema.node('doc', null, [schema.node('paragraph')])
}

export function serializeMarkdown(doc: Node): string {
  return serializer.serialize(doc)
}

export function serializeMarkdownForFile(doc: Node): string {
  const text = serializeMarkdown(doc)
  const found = new Set<UnsupportedKind>()
  collectUnsupportedTokens(detector.parse(text, {}), found)
  if (found.size) throw new Error('Serialized Markdown contains unsupported syntax')
  return text
}

function collectUnsupportedTokens(tokens: ReturnType<typeof detector.parse>, found: Set<UnsupportedKind>) {
  for (const block of tokens) {
    if (block.type === 'table_open') found.add('table')
    if (block.type === 'html_block' && !singleLineComment.test(block.content.trim())) found.add('html')
    for (const tok of block.children ?? []) {
      if (tok.type === 'image') found.add('image')
      if (tok.type === 'html_inline' && !singleLineComment.test(tok.content)) found.add('html')
    }
  }
}

export function detectUnsupported(text: string): UnsupportedKind[] {
  const found = new Set<UnsupportedKind>()
  const tokens = detector.parse(text, {})
  collectUnsupportedTokens(tokens, found)

  // Task items and footnote definitions need source text. Use token line ranges to
  // exclude fenced code, including fences inside quotes or lists.
  const fences = tokens.flatMap((token) => token.type === 'fence' && token.map ? [token.map] : [])
  let fence = 0
  for (const [index, line] of text.split(/\r\n?|\n/).entries()) {
    while (fence < fences.length && index >= fences[fence][1]) fence++
    if (fence < fences.length && index >= fences[fence][0]) continue
    if (/^\s*(?:>\s*|(?:[-*+]|\d+[.)])\s+)+\[[ xX]\](\s|$)/.test(line)) found.add('taskList')
    if (/(?<!\\)(?:\\\\)*\[\^[^\]]+\]/.test(line)) found.add('footnote')
  }
  return [...found]
}
