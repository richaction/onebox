import type { Node } from '@tiptap/pm/model'

const LINE_HEIGHT = 24
const CHARS_PER_LINE = 80
const MIN_HEIGHT = 28
const headingHeights = [73, 66, 60, 45, 42, 40]

export function estimateHeight(block: Node, viewportHeight = 760): number {
  if (block.type.name === 'viewportGroup') {
    let height = 16
    block.forEach((child) => { height += estimateHeight(child, viewportHeight) + 12 })
    return height
  }
  if (block.type.name === 'codeBlock') {
    const language = String(block.attrs.language ?? '').trim().split(/\s/u, 1)[0].toLowerCase()
    // Match the chart preview's CSS height, plus the frame and its margins.
    if (language === 'echarts') return Math.min(400, Math.max(220, viewportHeight * 0.45)) + 30
    if (language === 'mermaid') return 210
  }
  const formula = block.firstChild
  if (block.type.name === 'paragraph' && block.childCount === 1 && formula?.type.name === 'math' && formula.attrs.display) {
    const latex = String(formula.attrs.latex)
    if (/\\(?:begin|dfrac|frac|int|sum|prod)\b/u.test(latex)) return 48
    return 32
  }
  const text = block.textContent
  // 显式换行、自动折行、嵌套文本块数三者取最大：
  // 只看字符数会把 10 行短代码块估成 1 行；而 textContent 不在子块间插分隔符，
  // 5 项列表也只有 25 字符，同样被估成 1 行（实测 28px vs 约 120px）。
  const explicitLines = text.split('\n').length
  const wrappedLines = Math.ceil(text.length / CHARS_PER_LINE)
  let textblocks = 0
  block.descendants((node) => {
    if (node.isTextblock) textblocks++
  })
  const lines = Math.max(explicitLines, wrappedLines, textblocks)
  if (block.type.name === 'heading') return (headingHeights[block.attrs.level - 1] ?? MIN_HEIGHT) + (lines - 1) * LINE_HEIGHT
  return Math.max(MIN_HEIGHT, lines * LINE_HEIGHT)
}

// 以块节点对象为键：PM 节点不可变，未修改的块跨 transaction 仍是同一引用（命中），
// 被编辑的块产生新对象（自然失效）。因此不需要块 ID，也不会污染 Markdown。
export class HeightCache {
  private map = new WeakMap<Node, number>()

  get(block: Node): number | undefined {
    return this.map.get(block)
  }

  set(block: Node, height: number): void {
    this.map.set(block, height)
  }
}
