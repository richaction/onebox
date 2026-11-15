import { invoke } from '@tauri-apps/api/core'
import type { FileSystem } from './types'

export const tauriFileSystem: FileSystem = {
  readText: (path) => invoke<string>('read_text', { path }),
  writeText: (path, content) => invoke<void>('write_text', { path, content }),
}
