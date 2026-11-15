import { onCleanup, onMount } from 'solid-js'
import type { Node } from '@tiptap/pm/model'
import { createEditor, type EditorHandle } from '../core/editor'

export default function EditorShell(props: {
  markdown: string
  onReady: (handle: EditorHandle) => void
  onUpdate: (doc: Node) => void
}) {
  let scrollRoot!: HTMLDivElement
  let element!: HTMLDivElement
  let handle: EditorHandle | undefined

  onMount(() => {
    handle = createEditor({
      element,
      scrollRoot,
      markdown: props.markdown,
      onUpdate: props.onUpdate,
    })
    props.onReady(handle)
  })
  onCleanup(() => handle?.destroy())

  return (
    <div class="editor-scroll" ref={scrollRoot}>
      <div class="editor-mount" ref={element} />
    </div>
  )
}
