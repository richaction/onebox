import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open, save } from '@tauri-apps/plugin-dialog'
import type { JSONContent, Range } from '@tiptap/core'
import type { Node } from '@tiptap/pm/model'
import { createEffect, createSignal, flush as flushSolid, onCleanup, onSettled, Show } from 'solid-js'
import { relativeReferences, rewriteAttachmentLinks } from './core/attachmentLinks'
import type { EditorHandle } from './core/editor'
import { closeEmptyContinuation, documentWithoutEmptyContinuation } from './core/editorCaret'
import { developmentSession, type DevelopmentSnapshot } from './core/developmentSession'
import { EditorState, Selection } from '@tiptap/pm/state'
import { schema } from './core/schema'
import { collectMetrics } from './core/metrics'
import { serializeDocument } from './core/serializeDocument'
import { desktopAttachments, desktopDocuments, desktopWorkspace, tauriFileSystem, type Attachment, type PreviewEntry, type WorkspaceEntry, type WorkspaceRoot } from './io/tauri'
import { captureAiReference, type AiReference } from './core/aiDocument'
import AiSidebar, { type AiConversationHistory } from './ui/AiSidebar'
import AiSidebarToggle from './ui/AiSidebarToggle'
import EditorShell, { type AttachmentKind } from './ui/EditorShell'
import FilePreview from './ui/FilePreview'
import PreviewLoading, { createLoadingHint } from './ui/PreviewLoading'
import FileName, { splitName, type TitleEdit } from './ui/FileName'
import WorkspaceSidebar, { type WorkspaceSelection } from './ui/WorkspaceSidebar'
import WorkspaceSelectionPreview from './ui/WorkspaceSelectionPreview'
import WorkspaceResizeHandle, { initialSidebarWidth } from './ui/WorkspaceResizeHandle'

