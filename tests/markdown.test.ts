import { describe, expect, it } from 'vitest'
import formatSample from '../examples/manual-testing/01 编辑器/全格式验收.md?raw'
import { detectUnsupported, parseMarkdown, serializeMarkdown, serializeMarkdownForFile } from '../src/core/markdown'
import { schema } from '../src/core/schema'

const roundTrip = (md: string) => serializeMarkdown(parseMarkdown(md, schema))

describe('markdown round trip', () => {
  it('is idempotent at doc level', () => {
    const md = [
      '# 标题',
      '',
      '段落 with **bold**, *em*, ~~strike~~, `code` and [link](https://example.com).',
      '',
      '> 引用',
      '',
      '- 甲',
      '- 乙',
      '',
      '1. 一',
      '2. 二',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      '---',
      '',
    ].join('\n')
    const once = parseMarkdown(md, schema)
    const twice = parseMarkdown(serializeMarkdown(once), schema)
    expect(twice.eq(once)).toBe(true)
  })

  it('preserves soft line breaks inside a paragraph', () => {
    const out = roundTrip('第一行\n第二行\n')
    expect(out).toContain('第一行\n第二行')
    expect(out).not.toContain('\\')
  })

  it('keeps code block language', () => {
    expect(roundTrip('```rust\nfn main() {}\n```\n')).toContain('```rust')
  })

  it('keeps ordered list start', () => {
    expect(roundTrip('3. 三\n4. 四\n')).toContain('3. 三')
  })

  it('keeps heading level', () => {
    expect(roundTrip('### 三级\n')).toContain('### 三级')
  })

  it('emits no HTML for any supported mark', () => {
    const out = roundTrip('**b** *i* ~~s~~ `c` [l](https://e.com)\n')
    expect(out).not.toMatch(/<[a-zA-Z/]/)
  })

  it('sizes the fence to survive nested backtick runs', () => {
    const md = '````md\n```\nx\n```\n````\n'
    const once = parseMarkdown(md, schema)
    const out = serializeMarkdown(once)
    expect(out.startsWith('````')).toBe(true)
    expect(parseMarkdown(out, schema).eq(once)).toBe(true)
  })

  it('keeps tilde-fenced content containing backtick fences', () => {
    const md = '~~~\n```\nx\n```\n~~~\n'
    const once = parseMarkdown(md, schema)
    expect(parseMarkdown(serializeMarkdown(once), schema).eq(once)).toBe(true)
  })

  it('sizes the fence for an indented closing fence inside the content', () => {
    const md = '````\n   ```\nx\n````\n'
    const once = parseMarkdown(md, schema)
    expect(parseMarkdown(serializeMarkdown(once), schema).eq(once)).toBe(true)
  })

  it('still emits exactly three backticks for an ordinary code block', () => {
    expect(roundTrip('```ts\nconst x = 1\n```\n').startsWith('```ts\n')).toBe(true)
  })
})

describe('phase two Markdown', () => {
  function assertRoundTrip(text: string) {
    expect(detectUnsupported(text)).toEqual([])
    const doc = parseMarkdown(text, schema)
    const output = serializeMarkdownForFile(doc)
    expect(parseMarkdown(output, schema).eq(doc), output).toBe(true)
    return { doc, output }
  }

  it('loads the full-format sample as editable Markdown and preserves its formatting on save', () => {
    assertRoundTrip(formatSample)
  })

  it('keeps aligned GFM tables and pipes inside text and code', () => {
    const { doc, output } = assertRoundTrip('| A | B |\n| :--- | ---: |\n| x\\|y | `a\\|b` |')
    expect(doc.firstChild?.type.name).toBe('table')
    expect(doc.firstChild?.firstChild?.firstChild?.attrs.align).toBe('left')
    expect(output).toContain('| :--- | ---: |')
    expect(output).toContain('| x\\|y | `a\\|b` |')
  })

  it('supports a table nested in a quote', () => {
    const { doc } = assertRoundTrip('> | A | B |\n> | - | - |\n> | 1 | 2 |')
    expect(doc.firstChild?.firstChild?.type.name).toBe('table')
  })

  it.each([
    '- [x] 完成\n- [ ] 未完成',
    '1. [x] done\n2. [ ] todo',
    '> - [x] done',
    '- parent\n  - [X] nested',
    '- [x]',
  ])('keeps task markers for %j', (input) => {
    const { doc, output } = assertRoundTrip(input)
    const checked: boolean[] = []
    doc.descendants((node) => {
      if (node.type.name === 'listItem' && typeof node.attrs.checked === 'boolean') {
        checked.push(node.attrs.checked)
      }
    })
    expect(checked[0]).toBe(true)
    expect(output).toContain('[x]')
  })

  it('keeps literal brackets in an ordinary list item', () => {
    const { doc } = assertRoundTrip('- \\[x] literal')
    expect(doc.firstChild?.firstChild?.attrs.checked).toBe(null)
  })

  it('keeps footnote labels, multiline definitions and unused definitions', () => {
    const { doc, output } = assertRoundTrip(
      '[^before]: Listed before use.\n\nText[^before].\n\n[^unused]: **Unused** note.\n\n    Second paragraph.',
    )
    expect(doc.firstChild?.attrs.label).toBe('before')
    expect(doc.child(1).lastChild?.type.name).toBe('text')
    expect(doc.child(1).child(1).attrs.label).toBe('before')
    expect(doc.lastChild?.childCount).toBe(2)
    expect(output).toContain('[^unused]: **Unused** note.')
  })

  it.each([
    '![alt](./a.png)',
    '![alt][r]\n\n[r]: ./a.png',
    '![alt][]\n\n[alt]: ./a.png',
    '![alt]\n\n[alt]: ./a.png',
    '![a[b]](./a.png)',
  ])('preserves image semantics for %j', (input) => {
    const { doc, output } = assertRoundTrip(input)
    expect(doc.firstChild?.firstChild?.type.name).toBe('image')
    expect(doc.firstChild?.firstChild?.attrs.src).toBe('./a.png')
    expect(output).toContain('](./a.png)')
  })

  it('preserves alt text, titles and relative attachments', () => {
    const { doc, output } = assertRoundTrip('![A *caption*](assets/a.png "Photo") [PDF](assets/a.pdf "Document")')
    expect(doc.firstChild?.firstChild?.attrs).toMatchObject({ alt: 'A caption', title: 'Photo' })
    expect(output).toContain('[PDF](assets/a.pdf "Document")')
  })

  it('keeps nested fences and the table that follows', () => {
    const { doc } = assertRoundTrip('````\n```\n````\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n')
    expect(doc.lastChild?.type.name).toBe('table')
  })

  it('keeps delimiters and marks across large serialization buffers', () => {
    const paragraph = '中文 content **strong** and [relative](assets/file.pdf).'
    const input = Array.from({ length: 320 }, (_, i) => `${i} ${paragraph}`)
      .concat(['> quote\n> next', '\`\`\`\ncode\n\`\`\`', 'Tail.']).join('\n\n')
    expect(assertRoundTrip(input).output).toBe(input)
  })
})

