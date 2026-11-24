import { preserveMarkdownSource } from '../editor/markdownSource'
import type { EditorDocument } from '../editor/PlateEditor'
import type { WorkspacePlatform } from './platform'

/** Serialize and write one version at a time. A later edit remains pending until saved. */
export class SaveSession {
  private saved: number = 0
  private revision: number = 0
  private writer?: Promise<void>
  document: EditorDocument | null = null

  constructor(readonly path: string, private source: string, private platform: WorkspacePlatform) {}

  get dirty() { return this.saved !== this.revision }

  markEdited() { this.revision++ }

  async flush() {
    while (this.dirty) {
      if (!this.writer) {
        if (!this.document || this.document.composing()) return false
        const revision = this.revision
        const markdown = this.document.serialize()
        this.writer = this.write(markdown, revision).finally(() => { this.writer = undefined })
      }
      await this.writer
    }
    return true
  }

  private async write(markdown: string, revision: number) {
    const next = preserveMarkdownSource(this.source, markdown)
    if (next !== this.source) {
      const latest = await this.platform.read(this.path)
      if (latest !== this.source) throw new Error('磁盘上的文件已被修改，当前编辑仍保留在窗口中')
      await this.platform.write(this.path, next)
      this.source = next
    }
    this.saved = revision
  }
}
