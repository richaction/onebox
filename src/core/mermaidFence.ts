export const mermaidOpeningFence = /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid[ \t]*$/iu

export function unwrapMermaidFence(text: string): string | undefined {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  const start = lines.findIndex((line) => line.trim())
  const fence = mermaidOpeningFence.exec(lines[start] ?? '')?.[1]
  if (!fence) return

  const closingFence = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`, 'u')
  const end = lines.findIndex((line, index) => index > start && closingFence.test(line))
  if (end === -1 || lines.slice(end + 1).some((line) => line.trim())) return
  return lines.slice(start + 1, end).join('\n')
}
