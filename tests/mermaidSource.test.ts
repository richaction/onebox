import { describe, expect, it } from 'vitest'
import { mermaidErrorMessage, prepareMermaidSource } from '../src/core/mermaidSource'

describe('Mermaid in Markdown', () => {
  it('keeps the title, layout and diagram when a document specifies its own appearance', () => {
    const source = '---\r\ntitle: 下单\r\nconfig: {theme: forest, look: classic, layout: elk}\r\n---\r\nsequenceDiagram\r\nA->>B: 下单'
    expect(prepareMermaidSource(source)).toBe([
      '---', 'title: 下单', 'config:', '  layout: elk', '---', 'sequenceDiagram', 'A->>B: 下单',
    ].join('\n'))
  })

  it('keeps the shared app theme and filters renderer settings out of document headers', () => {
    const body = 'flowchart LR\nA --> B'
    const source = [
      '---', 'config:', '  theme: base', '  securityLevel: loose', '  htmlLabels: true',
      '  themeCSS: invalid', '  themeVariables:', "    primaryColor: '#123abc'", '---', body,
    ].join('\n')
    expect(prepareMermaidSource(source)).toBe(body)
  })

  it('reports the source line with YAML and comments above the Mermaid error', () => {
    const source = '\n---\ntitle: Test\n---\nflowchart LR\n\n%% comment\nA --> B['
    expect(mermaidErrorMessage(new Error('Parse error on line 2:\n... A --> B['), source))
      .toBe('第 8 行 · Mermaid 语法错误')
  })
})
