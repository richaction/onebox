import { diffArrays } from 'diff'
import type { RootContent } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)

type MarkdownBlock = { key: string; start: number; end: number }

function semanticKey(node: RootContent) {
  return JSON.stringify(node, (key, value: unknown) => {
    if (key === 'position' || key === 'spread' || value === null) return undefined
    return value
  })
}

export function markdownBlocks(source: string): MarkdownBlock[] {
  return parser.parse(source).children.flatMap((node) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    return start === undefined || end === undefined ? [] : [{ key: semanticKey(node), start, end }]
  })
}

function sameBlocks(left: MarkdownBlock[], right: MarkdownBlock[]) {
  return left.length === right.length && left.every((block, index) => block.key === right[index].key)
}

export function sameMarkdownContent(left: string, right: string) {
  if (left === right) return true
  return sameBlocks(markdownBlocks(left), markdownBlocks(right))
}

/** Keep the exact source for top-level blocks whose Markdown meaning survived the edit. */
export function preserveMarkdownSource(source: string, edited: string) {
  const before = markdownBlocks(source)
  const after = markdownBlocks(edited)
  if (sameBlocks(before, after)) return source
  if (!after.length) return edited

  const changes = diffArrays(before, after, {
    comparator: (left, right) => left.key === right.key,
    timeout: 500,
  })
  if (!changes) throw new Error('文档改动过多，未能保留原有 Markdown 格式')
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n'
  const normalizeNewlines = (text: string) => text.replace(/\r?\n/gu, lineEnding)
  const replacements: { start: number; end: number; text: string }[] = []
  let oldIndex = 0
  let newIndex = 0
  for (const change of changes) {
    const count = change.count
    if (!change.added && !change.removed && count) {
      const oldFirst = before[oldIndex]
      const oldLast = before[oldIndex + count - 1]
      const newFirst = after[newIndex]
      const newLast = after[newIndex + count - 1]
      replacements.push({
        start: newFirst.start,
        end: newLast.end,
        text: source.slice(oldFirst.start, oldLast.end),
      })
    }
    if (!change.removed) newIndex += count
    if (!change.added) oldIndex += count
  }
  let merged = before.length ? source.slice(0, before[0].start) : ''
  let cursor = after[0].start
  for (const replacement of replacements) {
    merged += normalizeNewlines(edited.slice(cursor, replacement.start)) + replacement.text
    cursor = replacement.end
  }
  merged += normalizeNewlines(edited.slice(cursor, after.at(-1)!.end))
  merged += before.length ? source.slice(before.at(-1)!.end) : normalizeNewlines(edited.slice(after.at(-1)!.end))
  if (!sameBlocks(markdownBlocks(merged), after)) throw new Error('Markdown 格式校验失败，已保留原文件')
  return merged
}
