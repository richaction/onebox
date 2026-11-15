export type CodeLanguage =
  | 'javascript' | 'typescript' | 'python' | 'rust' | 'json' | 'bash'
  | 'sql' | 'css' | 'xml' | 'yaml' | 'go' | 'java' | 'cpp' | 'diff'

const languages: Record<CodeLanguage, { label: string; aliases: string[] }> = {
  javascript: { label: 'JavaScript', aliases: ['js', 'jsx', 'mjs', 'cjs'] },
  typescript: { label: 'TypeScript', aliases: ['ts', 'tsx', 'mts', 'cts'] },
  python: { label: 'Python', aliases: ['py', 'python3'] },
  rust: { label: 'Rust', aliases: ['rs'] },
  json: { label: 'JSON', aliases: ['jsonc'] },
  bash: { label: 'Shell', aliases: ['sh', 'shell', 'zsh', 'bash-session'] },
  sql: { label: 'SQL', aliases: [] },
  css: { label: 'CSS', aliases: [] },
  xml: { label: 'XML', aliases: ['html', 'svg', 'xhtml'] },
  yaml: { label: 'YAML', aliases: ['yml'] },
  go: { label: 'Go', aliases: ['golang'] },
  java: { label: 'Java', aliases: [] },
  cpp: { label: 'C++', aliases: ['c', 'h', 'cc', 'hpp', 'c++'] },
  diff: { label: 'Diff', aliases: ['patch'] },
}

export const codeLanguageIds = Object.keys(languages) as CodeLanguage[]
const languageNames = new Map<string, CodeLanguage>()
for (const id of codeLanguageIds) {
  languageNames.set(id, id)
  for (const alias of languages[id].aliases) languageNames.set(alias, id)
}

export function codeLanguage(info: string | null | undefined) {
  const name = info?.trim().split(/\s/u, 1)[0] ?? ''
  const id = languageNames.get(name.toLowerCase())
  const plain = /^(?:txt|text|plaintext|plain)?$/iu.test(name)
  const label = name.toLowerCase() === 'html' ? 'HTML'
    : name.toLowerCase() === 'c' ? 'C'
    : id ? languages[id].label
    : plain ? '纯文本'
    : name
  return { name, id, label, plain }
}

export type CodeTone = 'comment' | 'keyword' | 'string' | 'number' | 'name' | 'meta' | 'addition' | 'deletion'
export type CodeToken = [from: number, to: number, tone: CodeTone]
