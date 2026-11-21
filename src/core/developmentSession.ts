import type { EditorState } from '@tiptap/pm/state'
import type { Node, Schema } from '@tiptap/pm/model'
import type { PreviewEntry, WorkspaceRoot } from '../io/tauri'

export interface DevelopmentSnapshot {
  path: string | null
  readonly: boolean
  workspace?: WorkspaceRoot
  preview?: PreviewEntry
  emptyAfterDeletion?: boolean
  sidebarVisible: boolean
  savedDoc?: Node
  writer?: Promise<boolean>
  editorState?: EditorState
  schemaSource?: Schema
  scrollTop: number
  focused: boolean
}

// HMR keeps references in memory. Large documents do not need serialization.
export const developmentSession: { snapshot?: DevelopmentSnapshot } =
  import.meta.hot?.data.session ?? {}

if (import.meta.hot) {
  import.meta.hot.dispose((data) => { data.session = developmentSession })
}
