import { Channel, invoke } from '@tauri-apps/api/core'
import type { JSONContent } from '@tiptap/core'
import type { RelativeReference } from '../core/attachmentLinks'
import type { FileSystem } from './types'

export const tauriFileSystem: FileSystem = {
  readText: (path) => invoke<string>('read_text', { path }),
  writeText: (path, content) => invoke<void>('write_text', { path, content }),
}

interface DocumentStart {
  id: number
  blocks: JSONContent[]
  total: number
  readonly: boolean
}

export const desktopDocuments = {
  open: (path: string) => invoke<DocumentStart>('open_document', { path }),
  next: (id: number, limit: number) => invoke<JSONContent[]>('document_batch', { id, limit }),
  release: (id: number) => invoke<void>('release_document', { id }),
}

export interface Attachment {
  href: string
  name: string
  image: boolean
}

interface TransferPlan {
  rewrites: Record<string, string>
  assets: { source: string; name: string; hash: string }[]
  source_hash: string
}

export interface WorkspaceEntry {
  path: string
  name: string
  directory: boolean
  markdown: boolean
  accessible?: boolean
}

export interface WorkspaceRoot {
  root: string
  entries: WorkspaceEntry[]
}

export type PreviewEntry = WorkspaceEntry & { workspaceRoot?: string }

export interface FileApplications {
  items: { path: string; name: string; default: boolean }[]
  defaultIcon: string | null
}

export const desktopWorkspace = {
  openDemo: () => invoke<WorkspaceRoot>('open_demo_workspace'),
  selectRoot: (path: string) => invoke<WorkspaceRoot>('select_workspace_root', { path }),
  restoreRoot: () => invoke<WorkspaceRoot | null>('restore_workspace_root'),
  clearRoot: () => invoke<void>('clear_workspace_root'),
  create: (root: string, folder: string, name: string, directory: boolean) =>
    invoke<WorkspaceEntry>('create_workspace_entry', { root, folder, name, directory }),
  importFiles: (root: string, folder: string, paths: string[]) =>
    invoke<{ paths: string[]; failed: number }>('import_workspace_files', { root, folder, paths }),
  openAttachment: (root: string | undefined, path: string, application?: string) => invoke<void>('open_workspace_attachment', { root, path, application }),
  fileApplications: (root: string | undefined, path: string, onList: (result: FileApplications) => void) =>
    invoke<Record<string, string>>('workspace_file_applications', { root, path, onList: new Channel(onList) }),
  preparePreview: (root: string | undefined, path: string) =>
    invoke<string | { path: string; convertedName: string }>('workspace_preview', { root, path }),
  releasePreview: (path: string) => invoke<void>('release_workspace_preview', { path }),
  entries: (root: string, folder: string) =>
    invoke<WorkspaceEntry[]>('workspace_entries', { root, folder }),
  move: (root: string, source: string, target: string, activeDocument: string | null, name?: string) =>
    invoke<{ destination: string; activeDocument: string | null }>('move_workspace_entry', {
      root, source, target, activeDocument, name,
    }),
}

const imageMimes: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
}

export const desktopAttachments = {
  import: (document: string, source: string) =>
    invoke<Attachment>('import_attachment', { document, source }),
  async importFile(document: string, file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    return invoke<Attachment>('import_inline_attachment', bytes, {
      headers: {
        'x-onebox-document': encodeURIComponent(document),
        'x-onebox-filename': encodeURIComponent(file.name),
      },
    })
  },
  async readImage(document: string, href: string) {
    const pathname = decodeURIComponent(href.split(/[?#]/u, 1)[0])
    const mime = imageMimes[pathname.split('.').at(-1)?.toLowerCase() ?? '']
    if (!mime) throw new Error('Unsupported image type')
    const bytes = await invoke<ArrayBuffer>('read_image', { document, href })
    return new Blob([bytes], { type: mime })
  },
  open: (document: string, href: string) => invoke<void>('open_relative_attachment', { document, href }),
  plan: (source: string, destination: string, refs: RelativeReference[]) =>
    invoke<TransferPlan>('plan_document_transfer', { source, destination, refs }),
  transfer: (source: string, destination: string, content: string, plan: TransferPlan, moveOriginal: boolean) =>
    invoke<void>('transfer_document', {
      source, destination, content, sourceHash: plan.source_hash, assets: plan.assets, moveOriginal,
    }),
}