const SAVE_DEBOUNCE_MS = 800
const TITLE_SAVE_DELAY_MS = 700
const AUTO_SAVE_HINT_MS = 2200
const MARKDOWN_FILTERS = [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
const IMAGE_FILTERS = [{ name: '图片', extensions: ['png', 'apng', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg', 'ico'] }]

type Failure = '打开失败' | '保存失败' | '附件操作失败' | '读取工作区失败' | '复制失败' | '移动失败' | '移动已完成，请重新打开文档' | '导入失败' | '删除失败' | '重命名失败' | '重命名已完成，请重新打开文档'

function nameOf(path: string) {
  return path.split(path.startsWith('/') ? '/' : '\\').at(-1) ?? path
}

function inWorkspace(path: string, root: string) {
  const sep = root.startsWith('/') ? '/' : '\\'
  return path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function setEditable(handle: EditorHandle, editable: boolean) {
  if (!editable) closeEmptyContinuation(handle.editor.view)
  handle.editor.setEditable(editable, false)
  handle.editor.view.dom.setAttribute('aria-readonly', String(!editable))
}

export default function App() {
  const restored = import.meta.env.DEV ? developmentSession.snapshot : undefined
  const desktop = isTauri()
  const mac = desktop && /Mac OS X/u.test(navigator.userAgent)
  let handle: EditorHandle | undefined
  let workspaceSlot: HTMLDivElement | undefined
  let sidebarToggle: HTMLButtonElement | undefined
  let aiToggle: HTMLButtonElement | undefined
  const aiHistoryByDocument = new Map<string, AiConversationHistory>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let autoSaveHintTimer: ReturnType<typeof setTimeout> | undefined
  let savedDoc: Node | undefined = restored?.savedDoc
  let writer: Promise<boolean> | undefined = restored?.writer
  let titleTimer: ReturnType<typeof setTimeout> | undefined
  let titleWrite: Promise<boolean> | undefined
  let titleDue = false
  let busy = false
  let cancelLoad = false
  let openingPath: string | undefined
  let openingTask: Promise<boolean> | undefined
  let disposed = false
  let developmentPreparing: string | undefined
  let loadBefore: { path: string | null; state: EditorState; readonly: boolean; emptyAfterDeletion: boolean; scrollTop: number } | undefined
  if (writer) {
    const pending = writer
    void pending.then(() => { if (writer === pending) writer = undefined })
  }

  const [path, setPath] = createSignal<string | null>(restored?.path ?? null)
  const [readonly, setReadonly] = createSignal(restored?.readonly ?? false)
  const [loading, setLoading] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [autoSaveHint, setAutoSaveHint] = createSignal(false)
  const [workspace, setWorkspace] = createSignal<WorkspaceRoot | undefined>(restored?.workspace)
  const [preview, setPreview] = createSignal<PreviewEntry | undefined>(restored?.preview)
  const [emptyAfterDeletion, setEmptyAfterDeletion] = createSignal(restored?.emptyAfterDeletion ?? false)
  const [pendingOpen, setPendingOpen] = createSignal<{ entry: WorkspaceEntry; root: string }>()
  const [pickedDocument, setPickedDocument] = createSignal<WorkspaceEntry>()
  const [restoringWorkspace, setRestoringWorkspace] = createSignal(desktop && !restored)
  const [sidebarVisible, setSidebarVisible] = createSignal(restored?.sidebarVisible ?? true)
  const [titleBarButtonCenter, setTitleBarButtonCenter] = createSignal<string>()
  const [aiOpen, setAiOpen] = createSignal(false)
  const [aiQuote, setAiQuote] = createSignal<{ path: string; reference: AiReference }>()
  const [sidebarWidth, setSidebarWidth] = createSignal(initialSidebarWidth('workspace'))
  const [resizingSidebar, setResizingSidebar] = createSignal(false)
  const [workspaceRevision, setWorkspaceRevision] = createSignal(0)
  const [workspaceSelection, setWorkspaceSelection] = createSignal<WorkspaceSelection>()
  const [selectionFilePreviewOpen, setSelectionFilePreviewOpen] = createSignal(false)
  const [selectionReset, setSelectionReset] = createSignal(0)
  const [workspaceReveal, setWorkspaceReveal] = createSignal<string>()
  const [workspaceMoving, setWorkspaceMoving] = createSignal(false)
  const [importTarget, setImportTarget] = createSignal<string>()
  const [workspaceImporting, setWorkspaceImporting] = createSignal(false)
  const [importMessage, setImportMessage] = createSignal<string>()
  const [failure, setFailure] = createSignal<Failure>()
  const [titleDraft, setTitleDraft] = createSignal<{ entry: WorkspaceEntry; stem: string; error?: string }>()
  const [workspaceRename, setWorkspaceRename] = createSignal<{ source: string; destination: string; name: string }>()
  const activeFile = () => preview()?.path ?? (emptyAfterDeletion() ? null : path())
  const selectionPreview = () => {
    const selection = workspaceSelection()
    return selection?.showOverview() ? selection : undefined
  }
  const openingEntry = () => {
    const entry = pendingOpen()?.entry ?? pickedDocument()
    return entry?.path === activeFile() ? undefined : entry
  }
  const loadingStatus = createLoadingHint(() => !!openingEntry() || loading())
  createEffect(() => [titleDraft(), activeFile()] as const, ([draft, active]) => {
    if (draft?.error && draft.entry.path !== active) setTitleDraft(undefined)
  })
  const sidebarLabel = () => sidebarVisible() ? '关闭侧栏' : '打开侧栏'
  const toggleSidebar = () => {
    if (sidebarVisible() && workspaceSlot?.contains(document.activeElement)) {
      sidebarToggle?.focus({ preventScroll: true })
    }
    setSidebarVisible((visible) => !visible)
  }

  const openAi = (range?: Range) => {
    const document = path()
    if (!document || preview()) return
    setAiOpen(true)
    const editor = handle?.editor
    if (!editor || loading()) return
    const reference = captureAiReference(editor, 'selection', nameOf(document), range)
    if (reference) setAiQuote({ path: document, reference })
  }
  const closeAi = () => {
    if (!aiOpen()) return
    setAiOpen(false)
    queueMicrotask(() => {
      if (!aiOpen() && aiToggle?.isConnected) aiToggle.focus({ preventScroll: true })
    })
  }
  const aiHistory = (file: string) => {
    const previous = aiHistoryByDocument.get(file)
    if (previous) return previous
    const history: AiConversationHistory = { active: 0, next: 0, conversations: [] }
    aiHistoryByDocument.set(file, history)
    return history
  }
  const pickAiReference = async (): Promise<AiReference | undefined> => {
    const document = await open({ multiple: false, filters: MARKDOWN_FILTERS, defaultPath: workspace()?.root })
    if (typeof document !== 'string') return
    if (document === path() && handle) return captureAiReference(handle.editor, 'page', nameOf(document))
    const text = await tauriFileSystem.readText(document)
    if (!text.trim()) throw new Error('这个 Markdown 文件没有可引用的文字。')
    return {
      label: nameOf(document), text: text.slice(0, 24_000), external: true,
      shortened: text.length > 24_000 ? true : undefined,
    }
  }

  const editorIsEditable = () => !developmentPreparing && !emptyAfterDeletion() && (!desktop || (!!path() && !readonly()))

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
    if (!target || !handle || readonly()) return true
    const doc = documentWithoutEmptyContinuation(handle.editor.state)
    if (savedDoc && doc.eq(savedDoc)) return true

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
    if (busy || developmentPreparing || !handle) return false
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
      if (handle && !disposed && !handle.editor.isDestroyed) setEditable(handle, editorIsEditable())
      queueMicrotask(resumeFileActions)
    }
  }

  const readDocument = async (editor: EditorHandle, picked: string, reveal = true) => {
    if (!openingPath || !reveal) cancelLoad = false
    if (!await flush() || cancelLoad) return false
    setLoading(true)
    const { view } = editor.editor
    const previous = view.state
    const previousPath = path()
    const previousPreview = preview()
    const previousEmpty = emptyAfterDeletion()
    loadBefore = { path: previousPath, state: previous, readonly: readonly(), emptyAfterDeletion: previousEmpty,
      scrollTop: view.dom.closest('.editor-scroll')?.scrollTop ?? 0 }
    let session: number | undefined
    try {
      const start = await desktopDocuments.open(picked)
      session = start.id
      if (cancelLoad || disposed) return false
      setPath(picked)
      if (reveal) {
        setPreview(undefined)
        setEmptyAfterDeletion(false)
      }
      flushSolid()
      editor.loadBlocks(start.blocks, start.total >= 4_000)
      editor.refreshImages()
      let count = start.blocks.length
      let limit = 192
      while (count < start.total) {
        const blocks = await desktopDocuments.next(start.id, limit)
        if (!blocks.length) throw new Error('Incomplete Markdown document')
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
        if (cancelLoad || disposed) {
          if (disposed) return false
          setPath(previousPath)
          if (reveal) {
            setPreview(previousPreview)
            setEmptyAfterDeletion(previousEmpty)
          }
          flushSolid()
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
      if (disposed) return false
      setPath(previousPath)
      if (reveal) {
        setPreview(previousPreview)
        setEmptyAfterDeletion(previousEmpty)
      }
      flushSolid()
      view.updateState(previous)
      editor.refreshImages()
      throw error
    } finally {
      if (session !== undefined) void desktopDocuments.release(session).catch(() => {})
      setLoading(false)
      loadBefore = undefined
    }
  }

  const openFile = async (folder?: string) => {
    let openedPath: string | undefined
    await runFileAction(async (editor) => {
      const picked = await open({ multiple: false, defaultPath: folder })
      if (typeof picked !== 'string') return true
      setSelectionReset((version) => version + 1)
      const root = workspace()?.root
      const entry = fileEntry(picked)
      if (folder && root) {
        const separator = folder.startsWith('/') ? '/' : '\\'
        const parent = picked.slice(0, picked.lastIndexOf(separator) + 1)
        const destination = folder.endsWith(separator) ? folder : folder + separator
        if (parent !== destination) {
          if (picked === path() && !await flush()) return false
          const [imported] = await importWorkspaceFiles(root, folder, [picked], true)
          openedPath = imported
          return !!imported
        }
      }
      if (entry.markdown) {
        setPickedDocument(entry)
        try {
          if (!await readDocument(editor, picked)) return false
        } finally {
          setPickedDocument(undefined)
        }
      } else {
        setPreview({ ...entry, workspaceRoot: root && inWorkspace(picked, root) ? root : undefined })
        setFailure(undefined)
      }
      if (root && inWorkspace(picked, root)) {
        setWorkspaceReveal(picked)
        refreshWorkspace()
        openedPath = picked
      } else setWorkspaceReveal(undefined)
      return true
    }, '打开失败')
    return openedPath
  }

  const fileEntry = (file: string): WorkspaceEntry => ({
    path: file, name: nameOf(file), directory: false, markdown: /\.(md|markdown)$/iu.test(file),
  })

  const refreshWorkspace = () => setWorkspaceRevision((version) => version + 1)

  const openWorkspace = () => runFileAction(async () => {
    const picked = await open({ directory: true, recursive: true, multiple: false })
    if (typeof picked !== 'string') return true
    setWorkspaceReveal(undefined)
    setWorkspace(await desktopWorkspace.selectRoot(picked))
    setPreview(undefined)
    setSidebarVisible(true)
    setFailure(undefined)
    return true
  }, '读取工作区失败')

  const closeWorkspace = () => runFileAction(async () => {
    await desktopWorkspace.clearRoot()
    setPreview(undefined)
    setWorkspace(undefined)
    setWorkspaceReveal(undefined)
    setFailure(undefined)
    return true
  }, '读取工作区失败')

  const openDemoWorkspace = () => runFileAction(async (editor) => {
    if (!await flush()) return false
    const current = await desktopWorkspace.openDemo()
    setWorkspace(current)
    setWorkspaceReveal(undefined)
    setSidebarVisible(true)
    setPreview(undefined)
    setFailure(undefined)
    const guide = current.entries.find((entry) => entry.name === '00 开始测试.md')
    return guide ? readDocument(editor, guide.path) : true
  }, '读取工作区失败')

  const createWorkspaceEntry = async (folder: string, name: string, directory: boolean, onCreated: (entry: WorkspaceEntry) => void) => {
    const current = workspace()
    if (!current || busy) throw new Error('请先打开工作区并等待文件操作完成')
    let cause: unknown
    let opened = false
    const success = await runFileAction(async (editor) => {
      try {
        if (!await flush()) throw new Error('当前文档保存失败')
        const entry = await desktopWorkspace.create(current.root, folder, name, directory)
        onCreated(entry)
        setWorkspaceReveal(entry.path)
        refreshWorkspace()
        setFailure(undefined)
        if (entry.markdown) {
          try {
            opened = await readDocument(editor, entry.path)
          } catch {
            setFailure('打开失败')
          }
        }
        return true
      } catch (err) {
        cause = err
        return false
      }
    }, '保存失败')
    if (!success) throw cause ?? new Error('新建失败')
    if (opened) requestAnimationFrame(() => handle?.editor.view.focus())
  }

  const trashWorkspaceEntry = async (entry: WorkspaceEntry) => {
    const current = workspace()
    if (!current || busy) throw new Error('请等待当前文件操作完成')
    const contains = (target?: string | null) =>
      !!target && (target === entry.path || (entry.directory && inWorkspace(target, entry.path)))
    let cause: unknown
    const deleted = await runFileAction(async (editor) => {
      try {
        if (contains(path()) && !await flush()) throw new Error('当前文档保存失败')
        await desktopWorkspace.trash(current.root, entry.path)
        const removingActive = contains(activeFile())
        if (contains(path())) {
          setPath(null)
          setReadonly(false)
          editor.loadMarkdown('')
          savedDoc = editor.editor.state.doc
        }
        if (contains(preview()?.path)) setPreview(undefined)
        if (removingActive) setEmptyAfterDeletion(true)
        if (contains(pendingOpen()?.entry.path)) setPendingOpen(undefined)
        if (contains(workspaceReveal())) setWorkspaceReveal(undefined)
        refreshWorkspace()
        setFailure(undefined)
        return true
      } catch (err) {
        cause = err
        return false
      }
    }, '删除失败')
    if (!deleted) throw cause ?? new Error('删除失败')
  }

  const openWorkspaceEntry = (entry: WorkspaceEntry) => {
    const current = workspace()
    if (!current) return
    if (workspaceReveal() !== entry.path) setWorkspaceReveal(undefined)
    setPendingOpen({ entry, root: current.root })
    if (openingPath && openingPath !== entry.path) cancelLoad = true
    queueMicrotask(openPendingEntry)
  }

  function openPendingEntry() {
    const pending = pendingOpen()
    if (!pending || busy || titleWrite || titleDue || developmentPreparing || openingPath || !handle) return
    const { entry, root } = pending
    if (workspace()?.root !== root) {
      setPendingOpen(undefined)
      return
    }
    if (entry.markdown) {
      openingPath = entry.path
      cancelLoad = false
      openingTask = runFileAction(async (editor) => {
        if (path() !== entry.path) return readDocument(editor, entry.path)
        setPreview(undefined)
        setEmptyAfterDeletion(false)
        setFailure(undefined)
        return true
      }, '打开失败').finally(() => {
        openingTask = undefined
        openingPath = undefined
        if (pendingOpen() === pending) setPendingOpen(undefined)
        queueMicrotask(openPendingEntry)
      })
    } else {
      setPendingOpen(undefined)
      const currentPreview = preview()
      if (currentPreview?.path !== entry.path || currentPreview.workspaceRoot !== root) {
        setPreview({ ...entry, workspaceRoot: root })
      }
      setFailure(undefined)
    }
  }

  const renameEntry = async (entry: WorkspaceEntry, stem: string) => {
    const current = workspace()?.root
    const root = current && inWorkspace(entry.path, current) ? current : undefined
    let result: Awaited<ReturnType<typeof desktopWorkspace.rename>> | undefined
    let cause: unknown
    await runFileAction(async (editor) => {
      try {
        if (!await flush()) throw new Error('当前文档保存失败')
        result = await desktopWorkspace.rename(root, entry.path, stem, path())
      } catch (error) {
        cause = error
        return false
      }
      const { destination, activeDocument, activeDocumentChanged } = result
      if (destination !== entry.path) {
        const relocate = (path: string) => (path === entry.path || (entry.directory && inWorkspace(path, entry.path)))
          ? destination + path.slice(entry.path.length) : path
        if (root) setWorkspaceRename({ source: entry.path, destination, name: nameOf(destination) })
        setTitleDraft((draft) => {
          if (!draft) return draft
          const target = relocate(draft.entry.path)
          return target === draft.entry.path ? draft
            : { ...draft, entry: { ...draft.entry, path: target, name: nameOf(target) } }
        })
        if (activeDocument) setPath(activeDocument)
        setPreview((currentPreview) => {
          if (!currentPreview) return currentPreview
          const target = relocate(currentPreview.path)
          return target === currentPreview.path ? currentPreview
            : { ...currentPreview, path: target, name: nameOf(target) }
        })
        setPendingOpen((pending) => {
          if (!pending) return pending
          const target = relocate(pending.entry.path)
          return target === pending.entry.path ? pending
            : { ...pending, entry: { ...pending.entry, path: target, name: nameOf(target) } }
        })
        if (root) {
          setWorkspaceReveal(destination)
          refreshWorkspace()
        }
      }
      setFailure(undefined)
      if (activeDocument && activeDocumentChanged) {
        const scroller = editor.editor.view.dom.closest('.editor-scroll')
        const scrollTop = scroller?.scrollTop ?? 0
        const selection = editor.editor.state.selection.toJSON()
        try {
          if (!await readDocument(editor, activeDocument, false)) throw new Error('Load cancelled')
          // Preserve the caret if the parsed blocks still support the old position.
          try {
            const view = editor.editor.view
            const restored = Selection.fromJSON(view.state.doc, selection)
            view.dispatch(view.state.tr.setSelection(restored))
          } catch { /* Link updates can remove or shift the old position. */ }
          if (scroller) scroller.scrollTop = scrollTop
        } catch {
          setReadonly(true)
          setFailure('重命名已完成，请重新打开文档')
        }
      }
      return true
    }, '重命名失败')
    if (!result) throw cause ?? new Error('请等待当前文件操作完成')
    return result.destination
  }

  const pauseTitle = () => {
    clearTimeout(titleTimer)
    titleDue = false
  }

  function resumeFileActions() {
    if (disposed || titleWrite) return
    if (titleDue) void saveTitle()
    else openPendingEntry()
  }

  function saveTitle(): Promise<boolean> {
    clearTimeout(titleTimer)
    const draft = titleDraft()
    if (!draft) {
      titleDue = false
      return Promise.resolve(true)
    }
    if (draft.error) return Promise.resolve(false)
    titleDue = true
    if (titleWrite) return titleWrite
    if (busy || !handle || developmentPreparing) return Promise.resolve(false)
    titleDue = false
    if (draft.stem === splitName(draft.entry.name).stem) {
      setTitleDraft(undefined)
      queueMicrotask(openPendingEntry)
      return Promise.resolve(true)
    }
    if (!draft.stem.trim()) {
      setTitleDraft({ ...draft, error: '请输入文件名' })
      queueMicrotask(openPendingEntry)
      return Promise.resolve(false)
    }
    titleWrite = renameEntry(draft.entry, draft.stem).then((destination) => {
      setTitleDraft((current) => current?.entry.path === destination && current.stem === draft.stem
        ? undefined : current)
      return true
    }, (failure) => {
      if (titleDraft() === draft) {
        titleDue = false
        setTitleDraft({ ...draft, error: failure instanceof Error ? failure.message : String(failure) })
      }
      return false
    }).finally(() => {
      titleWrite = undefined
      resumeFileActions()
    })
    return titleWrite
  }

  const titleEdit = (entry: WorkspaceEntry): TitleEdit => {
    const draft = () => titleDraft()?.entry.path === entry.path ? titleDraft() : undefined
    return {
      get stem() { return draft()?.stem ?? splitName(entry.name).stem },
      get error() { return draft()?.error },
      onInput(stem) {
        if (activeFile() !== entry.path) return
        pauseTitle()
        setTitleDraft({ entry, stem })
        titleTimer = setTimeout(() => void saveTitle(), TITLE_SAVE_DELAY_MS)
      },
      onPause: pauseTitle,
      onSave() { if (draft()) void saveTitle() },
      onCancel() {
        if (!draft() || titleWrite) return
        pauseTitle()
        setTitleDraft(undefined)
        resumeFileActions()
      },
    }
  }

  const displayedName = (entry: WorkspaceEntry) => {
    const draft = titleDraft()
    return draft?.entry.path === entry.path && draft.stem.trim() && !draft.error
      ? draft.stem + splitName(entry.name).suffix : entry.name
  }

  const openWorkspaceAttachment = (entry: PreviewEntry, application?: string) => {
    void desktopWorkspace.openAttachment(entry.workspaceRoot, entry.path, application).catch(() => setFailure('打开失败'))
  }

  const relocateWorkspaceEntry = async (editor: EditorHandle, root: string, entry: WorkspaceEntry, target: string) => {
    setWorkspaceMoving(true)
    try {
      if (!await flush()) throw new Error('当前文档保存失败')
      const result = await desktopWorkspace.move(root, entry.path, target, path())
      setPreview((current) => {
        if (!current || (current.path !== entry.path && !(entry.directory && inWorkspace(current.path, entry.path)))) return current
        const destination = result.destination + current.path.slice(entry.path.length)
        return { ...current, path: destination, name: nameOf(destination) }
      })
      setWorkspaceReveal(result.destination)
      refreshWorkspace()
      if (result.activeDocument) {
        setPath(result.activeDocument)
        flushSolid()
        try {
          if (!await readDocument(editor, result.activeDocument, false)) throw new Error('Load cancelled')
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
        await relocateWorkspaceEntry(editor, current.root, entry, target)
        return true
      } catch (err) {
        cause = err
        return false
      }
    }, '移动失败')
    if (!moved) throw cause ?? new Error('移动失败')
  }

  const containsCurrentDocument = (entry: WorkspaceEntry) => {
    const document = path()
    return !!document && (document === entry.path || (entry.directory && inWorkspace(document, entry.path)))
  }

  const copyWorkspaceEntriesToClipboard = async (entries: WorkspaceEntry[]) => {
    const current = workspace()
    if (!current) throw new Error('请先打开此工作区')
    while (openingTask) await openingTask
    if (workspace() !== current || developmentPreparing || disposed) throw new Error('工作区已切换，请重新复制')
    if (entries.some(containsCurrentDocument)) {
      if (busy) throw new Error('请等待当前文件操作完成')
      if (!await flush()) throw new Error('当前文档保存失败')
    }
    return desktopWorkspace.copyToClipboard(current.root, entries.map((entry) => entry.path))
  }

  const pasteWorkspaceEntry = async (entry: WorkspaceEntry, target: string, move: boolean) => {
    const current = workspace()
    while (openingTask) await openingTask
    if (!current || workspace() !== current || busy) throw new Error('请等待当前文件操作完成')
    if (move) return moveWorkspaceEntry(entry, target)
    let cause: unknown
    const copied = await runFileAction(async () => {
      try {
        if (containsCurrentDocument(entry) && !await flush()) throw new Error('当前文档保存失败')
        const destination = await desktopWorkspace.copy(current.root, entry.path, target)
        setWorkspaceReveal(destination)
        refreshWorkspace()
        setFailure(undefined)
        return true
      } catch (err) {
        cause = err
        return false
      }
    }, '复制失败')
    if (!copied) throw cause ?? new Error('复制失败')
  }

  const pasteWorkspaceClipboard = async (folder: string, localChangeCount?: number) => {
    const current = workspace()
    while (openingTask) await openingTask
    if (!current || workspace() !== current || busy || developmentPreparing || workspaceImporting()) {
      throw new Error('请等待当前文件操作完成')
    }
    setWorkspaceImporting(true)
    try {
      const result = await desktopWorkspace.pasteFromClipboard(current.root, folder, localChangeCount)
      if (!result) return 'local'
      if (!result.paths.length && !result.failed) return 'empty'
      if (!disposed && workspace() === current) {
        if (result.paths.length) {
          setWorkspaceReveal(result.paths[0])
          refreshWorkspace()
        }
        setFailure(undefined)
        setImportMessage(result.failed
          ? `已粘贴 ${result.paths.length} 项，${result.failed} 项无法粘贴`
          : `已粘贴 ${result.paths.length} 项`)
      }
      return 'pasted'
    } finally {
      setWorkspaceImporting(false)
    }
  }

  const saveAs = () => runFileAction(async (editor) => {
    if (readonly()) return true
    const source = path()
    if (!source) return false
    const picked = await save({ defaultPath: nameOf(source), filters: MARKDOWN_FILTERS })
    if (typeof picked !== 'string') return true

    clearSaveTimer()
    while (writer) await writer
    if (source === picked) {
      if (!await writeDocument(picked, editor.editor.state.doc)) return false
      setPath(picked)
    } else {
      const state = editor.editor.state
      const plan = await desktopAttachments.plan(source, picked, relativeReferences(state.doc))
      const relocated = rewriteAttachmentLinks(state, plan.rewrites).doc
      await desktopAttachments.transfer(source, picked, await serializeDocument(relocated), plan, false)
      setPath(picked)
      flushSolid()
      editor.resetDocument(relocated)
      editor.refreshImages()
      savedDoc = editor.editor.state.doc
      setFailure(undefined)
    }
    refreshWorkspace()
    return true
  }, '保存失败')

  const insertAttachments = (editor: EditorHandle, attachments: Attachment[], range?: Range) => {
    if (!attachments.length) return
    const hasImages = attachments.some((attachment) => attachment.image)
    const content: JSONContent[] = []
    for (const attachment of attachments) {
      const inline: JSONContent = attachment.image
        ? { type: 'image', attrs: { src: attachment.href, alt: attachment.name } }
        : { type: 'text', text: attachment.name, marks: [{ type: 'link', attrs: { href: attachment.href } }] }
      if (hasImages) content.push({ type: 'paragraph', content: [inline] })
      else {
        if (content.length) content.push({ type: 'text', text: ' ' })
        content.push(inline)
      }
    }
    if (range) editor.editor.chain().focus().insertContentAt(range, content).run()
    else editor.editor.chain().focus().insertContent(content).run()
  }

  const pickAttachment = (kind: AttachmentKind, range?: Range) => {
    const document = path()
    if (!document) return
    void runFileAction(async (editor) => {
      const chosen = await open({ multiple: false, filters: kind === 'image' ? IMAGE_FILTERS : undefined })
      if (typeof chosen !== 'string') return true
      const attachment = await desktopAttachments.import(document, chosen)
      insertAttachments(editor, [attachment], range)
      setFailure(undefined)
      return true
    }, '附件操作失败')
  }

  const insertFiles = (files: (File | string)[], range?: Range) => {
    const document = path()
    if (!document) return
    void runFileAction(async (editor) => {
      const imported: Attachment[] = []
      try {
        for (const file of files) {
          imported.push(await (typeof file === 'string'
            ? desktopAttachments.import(document, file) : desktopAttachments.importFile(document, file)))
        }
        setFailure(undefined)
        return true
      } finally {
        insertAttachments(editor, imported, range)
      }
    }, '附件操作失败')
  }

  const importWorkspaceFiles = async (root: string, folder: string, files: string[], openCopy = false) => {
    if (workspaceImporting()) return []
    setWorkspaceImporting(true)
    setImportMessage(undefined)
    setFailure(undefined)
    try {
      const result = await desktopWorkspace.importFiles(root, folder, files)
      if (workspace()?.root !== root) return []
      if (result.paths.length) {
        setWorkspaceReveal(result.paths[0])
        refreshWorkspace()
      }
      setImportMessage(result.failed
        ? `已导入 ${result.paths.length} 项，${result.failed} 项无法导入`
        : `已导入 ${result.paths.length} 个文件`)
      if (openCopy && result.paths.length === 1) openWorkspaceEntry(fileEntry(result.paths[0]))
      return result.paths
    } catch {
      setFailure('导入失败')
      return []
    } finally {
      setWorkspaceImporting(false)
    }
  }

  const listenForFileDrops = () => getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (disposed) return
    if (selectionFilePreviewOpen() || payload.type === 'leave') {
      setImportTarget(undefined)
      return
    }
    // Wry's macOS drag coordinates come from AppKit in points.
    const scale = mac ? 1 : window.devicePixelRatio || 1
    const point = { left: payload.position.x / scale, top: payload.position.y / scale }
    const target = document.elementFromPoint(point.left, point.top)
    const root = workspace()?.root
    const row = target?.closest<HTMLElement>('[data-workspace-entry]')
    const folder = root && sidebarVisible() && target?.closest('#workspace-sidebar')
      ? row?.dataset.workspaceFolder ?? row?.dataset.workspaceParent
        ?? target.closest<HTMLElement>('[data-workspace-folder]')?.dataset.workspaceFolder ?? root
      : undefined
    setImportTarget(payload.type === 'drop' ? undefined : folder)
    if (payload.type !== 'drop' || !payload.paths.length) return
    if (root && folder) void importWorkspaceFiles(root, folder, payload.paths)
    else if (handle && !preview() && editorIsEditable() && target?.closest('.ProseMirror')) {
      const pos = handle.editor.view.posAtCoords(point)?.pos
      insertFiles(payload.paths, pos === undefined ? undefined : { from: pos, to: pos })
    }
  })

  const autoSaveMessage = () => autoSaveHint() ? '无需手动保存，编辑会自动保存' : ''

  const showAutoSaveHint = () => {
    clearTimeout(autoSaveHintTimer)
    setAutoSaveHint(true)
    autoSaveHintTimer = setTimeout(() => setAutoSaveHint(false), AUTO_SAVE_HINT_MS)
  }

  const onKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || selectionFilePreviewOpen()) return
    if (event.key === 'Escape' && loading()) {
      event.preventDefault()
      cancelLoad = true
      return
    }
    if (event.key === 'Escape' && preview() && !document.querySelector('dialog[open], .workspace-context-menu, [role="menu"]:popover-open')) {
      setPreview(undefined)
      return
    }
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return
    switch (event.key.toLowerCase()) {
      case '\\':
        if (document.querySelector('dialog[open]')) return
        event.preventDefault()
        toggleSidebar()
        break
      case 'o':
        event.preventDefault()
        if (!restoringWorkspace()) void (event.shiftKey ? openWorkspace() : openFile())
        break
      case 's':
        event.preventDefault()
        if (event.shiftKey) {
          if (path() && (!emptyAfterDeletion() || preview())) void saveAs()
          break
        }
        showAutoSaveHint()
        break
    }
  }

  onSettled(() => {
    if (!desktop) return
    if (mac) {
      void invoke<number | null>('title_bar_button_center').then((center) => {
        if (!disposed && center !== null && center > 0 && Number.isFinite(center)) setTitleBarButtonCenter(`${center}px`)
      }).catch(() => {})
    }
    if (!restored) {
      void desktopWorkspace.restoreRoot().then(async (current) => {
        if (disposed) return
        if (current) setWorkspace(current)
        if (import.meta.env.DEV) {
          const document = await invoke<string | null>('restore_document')
          if (!document || disposed) return
          await runFileAction((editor) => readDocument(editor, document), '打开失败')
          restoreDevelopmentPosition(document)
        }
      }).catch(() => { if (!disposed) setFailure('读取工作区失败') }).finally(() => {
        if (!disposed) setRestoringWorkspace(false)
      })
    }
    window.addEventListener('keydown', onKeydown)
    const fileDrops = desktop ? listenForFileDrops().catch(() => { setFailure('导入失败') }) : undefined
    const listener = getCurrentWindow().onCloseRequested(async (event) => {
      if (busy || !handle) {
        event.preventDefault()
        return
      }
      if (!await saveTitle()) {
        event.preventDefault()
        return
      }
      busy = true
      setEditable(handle, false)
      if (await flush()) return

      event.preventDefault()
      busy = false
      setEditable(handle, editorIsEditable())
    }).catch(() => {
      setFailure('保存失败')
    })
    return () => {
      window.removeEventListener('keydown', onKeydown)
      void listener.then((unlisten) => unlisten?.())
      void fileDrops?.then((unlisten) => unlisten?.())
    }
  })

  let previousEditor: Pick<DevelopmentSnapshot, 'path' | 'editorState' | 'scrollTop' | 'focused'> | undefined
  let disposeEditorMetrics: (() => void) | undefined
  const onEditorDispose = (editor: EditorHandle) => {
    if (!import.meta.env.DEV || handle !== editor) return
    disposeEditorMetrics?.()
    disposeEditorMetrics = undefined
    if (disposed) return
    const { view, state, isFocused } = editor.editor
    previousEditor = {
      path: loadBefore ? loadBefore.path : path(),
      editorState: loadBefore?.state ?? state,
      scrollTop: loadBefore?.scrollTop ?? view.dom.closest('.editor-scroll')?.scrollTop ?? 0,
      focused: isFocused,
    }
  }

  const onReady = (editor: EditorHandle) => {
    handle = editor
    if (import.meta.env.DEV) {
      const snapshot = previousEditor ?? developmentSession.snapshot
      previousEditor = undefined
      developmentSession.snapshot = undefined
      if (snapshot?.editorState && snapshot.path === path()) {
        const view = editor.editor.view
        const old = snapshot.editorState
        const plugins = view.state.plugins
        const clean = old.doc === savedDoc
        view.updateState(old.schema === view.state.schema
          ? old.reconfigure({ plugins })
          : EditorState.fromJSON({ schema: view.state.schema, plugins }, old.toJSON()))
        if (clean) savedDoc = view.state.doc
        else if (path() && !readonly()) onUpdate()
        const scroller = view.dom.closest('.editor-scroll')
        requestAnimationFrame(() => {
          if (editor.editor.isDestroyed) return
          if (scroller) scroller.scrollTop = snapshot.scrollTop
          if (snapshot.focused && editorIsEditable()) view.focus()
        })
      } else {
        // A freshly mounted editor contains a placeholder. Never save it over the open file.
        const target = path()
        if (target) {
          savedDoc = editor.editor.state.doc
          void runFileAction((handle) => readDocument(handle, target, false), '打开失败')
        }
      }
    }
    setEditable(editor, !busy && editorIsEditable())
    openPendingEntry()
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
    disposeEditorMetrics = () => {
      clearInterval(interval)
      delete dev.__oneboxLoad
      delete dev.__oneboxMetrics
    }
  }

  onCleanup(() => disposeEditorMetrics?.())
  onCleanup(clearSaveTimer)
  onCleanup(() => clearTimeout(autoSaveHintTimer))
  onCleanup(pauseTitle)
  onCleanup(() => { disposed = true; cancelLoad = true })

  const restoreDevelopmentPosition = (document: string) => {
    if (!import.meta.env.DEV) return
    try {
      const position = JSON.parse(localStorage.getItem('onebox:dev-position') ?? 'null')
      if (!position || position.path !== document || path() !== document || !handle) return
      const editor = handle.editor
      const end = editor.state.doc.content.size
      editor.commands.setTextSelection({
        from: Math.min(end, Math.max(0, position.from)),
        to: Math.min(end, Math.max(0, position.to)),
      })
      const scroller = editor.view.dom.closest('.editor-scroll')
      setSidebarVisible(position.sidebarVisible !== false)
      requestAnimationFrame(() => { if (scroller) scroller.scrollTop = position.scrollTop })
    } catch { /* An older or removed development session can start at the document's beginning. */ }
  }

  if (import.meta.hot) {
    const hot = import.meta.hot
    const capture = () => {
      const state = loadBefore?.state ?? handle?.editor.state
      developmentSession.snapshot = {
        path: loadBefore ? loadBefore.path : path(),
        readonly: loadBefore?.readonly ?? readonly(),
        workspace: workspace(), preview: preview(), sidebarVisible: sidebarVisible(),
        emptyAfterDeletion: loadBefore?.emptyAfterDeletion ?? emptyAfterDeletion(),
        savedDoc, writer, editorState: state, schemaSource: schema,
        scrollTop: loadBefore?.scrollTop ?? handle?.editor.view.dom.closest('.editor-scroll')?.scrollTop ?? 0,
        focused: handle?.editor.isFocused ?? false,
      } satisfies DevelopmentSnapshot
    }
    const prepare = async ({ id }: { id: string }) => {
      developmentPreparing = id
      if (handle) setEditable(handle, false)
      try {
        while (busy && !disposed && developmentPreparing === id) await new Promise((resolve) => setTimeout(resolve, 25))
        if (disposed) throw new Error('Wait for the current hot update to finish')
        if (developmentPreparing !== id) throw new Error('Restart cancelled')
        if (!await flush()) throw new Error('保存失败，已保留当前窗口')
        if (developmentPreparing !== id) throw new Error('Restart cancelled')
        await invoke('remember_document', { path: path() })
        if (developmentPreparing !== id) throw new Error('Restart cancelled')
        const selection = handle?.editor.state.selection
        localStorage.setItem('onebox:dev-position', JSON.stringify({
          path: path(), from: selection?.from ?? 0, to: selection?.to ?? 0,
          scrollTop: handle?.editor.view.dom.closest('.editor-scroll')?.scrollTop ?? 0,
          sidebarVisible: sidebarVisible(),
        }))
        hot.send('onebox:prepared', { id })
      } catch (error) {
        resume({ id })
        hot.send('onebox:prepared', { id, error: String(error) })
      }
    }
    const resume = ({ id }: { id?: string }) => {
      if (id && developmentPreparing !== id) return
      developmentPreparing = undefined
      if (handle && !disposed) {
        setEditable(handle, !busy && editorIsEditable())
        resumeFileActions()
      }
    }
    const focus = () => { if (desktop) void invoke('focus_window') }
    hot.on('vite:beforeUpdate', capture)
    hot.on('onebox:prepare', prepare)
    hot.on('onebox:resume', resume)
    hot.on('onebox:focus', focus)
    createEffect(restoringWorkspace, (restoring) => {
      if (!restoring) hot.send('onebox:ready', { native: desktop })
    })
    onCleanup(() => {
      hot.off('vite:beforeUpdate', capture)
      hot.off('onebox:prepare', prepare)
      hot.off('onebox:resume', resume)
      hot.off('onebox:focus', focus)
    })
  }

  const renderSidebar = (current?: WorkspaceRoot) => (
    <WorkspaceSidebar
      workspace={current} visible={sidebarVisible()} restoring={restoringWorkspace()}
      active={activeFile()} reveal={workspaceReveal()} revision={workspaceRevision()}
      pending={pendingOpen()?.entry.path} importTarget={importTarget()}
      displayName={displayedName} renamed={workspaceRename()}
      selectionReset={selectionReset()} onSelectionReady={setWorkspaceSelection}
      onOpen={openWorkspaceEntry} onOpenFile={openFile} onOpenWorkspace={() => void openWorkspace()}
      onRevealLocation={(target) => {
        const root = current?.root
        return desktopWorkspace.revealLocation(root && (root === target || inWorkspace(target, root)) ? root : undefined, target)
      }}
      onOpenDemo={import.meta.env.DEV ? () => void openDemoWorkspace() : undefined}
      onCreate={createWorkspaceEntry} onMove={moveWorkspaceEntry} onTrash={trashWorkspaceEntry} onRename={renameEntry}
      onCopy={mac ? copyWorkspaceEntriesToClipboard : undefined} onPaste={pasteWorkspaceEntry}
      onPasteSystem={mac ? pasteWorkspaceClipboard : undefined}
      onClose={() => void closeWorkspace()}
    />
  )

  return (
    <main class={['app', { 'workspace-open': desktop && sidebarVisible(), 'workspace-resizing': resizingSidebar() }]}
      style={{ '--workspace-preferred-width': `${sidebarWidth()}px`, '--traffic-light-center': titleBarButtonCenter() }}>
      <Show when={desktop}>
        <header class={['window-bar', { 'window-bar-mac': mac }]} inert={selectionFilePreviewOpen()}>
          <div class="window-drag-region" data-tauri-drag-region="" aria-hidden="true" />
          <button type="button" class="sidebar-toggle" ref={sidebarToggle} data-activate-on-release
            aria-label={sidebarLabel()} aria-expanded={sidebarVisible() ? 'true' : 'false'} aria-controls="workspace-sidebar"
            title={`${sidebarLabel()}（${mac ? '⌘' : 'Ctrl+'}\\）`} onClick={toggleSidebar}>
            <span class="sidebar-toggle-symbol" aria-hidden="true" />
          </button>
        </header>
      </Show>
      <div class="editor-layout">
        <Show when={desktop}>
          <div class="workspace-slot" ref={workspaceSlot} inert={selectionFilePreviewOpen()}>
            <Show when={workspace()} keyed fallback={renderSidebar()}>
              {(current) => renderSidebar(current)}
            </Show>
            <Show when={sidebarVisible() && !selectionFilePreviewOpen()}>
              <WorkspaceResizeHandle sidebar="workspace" width={sidebarWidth()} onWidth={setSidebarWidth} onResize={setResizingSidebar} />
            </Show>
          </div>
        </Show>
        <div class="editor-content">
          <div inert={!!selectionPreview()}
            class={['editor-current-content', { 'editor-current-content-covered': !!selectionPreview() }]}>
            <div class="editor-document" inert={!!preview() || !!openingEntry() || emptyAfterDeletion()}
              hidden={!!preview() || !!openingEntry() || emptyAfterDeletion()}>
              <div class="editor-document-main">
                <Show when={path()}>
                  <header class="file-preview-toolbar">
                    <FileName name={nameOf(path() ?? '')} edit={desktop && path() ? titleEdit(fileEntry(path()!)) : undefined} />
                    <div class="file-save-hint" role="status">{autoSaveMessage()}</div>
                    <Show when={desktop}>
                      <AiSidebarToggle open={aiOpen()} onOpen={() => openAi()} onClose={closeAi}
                        ref={(button) => { aiToggle = button }} />
                    </Show>
                  </header>
                </Show>
                <EditorShell
                  markdown=""
                  onReady={onReady}
                  onDispose={onEditorDispose}
                  onUpdate={onUpdate}
                  onQuoteSelection={desktop && path() && !loading() && !preview() && !openingEntry() ? openAi : undefined}
                  inlineAi={!!(desktop && path() && !loading() && !preview() && !openingEntry())}
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
              <Show when={desktop && path()} keyed>
                {(document) => <AiSidebar open={aiOpen()} loading={loading()} title={nameOf(document)} history={aiHistory(document)}
                  editor={() => loading() ? undefined : handle?.editor}
                  quote={aiQuote()?.path === document ? aiQuote()?.reference : undefined}
                  pickReference={pickAiReference} onQuoteConsumed={() => setAiQuote(undefined)} onClose={closeAi} />}
              </Show>
            </div>
            <Show when={!openingEntry() && preview()}>
              <FilePreview root={preview()?.workspaceRoot} entry={preview()}
                titleEdit={preview() && preview()?.accessible !== false ? titleEdit(preview()!) : undefined}
                onOpenExternal={(application) => {
                  const entry = preview()
                  if (entry) openWorkspaceAttachment(entry, application)
                }}
                onSaveHint={showAutoSaveHint} saveHint={autoSaveMessage()}
                onClose={() => setPreview(undefined)} />
            </Show>
            <Show when={openingEntry()}>{(entry) => (
              <section class="file-preview" aria-label="正在打开文件">
                <header class="file-preview-toolbar">
                  <FileName name={entry().name} />
                  <div class="file-save-hint" role="status">{autoSaveMessage()}</div>
                </header>
                <div class={['preview-surface', { 'preview-surface-text': entry().markdown || /\.txt$/iu.test(entry().name) }]}>
                  <PreviewLoading label="正在打开文件…" />
                </div>
              </section>
            )}</Show>
            <Show when={emptyAfterDeletion() && !preview() && !openingEntry()}>
              <div class="editor-empty" role="status">没有打开的文件</div>
            </Show>
          </div>
          <Show when={selectionPreview()} keyed>{(selection) => (
            <WorkspaceSelectionPreview selection={selection} root={workspace()?.root}
              onFilePreviewOpenChange={setSelectionFilePreviewOpen}
              onOpenExternal={(entry, application) => openWorkspaceAttachment({ ...entry, workspaceRoot: workspace()?.root }, application)}
              onSaveHint={showAutoSaveHint} saveHint={autoSaveMessage()} />
          )}</Show>
        </div>
      </div>
      <footer class="statusbar" role="status">
        <span title={openingEntry()?.path ?? activeFile() ?? undefined}>{openingEntry()?.name ?? (activeFile() ? nameOf(activeFile()!) : '')}</span>
        <span>{loadingStatus() && (openingEntry() || loading()) ? '正在载入' : saving() ? '正在保存' : workspaceMoving() ? '正在移动' : workspaceImporting() ? '正在导入' : activeFile() && (preview() || readonly()) ? '只读' : ''}</span>
        <span>{failure() ?? importMessage()}</span>
      </footer>
    </main>
  )
}
