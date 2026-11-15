import type { JSONContent } from '@tiptap/core'
import type { Node } from '@tiptap/pm/model'
import { serializeMarkdownForFile } from './markdown'

export async function serializeDocument(doc: Node) {
  if (doc.content.size < 32_768 || typeof Worker === 'undefined') {
    return serializeMarkdownForFile(doc)
  }

  const worker = new Worker(new URL('./markdownWorker.ts', import.meta.url), { type: 'module' })
  let stopped = false
  const result = new Promise<string>((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<{ text: string } | { error: string }>) => {
      stopped = true
      if ('error' in data) reject(new Error(data.error))
      else resolve(data.text)
    }
    worker.onerror = (error) => {
      stopped = true
      reject(new Error(error.message))
    }
  })
  // A worker can fail before the main thread has finished sending blocks.
  void result.catch(() => {})
  try {
    let index = 0
    while (index < doc.childCount && !stopped) {
      const batch: JSONContent[] = []
      let size = 0
      while (index < doc.childCount && batch.length < 640 && size < 65_536) {
        const block = doc.child(index++)
        batch.push(block.toJSON())
        size += block.nodeSize
      }
      worker.postMessage(batch)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    if (!stopped) worker.postMessage('finish')
    return await result
  } finally {
    worker.terminate()
  }
}
