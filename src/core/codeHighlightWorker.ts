import { createLowlight } from 'lowlight'
import { codeLanguageIds, type CodeHighlightResult, type CodeLanguage, type CodeTone } from './codeLanguages'

const grammars = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  python: () => import('highlight.js/lib/languages/python'),
  rust: () => import('highlight.js/lib/languages/rust'),
  json: () => import('highlight.js/lib/languages/json'),
  bash: () => import('highlight.js/lib/languages/bash'),
  sql: () => import('highlight.js/lib/languages/sql'),
  css: () => import('highlight.js/lib/languages/css'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  go: () => import('highlight.js/lib/languages/go'),
  java: () => import('highlight.js/lib/languages/java'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  diff: () => import('highlight.js/lib/languages/diff'),
} satisfies Record<CodeLanguage, () => Promise<unknown>>

const tones = new Map<string, CodeTone>([
  ['comment', 'comment'], ['quote', 'comment'],
  ['keyword', 'keyword'], ['selector-tag', 'keyword'], ['built_in', 'keyword'],
  ['string', 'string'], ['regexp', 'string'], ['symbol', 'string'],
  ['number', 'number'], ['literal', 'number'],
  ['title', 'name'], ['type', 'name'], ['attr', 'name'], ['attribute', 'name'], ['name', 'name'],
  ['meta', 'meta'], ['selector-class', 'meta'], ['selector-id', 'meta'],
  ['addition', 'addition'], ['deletion', 'deletion'],
])
const lowlight = createLowlight()
type HighlightTree = ReturnType<typeof lowlight.highlight>

async function register(language: CodeLanguage) {
  if (!lowlight.registered(language)) lowlight.register(language, (await grammars[language]()).default)
}

function detect(text: string) {
  if (/^\s*[\[{]/u.test(text)) {
    try {
      JSON.parse(text)
      return 'json'
    } catch { /* Other languages also begin with brackets. */ }
  }
  if (/(?:^|\n)\s*(?:(?:pub|async)\s+)*fn\s+\w+\s*\(/u.test(text)) return 'rust'
  if (/^\s*(?:SELECT\b[\s\S]+?\bFROM\b|INSERT\s+INTO\b|CREATE\s+TABLE\b|UPDATE\b[\s\S]+?\bSET\b|DELETE\s+FROM\b)/iu.test(text)) return 'sql'

  let best: CodeLanguage | undefined
  let lead = 0
  let runnerUp = 0
  for (const language of codeLanguageIds) {
    const score = lowlight.highlight(language, text).data?.relevance ?? 0
    if (score > lead) {
      runnerUp = lead
      lead = score
      best = language
    } else {
      runnerUp = Math.max(runnerUp, score)
    }
  }
  return lead >= 3 && lead > runnerUp ? best : undefined
}

self.onmessage = async ({ data }: MessageEvent<{ language?: CodeLanguage; text: string }>) => {
  const result: CodeHighlightResult = { tokens: [] }
  const { tokens } = result
  try {
    let language = data.language
    if (!language) {
      await Promise.all(codeLanguageIds.map(register))
      language = detect(data.text)
      result.detected = language
    }
    if (!language) {
      self.postMessage(result)
      return
    }
    await register(language)
    const tree = lowlight.highlight(language, data.text)
    let offset = 0
    function visit(children: HighlightTree['children'], inherited?: CodeTone) {
      for (const child of children) {
        if (child.type === 'text') {
          const next = offset + child.value.length
          if (inherited && next > offset) {
            const previous = tokens.at(-1)
            if (previous?.[1] === offset && previous[2] === inherited) previous[1] = next
            else tokens.push([offset, next, inherited])
          }
          offset = next
        } else if (child.type === 'element') {
          const scope = Array.isArray(child.properties.className)
            ? child.properties.className.find((name) => String(name).startsWith('hljs-'))
            : undefined
          visit(child.children, (scope && tones.get(String(scope).slice(5))) || inherited)
        }
        if (tokens.length > 1_800) return
      }
    }
    visit(tree.children)
  } catch {
    // A failed grammar leaves the original text readable and editable.
    tokens.length = 0
  }
  if (tokens.length > 1_800) tokens.length = 0
  self.postMessage(result)
}
