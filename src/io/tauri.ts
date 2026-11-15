import { invoke } from '@tauri-apps/api/core'
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

export interface WorkspaceDocument {
  path: string
  name: string
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
  list: (path: string) => invoke<WorkspaceDocument[]>('workspace_documents', { path }),
}
