import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open, save } from '@tauri-apps/plugin-dialog'
import type { Node } from '@tiptap/pm/model'
import { createSignal, onCleanup, onMount } from 'solid-js'
import type { EditorHandle } from './core/editor'
import { detectUnsupported, serializeMarkdownForFile } from './core/markdown'
import { collectMetrics } from './core/metrics'
import { tauriFileSystem } from './io/tauri'
import EditorShell from './ui/EditorShell'

const SAMPLE = '# onebox\n'
const SAVE_DEBOUNCE_MS = 800
const MARKDOWN_FILTERS = [{ name: 'Markdown', extensions: ['md'] }]

type Failure = '打开失败' | '保存失败'

function setEditable(handle: EditorHandle, editable: boolean) {
  handle.editor.setEditable(editable, false)
  handle.editor.view.dom.setAttribute('aria-readonly', String(!editable))
}

export default function App() {
  let handle: EditorHandle | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let savedDoc: Node | undefined
  let writer: Promise<boolean> | undefined
  let busy = false

  const [path, setPath] = createSignal<string | null>(null)
  const [readonly, setReadonly] = createSignal(false)
  const [failure, setFailure] = createSignal<Failure>()

  const clearSaveTimer = () => {
    clearTimeout(timer)
    timer = undefined
  }

  const writeDocument = async (target: string, doc: Node) => {
    try {
      await tauriFileSystem.writeText(target, serializeMarkdownForFile(doc))
      savedDoc = doc
      setFailure(undefined)
      return true
    } catch {
      setFailure('保存失败')
      return false
    }
  }

  const flush = async (): Promise<boolean> => {
    clearSaveTimer()
    // Waiting callers re-check the writer and the current document before starting a write.
    while (writer) {
      if (!await writer) return false
    }
    const target = path()
    const doc = handle?.editor.state.doc
    if (!target || !doc || readonly() || doc === savedDoc) return true

    writer = writeDocument(target, doc)
    try {
      return await writer
    } finally {
      writer = undefined
    }
  }

  const onUpdate = () => {
    if (!path() || readonly()) return
    clearSaveTimer()
    timer = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
  }

  const runFileAction = async (
    action: (editor: EditorHandle) => Promise<boolean>,
    error: Failure,
  ) => {
    if (busy || !handle) return false
    const editor = handle
    busy = true
    setEditable(editor, false)
    try {
      return await action(editor)
    } catch {
      setFailure(error)
      return false
    } finally {
      busy = false
      setEditable(editor, !readonly())
    }
  }

  const openFile = () => runFileAction(async (editor) => {
    const picked = await open({ multiple: false, filters: MARKDOWN_FILTERS })
    if (typeof picked !== 'string') return true
    if (!await flush()) return false

    const text = await tauriFileSystem.readText(picked)
    const unsupported = detectUnsupported(text)
    editor.loadMarkdown(text)
    savedDoc = editor.editor.state.doc
    setReadonly(unsupported.length > 0)
    setPath(picked)
    setFailure(undefined)
    return true
  }, '打开失败')

  const saveAs = () => runFileAction(async (editor) => {
    if (readonly()) return true
    const picked = await save({
      defaultPath: path()?.split(/[/\\]/).at(-1) ?? 'Untitled.md',
      filters: MARKDOWN_FILTERS,
    })
    if (typeof picked !== 'string') return true

    clearSaveTimer()
    while (writer) await writer
    if (!await writeDocument(picked, editor.editor.state.doc)) return false
    setPath(picked)
    return true
  }, '保存失败')

  const onKeydown = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return
    switch (event.key.toLowerCase()) {
      case 'o':
        event.preventDefault()
        void openFile()
        break
      case 's':
        event.preventDefault()
        if (event.shiftKey || !path()) void saveAs()
        else if (!busy) void flush()
        break
    }
  }

  onMount(() => {
    if (!isTauri()) return
    window.addEventListener('keydown', onKeydown)
    const listener = getCurrentWindow().onCloseRequested(async (event) => {
      if (busy || !handle) {
        event.preventDefault()
        return
      }
      busy = true
      setEditable(handle, false)
      if (await flush()) return

      event.preventDefault()
      busy = false
      setEditable(handle, !readonly())
    }).catch(() => {
      setFailure('保存失败')
    })
    onCleanup(() => {
      window.removeEventListener('keydown', onKeydown)
      void listener.then((unlisten) => unlisten?.())
    })
  })

  const onReady = (editor: EditorHandle) => {
    handle = editor
    if (!import.meta.env.DEV) return

    const dev = window as Window & {
      __oneboxLoad?: (text: string) => void
      __oneboxMetrics?: () => ReturnType<typeof metrics>
    }
    const metrics = () => ({
      ...collectMetrics(editor.editor.view),
      documentNodes: document.querySelectorAll('*').length,
      viewport: { ...editor.viewportMetrics },
    })
    dev.__oneboxLoad = (text) => {
      if (path() || busy) throw new Error('Close the current document before loading a benchmark')
      editor.loadMarkdown(text)
    }
    dev.__oneboxMetrics = metrics
    const interval = setInterval(() => console.debug('[onebox metrics]', metrics()), 2000)
    onCleanup(() => {
      clearInterval(interval)
      delete dev.__oneboxLoad
      delete dev.__oneboxMetrics
    })
  }

  onCleanup(clearSaveTimer)

  return (
    <main class="app">
      <EditorShell markdown={SAMPLE} onReady={onReady} onUpdate={onUpdate} />
      <footer class="statusbar" role="status">
        <span title={path() ?? undefined}>{path()?.split(/[/\\]/).at(-1) ?? '未打开'}</span>
        <span>{readonly() ? '只读' : ''}</span>
        <span>{failure()}</span>
      </footer>
    </main>
  )
}
