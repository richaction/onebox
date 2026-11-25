import { parseDocument, stringify } from 'yaml'
import { mermaidOpeningFence, unwrapMermaidFence } from './mermaidFence'

const layouts = new Set(['dagre', 'elk'])
const separator = /^---[ \t]*$/u

export function prepareMermaidSource(source: string) {
  const lines = source.split(/\r?\n/u)
  const end = lines.findIndex((line, index) => index > 0 && separator.test(line))
  if (end < 0) throw new Error('Mermaid 配置缺少结束的 ---')
  const header = parseDocument(lines.slice(1, end).join('\n'))
  if (header.errors.length) {
    const position = header.errors[0].linePos?.[0]
    throw new Error(position ? `第 ${position.line + 1} 行 · YAML 格式错误` : 'Mermaid 配置需要有效的 YAML')
  }
  const data: unknown = header.toJS({ mapAsMap: true, maxAliasCount: 0 })
  if (data !== null && !(data instanceof Map)) throw new Error('Mermaid 配置需要键值对')

  // Apply Onebox's theme consistently, while honoring diagram-specific layout.
  const style: unknown = data?.get('config')
  const layout: unknown = style instanceof Map ? style.get('layout') : undefined
  const title: unknown = data?.get('title')
  const body = lines.slice(end + 1).join('\n')
  const safe = {
    ...(typeof title === 'string' ? { title } : {}),
    ...(typeof layout === 'string' && layouts.has(layout) ? { config: { layout } } : {}),
  }
  return Object.keys(safe).length ? `---\n${stringify(safe, { lineWidth: 0 })}---\n${body}` : body
}

export function mermaidErrorMessage(error: unknown, source: string) {
  const unwrapped = unwrapMermaidFence(source)
  const fence = source.split(/\r\n?|\n/u).findIndex((line) => unwrapped === undefined
    ? /(?:`{3,}|~{3,})[ \t]*mermaid[ \t]*$/iu.test(line) : mermaidOpeningFence.test(line))
  if (unwrapped === undefined && fence >= 0) return `第 ${fence + 1} 行 · 源码中混入了 Markdown 围栏，请检查这段代码`
  const message = error instanceof Error ? error.message : String(error)
  const match = /\berror on line (\d+)/i.exec(message)
  if (!match) {
    if (/no diagram type detected|unknown diagram type/i.test(message)) return '无法识别 Mermaid 图表类型，请检查首行'
    if (message.startsWith('Parsing failed:')) return 'Mermaid 语法错误，请检查源码'
    return message.split('\n', 1)[0].slice(0, 160) || 'Mermaid 预览失败'
  }

  const lines = (unwrapped ?? source).replace(/\r\n?/gu, '\n').trimEnd().split('\n')
  const fenceOffset = unwrapped === undefined ? 0 : fence + 1
  const start = lines.findIndex((line) => line.trim())
  const end = separator.test(lines[start]?.trimStart() ?? '')
    ? lines.findIndex((line, index) => index > start && separator.test(line)) : -1
  const body = lines.slice(Math.max(start, end + 1))
  const firstLine = Math.max(start, end + 1) + 1
  const comment = /^\s*%%(?!\{).+/u
  const preserveComments = /^(?:agentflow|eventmodeling)\b/i.test(body.find((line) => line.trim() && !comment.test(line))?.trim() ?? '')
  const lineMap: number[] = []
  for (const [index, line] of body.entries()) {
    if (!preserveComments && comment.test(line)) {
      // Mermaid removes comment lines and the adjacent blank lines above them.
      while (lineMap.length && !lines[lineMap[lineMap.length - 1] - 1].trim()) lineMap.pop()
    } else if (preserveComments || lineMap.length || line.trim()) {
      lineMap.push(firstLine + index)
    }
  }
  const reported = lineMap[Math.min(Number(match[1]), lineMap.length) - 1]
  return reported ? `第 ${reported + fenceOffset} 行 · Mermaid 语法错误` : 'Mermaid 语法错误，请检查源码'
}
