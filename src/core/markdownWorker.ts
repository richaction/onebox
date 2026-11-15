import type { JSONContent } from '@tiptap/core'
import type { Node } from '@tiptap/pm/model'
import { serializeMarkdownForFile } from './markdown'
import { schema } from './schema'

const blocks: Node[] = []

self.onmessage = (event: MessageEvent<JSONContent[] | 'finish'>) => {
  try {
    if (event.data === 'finish') {
      const text = serializeMarkdownForFile(schema.topNodeType.createChecked(null, blocks))
      self.postMessage({ text })
      return
    }
    for (const block of event.data) blocks.push(schema.nodeFromJSON(block))
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
