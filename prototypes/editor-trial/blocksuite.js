import { AffineSchemas, MarkdownAdapter } from '@blocksuite/blocks'
import { effects as blocksEffects } from '@blocksuite/blocks/effects'
import { PageEditor } from '@blocksuite/presets'
import { effects as presetsEffects } from '@blocksuite/presets/effects'
import { DocCollection, Job, Schema } from '@blocksuite/store'
import '@toeverything/theme/style.css'

blocksEffects()
presetsEffects()

export async function mount(root, markdown) {
  const schema = new Schema().register(AffineSchemas)
  const collection = new DocCollection({ schema })
  collection.meta.initialize()
  const adapter = new MarkdownAdapter(new Job({ collection }))
  const doc = await adapter.toDoc({ file: markdown })
  if (!doc) throw new Error('无法导入 Markdown 样例')
  const editor = new PageEditor()
  editor.doc = doc
  editor.hasViewport = true
  root.append(editor)
  await editor.updateComplete
  return async () => {
    const exported = await adapter.fromDoc(doc)
    if (!exported) throw new Error('无法导出当前文档')
    return exported.file
  }
}
