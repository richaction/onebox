import type { Node } from '@tiptap/pm/model'

const LINE_HEIGHT = 24
const CHARS_PER_LINE = 80
const MIN_HEIGHT = 28

export function estimateHeight(block: Node): number {
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