describe('read-only protection', () => {
  it('round-trips the allowed underline and highlight tags while protecting other HTML', () => {
    const source = '<u>下划线</u>、<mark>高亮</mark>与 **<u>嵌套粗体</u>**'
    expect(detectUnsupported(source)).toEqual([])
    const doc = parseMarkdown(source, schema)
    expect(doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toEqual(['underline'])
    expect(serializeMarkdownForFile(doc)).toBe(source)
    expect(detectUnsupported('<u class="unknown">text</u>')).toEqual(['html'])
    expect(detectUnsupported('<mark>unclosed')).toEqual(['html'])
  })

  it('round-trips callouts and foldable headings while keeping escaped markers literal', () => {
    const source = '> [!NOTE]\n>\n> 标注内容\n\n> [!NOTE]-\n>\n> ## 折叠标题\n>\n> 正文'
    const doc = parseMarkdown(source, schema)
    expect(doc.child(0).attrs.variant).toBe('note')
    expect(doc.child(1).attrs.variant).toBe('fold')
    expect(doc.child(1).firstChild?.type.name).toBe('heading')
    expect(serializeMarkdownForFile(doc).replace(/^> +$/gmu, '>')).toBe(source)
    expect(parseMarkdown('> \\[!NOTE]\n> 正文', schema).firstChild?.attrs.variant).toBeNull()
  })
  it('flags raw HTML, including multiline inline tags and comments', () => {
    expect(detectUnsupported('正文 <div>x</div>\n')).toContain('html')
    expect(detectUnsupported('text <span\n class="x">value</span>')).toContain('html')
    expect(detectUnsupported('before\n\n<!--\nhidden\n-->\n\nafter\n')).toContain('html')
  })

  it('flags ambiguous duplicate footnote definitions', () => {
    expect(detectUnsupported('Text[^n].\n\n[^n]: first\n\n[^n]: second')).toContain('footnote')
  })

  it('keeps literal HTML and entities as text when saving edits', () => {
    const paragraph = schema.node('paragraph', null, [schema.text('<span> &copy;')])
    const doc = schema.node('doc', null, [paragraph])
    const output = serializeMarkdownForFile(doc)
    expect(detectUnsupported(output)).toEqual([])
    expect(parseMarkdown(output, schema).eq(doc)).toBe(true)
  })

  it('ignores syntax inside fenced code blocks', () => {
    const md = '```md\n| a | b |\n| --- | --- |\n![x](y)\n<div>\n- [ ] t\n```\n'
    expect(detectUnsupported(md)).toEqual([])
  })

  it('preserves single-line html comments', () => {
    const md = 'before\n\n<!-- hidden -->\n\nafter\n'
    const once = parseMarkdown(md, schema)
    const out = serializeMarkdown(once)
    expect(out).toContain('<!-- hidden -->')
    expect(parseMarkdown(out, schema).eq(once)).toBe(true)
  })
})

describe('renderable Markdown', () => {
  it('round-trips inline formulas, matrices, chart fences, and literal currency', () => {
    const source = [
      String.raw`面积 $A=\pi r^2$，营收 \$1,234.50，增长 −0.25%。`,
      '',
      '$$',
      String.raw`\begin{bmatrix}a & b \\ c & d\end{bmatrix}`,
      '$$',
      '',
      '```echarts',
      '{"series":[{"type":"pie","data":[2,5]}]}',
      '```',
      '',
      '```mermaid',
      'flowchart LR',
      '  A --> B',
      '```',
    ].join('\n')
    const doc = parseMarkdown(source, schema)
    expect(doc.child(0).child(1).attrs.latex).toBe(String.raw`A=\pi r^2`)
    expect(doc.child(1).firstChild?.attrs).toMatchObject({
      latex: '\n' + String.raw`\begin{bmatrix}a & b \\ c & d\end{bmatrix}` + '\n',
      display: true,
    })
    expect(doc.child(2).attrs.language).toBe('echarts')
    expect(doc.child(3).attrs.language).toBe('mermaid')
    expect(serializeMarkdownForFile(doc)).toBe(source)
  })
})
