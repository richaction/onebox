import { describe, expect, it } from 'vitest'
import { mermaidErrorMessage, prepareMermaidSource } from '../src/core/mermaidSource'
import { unwrapMermaidFence } from '../src/core/mermaidFence'

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

  it('unwraps only a complete fenced Mermaid snippet', () => {
    expect(unwrapMermaidFence('\r\n~~~mermaid\r\nflowchart LR\r\n  A --> B\r\n~~~~\r\n')).toBe('flowchart LR\n  A --> B')
    expect(unwrapMermaidFence('```mermaid\nflowchart LR\n```\n```mermaid\nflowchart TD\n```')).toBeUndefined()
    expect(unwrapMermaidFence('```mermaid\nflowchart LR\n~~~')).toBeUndefined()
    expect(unwrapMermaidFence('flowchart LR')).toBeUndefined()
  })

  it('reports a pasted fence inside invalid source and maps errors within a complete legacy wrapper', () => {
    const error = new Error('Parse error on line 2:\n... A --> B[')
    expect(mermaidErrorMessage(error, 'flowchart LR\n  A --> B\n  B --> C-```mermaid\n--> C-\n```'))
      .toBe('第 3 行 · 源码中混入了 Markdown 围栏，请检查这段代码')
    expect(mermaidErrorMessage(error, '```mermaid\nflowchart LR\nA --> B[\n```')).toBe('第 3 行 · Mermaid 语法错误')
  })
})
