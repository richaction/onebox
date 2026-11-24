const handoffKey = 'onebox:editor-handoff'

export function handoffDocument() {
  const path = sessionStorage.getItem(handoffKey) ?? undefined
  sessionStorage.removeItem(handoffKey)
  return path
}

export function switchEditor(mode: 'plate' | 'legacy', path?: string) {
  if (path) sessionStorage.setItem(handoffKey, path)
  else sessionStorage.removeItem(handoffKey)
  const url = new URL(location.href)
  url.searchParams.set('editor', mode)
  location.replace(url)
}
