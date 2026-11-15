import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open, save } from '@tauri-apps/plugin-dialog'
import type { JSONContent, Range } from '@tiptap/core'
import type { Node } from '@tiptap/pm/model'
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { relativeReferences, rewriteAttachmentLinks } from './core/attachmentLinks'
import type { EditorHandle } from './core/editor'
import { collectMetrics } from './core/metrics'
import { serializeDocument } from './core/serializeDocument'
import { desktopAttachments, desktopDocuments, desktopWorkspace, tauriFileSystem, type Attachment, type WorkspaceEntry } from './io/tauri'
import EditorShell, { type AttachmentKind } from './ui/EditorShell'
import WorkspaceSidebar from './ui/WorkspaceSidebar'

const SAMPLE = '# onebox\n'
const SAVE_DEBOUNCE_MS = 800
const MARKDOWN_FILTERS = [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
const IMAGE_FILTERS = [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg', 'ico'] }]

type Failure = '打开失败' | '保存失败' | '附件操作失败' | '读取工作区失败' | '移动失败' | '移动已完成，请重新打开文档'
type Transfer = 'saveAs' | 'copy' | 'move'

function nameOf(path: string) {
  return path.split(path.startsWith('/') ? '/' : '\\').at(-1) ?? path
}

function inWorkspace(path: string, root: string) {
  const sep = root.startsWith('/') ? '/' : '\\'
  return path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function setEditable(handle: EditorHandle, editable: boolean) {
  handle.editor.setEditable(editable, false)
  handle.editor.view.dom.setAttribute('aria-readonly', String(!editable))
}

export default function App() {
  const desktop = isTauri()
  let handle: EditorHandle | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let savedDoc: Node | undefined
  let writer: Promise<boolean> | undefined
  let busy = false
  let cancelLoad = false

  const [path, setPath] = createSignal<string | null>(null)
  const [readonly, setReadonly] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [workspace, setWorkspace] = createSignal<{ root: string; entries: WorkspaceEntry[] }>()
  const [workspaceRevision, setWorkspaceRevision] = createSignal(0)
  const [workspaceReveal, setWorkspaceReveal] = createSignal<string>()
  const [workspaceMoving, setWorkspaceMoving] = createSignal(false)
  const [failure, setFailure] = createSignal<Failure>()

  const clearSaveTimer = () => {
    clearTimeout(timer)
    timer = undefined
  }

  const writeDocument = async (target: string, doc: Node) => {
    setSaving(true)
    try {
      await tauriFileSystem.writeText(target, await serializeDocument(doc))
      savedDoc = doc
      setFailure(undefined)
      return true
    } catch {
      setFailure('保存失败')
      return false
    } finally {
      setSaving(false)
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

  const readDocument = async (editor: EditorHandle, picked: string) => {
    if (!await flush()) return false

    cancelLoad = false
    setLoading(true)
    const { view } = editor.editor
    const previous = view.state
    const previousPath = path()
    let session: number | undefined
    try {
      const start = await desktopDocuments.open(picked)
      session = start.id
      if (cancelLoad) return false
      setPath(picked)
      editor.loadBlocks(start.blocks, start.total >= 4_000)
      editor.refreshImages()
      let count = start.blocks.length
      let limit = 192
      while (count < start.total) {
        const blocks = await desktopDocuments.next(start.id, limit)
        if (!blocks.length) throw new Error('Incomplete Markdown document')
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
        if (cancelLoad) {
          setPath(previousPath)
          view.updateState(previous)
          editor.refreshImages()
          return false
        }
        const before = performance.now()
        editor.appendBlocks(blocks)
        count += blocks.length
        const duration = Math.max(1, performance.now() - before)
        limit = Math.round(Math.min(512, Math.max(48, limit * Math.min(1.33, 7 / duration))))
      }
      savedDoc = editor.editor.state.doc
      setReadonly(start.readonly)
      setFailure(undefined)
      return true
    } catch (error) {
      setPath(previousPath)
      view.updateState(previous)
      editor.refreshImages()
      throw error
    } finally {
      if (session !== undefined) void desktopDocuments.release(session).catch(() => {})
      setLoading(false)
    }
  }

  const openFile = () => runFileAction(async (editor) => {
    const picked = await open({ multiple: false, filters: MARKDOWN_FILTERS })
    if (typeof picked !== 'string') return true
    return readDocument(editor, picked)
  }, '打开失败')

  const refreshWorkspace = () => setWorkspaceRevision((version) => version + 1)

  const openWorkspace = () => runFileAction(async () => {
    const picked = await open({ directory: true, recursive: true, multiple: false })
    if (typeof picked !== 'string') return true
    const entries = await desktopWorkspace.entries(picked, picked)
    setWorkspaceReveal(undefined)
    setWorkspace({ root: picked, entries })
    setFailure(undefined)
    return true
  }, '读取工作区失败')

  const relocateWorkspaceEntry = async (editor: EditorHandle, root: string, source: string, target: string, name?: string) => {
    setWorkspaceMoving(true)
    try {
      if (!await flush()) throw new Error('当前文档保存失败')
      const result = await desktopWorkspace.move(root, source, target, path(), name)
      setWorkspaceReveal(result.destination)
      refreshWorkspace()
      if (result.activeDocument) {
        setPath(result.activeDocument)
        try {
          if (!await readDocument(editor, result.activeDocument)) throw new Error('Load cancelled')
        } catch {
          setReadonly(true)
          setFailure('移动已完成，请重新打开文档')
          return
        }
      }
      setFailure(undefined)
    } finally {
      setWorkspaceMoving(false)
    }
  }

  const moveWorkspaceEntry = async (entry: WorkspaceEntry, target: string) => {
    const current = workspace()
    if (!current || busy) throw new Error('请等待当前文件操作完成')
    let cause: unknown
    const moved = await runFileAction(async (editor) => {
      try {
        await relocateWorkspaceEntry(editor, current.root, entry.path, target)
        return true
      } catch (err) {
        cause = err
        return false
      }
    }, '移动失败')
    if (!moved) throw cause ?? new Error('移动失败')
  }

  const transferDocument = (mode: Transfer) => runFileAction(async (editor) => {
    if (readonly()) return true
    const source = path()
    if (mode !== 'saveAs' && !source) return false
    const name = source ? nameOf(source) : 'Untitled.md'
    const picked = await save({
      defaultPath: mode === 'copy' ? name.replace(/\.(md|markdown)$/i, '-copy.$1') : name,
      filters: MARKDOWN_FILTERS,
    })
    if (typeof picked !== 'string') return true

    const root = workspace()?.root
    if (mode === 'move' && source && root && inWorkspace(source, root) && inWorkspace(picked, root)) {
      if (source === picked) return true
      const name = nameOf(picked)
      const folder = picked.slice(0, -name.length)
      await relocateWorkspaceEntry(editor, root, source, folder, name)
      return true
    }

    if (mode === 'move' && !await flush()) return false
    if (!source || source === picked) {
      if (mode !== 'saveAs') return true
      clearSaveTimer()
      while (writer) await writer
      if (!await writeDocument(picked, editor.editor.state.doc)) return false
      setPath(picked)
    } else {
      if (mode === 'saveAs') clearSaveTimer()
      while (writer) await writer
      const state = editor.editor.state
      const plan = await desktopAttachments.plan(source, picked, relativeReferences(state.doc))
      const relocated = rewriteAttachmentLinks(state, plan.rewrites).doc
      await desktopAttachments.transfer(source, picked, await serializeDocument(relocated), plan, mode === 'move')
      if (mode !== 'copy') {
        clearSaveTimer()
        setPath(picked)
        editor.resetDocument(relocated)
        editor.refreshImages()
        savedDoc = editor.editor.state.doc
      }
      setFailure(undefined)
    }
    refreshWorkspace()
    return true
  }, '保存失败')

  const ensureDocumentPath = async (editor: EditorHandle) => {
    if (path()) return path()
    const selected = await save({ defaultPath: 'Untitled.md', filters: MARKDOWN_FILTERS })
    if (typeof selected !== 'string' || !await writeDocument(selected, editor.editor.state.doc)) return null
    setPath(selected)
    refreshWorkspace()
    return selected
  }

  const insertAttachments = (editor: EditorHandle, attachments: Attachment[], range?: Range) => {
    if (!attachments.length) return
    const content: JSONContent[] = []
    for (const attachment of attachments) {
      if (content.length) content.push({ type: 'text', text: ' ' })
      content.push(attachment.image
        ? { type: 'image', attrs: { src: attachment.href, alt: attachment.name } }
        : { type: 'text', text: attachment.name, marks: [{ type: 'link', attrs: { href: attachment.href } }] })
    }
    if (range) editor.editor.chain().focus().insertContentAt(range, content).run()
    else editor.editor.chain().focus().insertContent(content).run()
  }

  const pickAttachment = (kind: AttachmentKind, range?: Range) => {
    void runFileAction(async (editor) => {
      const chosen = await open({ multiple: false, filters: kind === 'image' ? IMAGE_FILTERS : undefined })
      if (typeof chosen !== 'string') return true
      const document = await ensureDocumentPath(editor)
      if (!document) return false
      const attachment = await desktopAttachments.import(document, chosen)
      insertAttachments(editor, [attachment], range)
      setFailure(undefined)
      return true
    }, '附件操作失败')
  }

  const insertFiles = (files: File[]) => {
    void runFileAction(async (editor) => {
      const document = await ensureDocumentPath(editor)
      if (!document) return false
      const imported: Attachment[] = []
      try {
        for (const file of files) imported.push(await desktopAttachments.importFile(document, file))
        setFailure(undefined)
        return true
      } finally {
        insertAttachments(editor, imported)
      }
    }, '附件操作失败')
  }

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && loading()) {
      event.preventDefault()
      cancelLoad = true
      return
    }
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return
    switch (event.key.toLowerCase()) {
      case 'o':
        event.preventDefault()
        void openFile()
        break
      case 's':
        event.preventDefault()
        if (event.shiftKey || !path()) void transferDocument('saveAs')
        else if (!busy) void flush()
        break
    }
  }

  onMount(() => {
    if (!desktop) return
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
      <Show when={desktop}>
        <header class="file-actions">
          <button type="button" onClick={() => void openFile()}>打开</button>
          <button type="button" onClick={() => void openWorkspace()}>工作区</button>
          <button type="button" disabled={!path() || readonly() || loading()} onClick={() => void transferDocument('move')}>移动</button>
          <button type="button" disabled={!path() || readonly() || loading()} onClick={() => void transferDocument('copy')}>复制</button>
        </header>
      </Show>
      <div class="editor-layout">
        <Show when={workspace()} keyed>
          {(current) => (
            <WorkspaceSidebar
              root={current.root} entries={current.entries}
              active={path()} reveal={workspaceReveal()} revision={workspaceRevision()}
              onOpen={(file) => { void runFileAction((editor) => readDocument(editor, file), '打开失败') }}
              onMove={moveWorkspaceEntry} onClose={() => setWorkspace(undefined)}
            />
          )}
        </Show>
        <EditorShell
          markdown={SAMPLE}
          onReady={onReady}
          onUpdate={onUpdate}
          onInsertAttachment={desktop ? pickAttachment : undefined}
          onInsertFiles={desktop ? insertFiles : undefined}
          imageContext={path}
          readImage={desktop ? (href) => {
            const document = path()
            return document ? desktopAttachments.readImage(document, href) : Promise.resolve(undefined)
          } : undefined}
          openResource={desktop ? (href) => {
            const document = path()
            if (document) void desktopAttachments.open(document, href).catch(() => setFailure('附件操作失败'))
          } : undefined}
        />
      </div>
      <footer class="statusbar" role="status">
        <span title={path() ?? undefined}>{path() ? nameOf(path()!) : '未打开'}</span>
        <span>{loading() ? '正在载入' : saving() ? '正在保存' : workspaceMoving() ? '正在移动' : readonly() ? '只读' : ''}</span>
        <span>{failure()}</span>
      </footer>
    </main>
  )
}
