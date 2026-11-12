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
      getAttrs: (tok) => ({ language: tok.info || null }),
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
    text: base.text,
    bulletList: base.bullet_list,
    listItem: base.list_item,
    // Tiptap 用 language / start，prosemirror-markdown 默认用 params / order
    codeBlock(state, node) {
      const text = node.textContent
      // 围栏必须长于内容中任何行首围栏串，否则内层围栏提前闭合、正文被截断改写。
      // 代码块是受支持语法，没有只读闸门兜底，所以这里必须自身正确。
      let longest = 0
      for (const line of text.split('\n')) {
        // CommonMark 允许闭合围栏缩进 ≤3 空格，扫描必须同样容忍，
        // 否则缩进的 ``` 不被计入、外层围栏取 3、内容被提前闭合截断
        const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
        if (m) longest = Math.max(longest, m[1].length)
      }
      const fence = '`'.repeat(Math.max(3, longest + 1))
      state.write(fence + ((node.attrs.language as string | null) || '') + '\n')
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
)

export function parseMarkdown(text: string, schema: Schema): Node {
  return buildParser(schema).parse(text) ?? schema.node('doc', null, [schema.node('paragraph')])
}

export function serializeMarkdown(doc: Node): string {
  return serializer.serialize(doc)
}

function isTableDelimiter(line: string, prev: string): boolean {
  if (!line.includes('|') || !line.includes('-') || !prev.includes('|')) return false
  return /^[\s|:-]+$/.test(line)
}

export function detectUnsupported(text: string): UnsupportedKind[] {
  const found = new Set<UnsupportedKind>()

  // 图片用 tokenizer 自身的 token 流判定：markdown-it 能识别 inline / reference /
  // collapsed / shortcut 全部形式，正则穷尽不了。 fenced code 内的图片天然不产生
  // image token，无需另行跳过。
  for (const block of tokenizer.parse(text, {})) {
    for (const tok of block.children ?? []) {
      if (tok.type === 'image') found.add('image')
    }
  }

  let fenceChar = ''
  let fenceLen = 0
  let inHtmlComment = false
  let prev = ''
  for (const line of text.split('\n')) {
    // 围栏按字符与长度配对闭合：4 反引号围栏内的 ``` 行不应翻转状态
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (f) {
      if (!fenceChar) {
        fenceChar = f[1][0]
        fenceLen = f[1].length
      } else if (f[1][0] === fenceChar && f[1].length >= fenceLen) {
        fenceChar = ''
        fenceLen = 0
      }
      prev = line
      continue
    }
    if (!fenceChar) {
      if (isTableDelimiter(line, prev)) found.add('table')
      // 任意缩进、有序标记、引用前缀、空标签：漏检会让文件以可编辑打开，
      // 保存时任务列表标记被转义改写成字面文本
      if (/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ xX]\](\s|$)/.test(line)) found.add('taskList')
      if (/\[\^[^\]]+\]/.test(line)) found.add('footnote')
      if (/<\/?[a-zA-Z][^>]*>/.test(line)) found.add('html')
      // 多行 HTML 注释：起始行未同行闭合时进入注释态。单行注释逐字往返无损，
      // 不纳入检测；多行注释的结束符会被转义成 \-->，在第三方编辑器里永不闭合、
      // 吞掉后文。
      const open = line.indexOf('<!--')
      if (open >= 0 && !line.slice(open + 4).includes('-->')) inHtmlComment = true
      if (inHtmlComment) {
        found.add('html')
        if (line.includes('-->')) inHtmlComment = false
      }
    }
    prev = line
  }
  return [...found]
}
