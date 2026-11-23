import MarkdownIt from 'markdown-it'
import type { AiRevision } from './aiDocument'

const markdown = MarkdownIt({ html: false, linkify: false }).disable(['image', 'link', 'autolink'])
const escape = markdown.utils.escapeHtml
markdown.renderer.rules.text = (tokens, index, _options, env: { references: number }) =>
  escape(tokens[index].content).replace(/\[(\d{1,2})\]/gu, (label, id: string) => {
    const ref = Number(id)
    return ref >= 1 && ref <= env.references
      ? `<button type="button" class="ai-citation" data-reference="${ref - 1}" aria-label="查看引用 ${ref}">${label}</button>`
      : label
  })

export function aiAnswerHtml(answer: string, references: number) {
  return markdown.render(answer, { references })
}

export function decodeAiAnswer(raw: string): { answer: string; revision?: AiRevision } {
  try {
    const data = JSON.parse(raw)
    if (typeof data?.answer !== 'string') return { answer: raw }
    const patch = data.revision
    return {
      answer: data.answer,
      revision: typeof patch?.markdown === 'string' && patch.markdown.trim() && patch.markdown.length <= 120_000
        ? { markdown: patch.markdown, reference: Number.isSafeInteger(patch.reference) ? patch.reference : null }
        : undefined,
    }
  } catch { return { answer: raw } }
}

export function partialAiAnswer(raw: string) {
  const match = /"answer"\s*:\s*("(?:[^"\\]|\\(?:u[\da-f]{4}|[^u]))*)/iu.exec(raw)
  if (!match) return ''
  try { return JSON.parse(match[1] + '"') as string }
  catch { return '' }
}

export function aiChangeText(before: string, after: string) {
  const limit = Math.min(before.length, after.length)
  let start = 0
  while (start < limit && before[start] === after[start]) start++
  if (start && (/[\uDC00-\uDFFF]/u.test(before[start] ?? '') || /[\uDC00-\uDFFF]/u.test(after[start] ?? ''))) start--
  let tail = 0
  while (tail < limit - start && before.at(-tail - 1) === after.at(-tail - 1)) tail++
  if (tail && /[\uDC00-\uDFFF]/u.test(before[before.length - tail])) tail--
  return {
    prefix: before.slice(0, start), suffix: tail ? before.slice(-tail) : '',
    removed: before.slice(start, before.length - tail), added: after.slice(start, after.length - tail),
  }
}
