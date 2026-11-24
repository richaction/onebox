import type { EditorResources } from '../editor/platform'

export interface WorkspaceEntry {
  readonly path: string
  readonly name: string
  readonly directory: boolean
  readonly markdown: boolean
  readonly accessible?: boolean
}

export interface WorkspaceRoot {
  readonly root: string
  readonly entries: readonly WorkspaceEntry[]
}

export interface WorkspacePlatform {
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  list?(root: string, folder: string): Promise<readonly WorkspaceEntry[]>
  chooseFolder?(): Promise<WorkspaceRoot | undefined>
  chooseDocument?(): Promise<WorkspaceEntry | undefined>
  restoreWorkspace?(): Promise<WorkspaceRoot | undefined>
  resources?(path: string): EditorResources
}

export function documentEntry(path: string): WorkspaceEntry {
  const name = path.split(/[\\/]/u).at(-1) || path
  return { path, name, directory: false, markdown: /\.(?:md|markdown)$/iu.test(name) }
}
