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

  it('detects reference-style images', () => {
    expect(detectUnsupported('![alt][r]\n\n[r]: ./a.png\n')).toContain('image')
  })

  it('detects collapsed and shortcut images', () => {
    expect(detectUnsupported('![alt][]\n\n[alt]: ./a.png\n')).toContain('image')
    expect(detectUnsupported('![alt]\n\n[alt]: ./a.png\n')).toContain('image')
  })

  it('detects images with nested brackets in alt', () => {
    expect(detectUnsupported('![a[b]](c)\n')).toContain('image')
  })

  it('detects task lists at any indentation', () => {
    expect(detectUnsupported('parent\n    - [x] nested done\n')).toContain('taskList')
  })

  it('detects empty-label task items', () => {
    expect(detectUnsupported('- [x]\n')).toContain('taskList')
  })
})

describe('parse tolerance', () => {
  it('never throws on any image form', () => {
    for (const md of [
      '![alt](./a.png)\n',
      '![alt][r]\n\n[r]: ./a.png\n',
      '![alt][]\n\n[alt]: ./a.png\n',
      '![alt]\n\n[alt]: ./a.png\n',
      '![a[b]](c)\n',
    ]) {
      expect(() => parseMarkdown(md, schema), md).not.toThrow()
    }
  })

  it('preserves single-line html comments', () => {
    const md = 'before\n\n<!-- hidden -->\n\nafter\n'
    const once = parseMarkdown(md, schema)
    const out = serializeMarkdown(once)
    expect(out).toContain('<!-- hidden -->')
    expect(parseMarkdown(out, schema).eq(once)).toBe(true)
  })
})

describe('detection regression cases', () => {
  it('detects ordered-list task items', () => {
    expect(detectUnsupported('1. [x] done\n2. [ ] todo\n')).toContain('taskList')
  })

  it('detects blockquoted task items', () => {
    expect(detectUnsupported('> - [x] done\n')).toContain('taskList')
  })

  it('detects multi-line html comments', () => {
    expect(detectUnsupported('before\n\n<!--\nhidden\n-->\n\nafter\n')).toContain('html')
  })

  it('does not flag a single-line html comment', () => {
    expect(detectUnsupported('a <!-- x --> b\n')).toEqual([])
  })

  it('pairs fences by char and length so a 4-backtick fence does not invert state', () => {
    const md = '````\n```\n```\n````\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'
    expect(detectUnsupported(md)).toContain('table')
  })
})
