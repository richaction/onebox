import type MarkdownIt from 'markdown-it'

export function mathMarkdown(md: MarkdownIt) {
  md.inline.ruler.before('escape', 'onebox_math', (state, silent) => {
    const { src, pos, posMax } = state
    if (src[pos] !== '$' || src[pos - 1] === '$') return false
    const display = src[pos + 1] === '$'
    const delimiter = display ? '$$' : '$'
    const start = pos + delimiter.length
    if (start >= posMax || src[start] === '$' || (!display && /\s/u.test(src[start]))) return false

    let depth = 0
    const limit = Math.min(posMax, start + 20_002)
    for (let end = start; end < limit; end++) {
      const char = src[end]
      if (char === '\\') {
        end++
        continue
      }
      if (char === '{') depth++
      if (char === '}') depth--
      if (char !== '$' || depth !== 0) continue
      if (display !== (src[end + 1] === '$')) return false
      const next = end + delimiter.length
      if (end === start || src[next] === '$' || (!display && /\s/u.test(src[end - 1]))) return false
      if (!silent) {
        const token = state.push('onebox_math', 'span', 0)
        token.content = src.slice(start, end)
        token.meta = { display }
      }
      state.pos = next
      return true
    }
    return false
  })
}

export function mathSource(latex: string, display: boolean) {
  const delimiter = display ? '$$' : '$'
  return delimiter + latex + delimiter
}
