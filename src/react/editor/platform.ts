export interface EditorResources {
  readImage?(href: string): Promise<Blob | undefined>
  openLink?(href: string): Promise<void>
}

export function resourceKind(href: string) {
  const trimmed = href.trim()
  if (!trimmed || /^[/\\]/u.test(trimmed)) return 'blocked'
  if (/^https?:\/\//iu.test(trimmed)) return 'web'
  if (/^[a-z][a-z\d+.-]*:/iu.test(trimmed)) return 'blocked'
  return 'relative'
}
