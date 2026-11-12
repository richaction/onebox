import { describe, expect, it } from 'vitest'
import { detectUnsupported, parseMarkdown, serializeMarkdown } from '../src/core/markdown'
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

  it('never emits underline markup', () => {
    const out = roundTrip('普通文本\n')
    expect(out).not.toContain('<u>')
  })
})

describe('detectUnsupported', () => {
  it('returns empty for supported markdown', () => {
    expect(detectUnsupported('# 标题\n\n段落 **粗体**\n\n- 列表\n')).toEqual([])
  })

  it('detects tables', () => {
    expect(detectUnsupported('| a | b |\n| --- | --- |\n| 1 | 2 |\n')).toContain('table')
  })

  it('detects task lists', () => {
    expect(detectUnsupported('- [x] 完成\n- [ ] 未完成\n')).toContain('taskList')
  })

  it('detects footnotes', () => {
    expect(detectUnsupported('正文[^1]\n\n[^1]: 注释\n')).toContain('footnote')
  })

  it('detects inline html', () => {
    expect(detectUnsupported('正文 <div>x</div>\n')).toContain('html')
  })

  it('detects images', () => {
    expect(detectUnsupported('![alt](./a.png)\n')).toContain('image')
  })

  it('ignores syntax inside fenced code blocks', () => {
    const md = '```md\n| a | b |\n| --- | --- |\n![x](y)\n<div>\n- [ ] t\n```\n'
    expect(detectUnsupported(md)).toEqual([])
  })

  it('does not mistake a horizontal rule for a table', () => {
    expect(detectUnsupported('上文\n\n---\n\n下文\n')).toEqual([])
  })
})
