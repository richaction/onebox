/** @jsxImportSource react */
'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PlateEditor, type EditorDocument } from '../editor/PlateEditor'
import { documentEntry, type WorkspaceEntry, type WorkspacePlatform, type WorkspaceRoot } from './platform'
import { SaveSession } from './saveSession'

const saveDelay = 800

type EditorState = { entry: WorkspaceEntry; markdown: string; session: SaveSession; generation: number }

type WorkspaceProps = {
  platform: WorkspacePlatform
  initialEntry?: WorkspaceEntry
  titleBar?: { mac: boolean; buttonCenter?: number }
  onSwitchToLegacy?: (path?: string) => void
  registerClose?: (flush: () => Promise<boolean>) => () => void
}

function Entries({ rows, expanded, active, onOpen }: {
  rows: readonly WorkspaceEntry[]
  expanded: ReadonlyMap<string, readonly WorkspaceEntry[]>
  active?: string
  onOpen: (entry: WorkspaceEntry) => void
}) {
  return <ul>
    {rows.map((entry) => {
      const children = expanded.get(entry.path)
      return <li key={entry.path}>
        <button type="button" disabled={entry.accessible === false || !entry.directory && !entry.markdown}
          aria-current={active === entry.path ? 'page' : undefined}
          aria-expanded={entry.directory ? !!children : undefined} onClick={() => onOpen(entry)}>
          <span aria-hidden="true">{entry.directory ? children ? '▾' : '▸' : '▤'}</span>{entry.name}
        </button>
        {children && <Entries rows={children} expanded={expanded} active={active} onOpen={onOpen} />}
      </li>
    })}
  </ul>
}

export function Workspace({ platform, initialEntry, titleBar, onSwitchToLegacy, registerClose }: WorkspaceProps) {
  const [workspace, setWorkspace] = useState<WorkspaceRoot>()
  const [expanded, setExpanded] = useState<ReadonlyMap<string, readonly WorkspaceEntry[]>>(new Map())
  const [editor, setEditor] = useState<EditorState>()
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sidebar, setSidebar] = useState(true)
  const [error, setError] = useState<string>()
  const current = useRef<EditorState>(undefined)
  const operation = useRef(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const loadingFolders = useRef(new Set<string>())

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    const document = current.current?.session
    if (!document?.dirty) return true
    setSaving(true)
    try {
      const finished = await document.flush()
      if (finished) setError(undefined)
      return finished
    } catch (failure) {
      setError(failure instanceof Error ? `保存失败 · ${failure.message}` : `保存失败 · ${String(failure)}`)
      return false
    } finally {
      setSaving(false)
    }
  }, [])

  const switchDocument = useCallback(async (entry: WorkspaceEntry) => {
    if (operation.current || !entry.markdown || entry.directory || current.current?.entry.path === entry.path) return
    operation.current = true
    setBusy(true)
    try {
      if (!await flush()) return
      const markdown = await platform.read(entry.path)
      if (!mounted.current) return
      const next = { entry, markdown, session: new SaveSession(entry.path, markdown, platform), generation: ++generation.current }
      current.current = next
      setEditor(next)
      setError(undefined)
    } catch (failure) {
      if (mounted.current) setError(`打开失败 · ${String(failure)}`)
    } finally {
      operation.current = false
      if (mounted.current) setBusy(false)
    }
  }, [platform, flush])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimeout(timer.current)
    }
  }, [])
  useEffect(() => {
    let active = true
    void platform.restoreWorkspace?.().then((root) => { if (active) setWorkspace((value) => value ?? root) })
      .catch((failure) => { if (active) setError(`读取工作区失败 · ${String(failure)}`) })
    return () => { active = false }
  }, [platform])
  const initialPath = initialEntry?.path
  useEffect(() => {
    if (initialPath) void switchDocument(documentEntry(initialPath))
  }, [initialPath, switchDocument])
  useEffect(() => registerClose?.(async () => !operation.current && await flush()), [flush, registerClose])

  const activeSession = editor?.session
  const onReady = useCallback((document: EditorDocument | null) => {
    if (activeSession) activeSession.document = document
  }, [activeSession])
  const scheduleSave = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { void flush() }, saveDelay)
  }, [flush])
  const onChange = useCallback(() => {
    activeSession?.markEdited()
    scheduleSave()
  }, [activeSession, scheduleSave])
  const activePath = editor?.entry.path
  const resources = useMemo(() => activePath ? platform.resources?.(activePath) : undefined, [activePath, platform])

  const onOpen = async (entry: WorkspaceEntry) => {
    if (!entry.directory) { await switchDocument(entry); return }
    const root = workspace?.root
    if (!root || !platform.list || loadingFolders.current.has(entry.path)) return
    if (expanded.has(entry.path)) {
      setExpanded((previous) => { const next = new Map(previous); next.delete(entry.path); return next })
      return
    }
    loadingFolders.current.add(entry.path)
    try {
      const children = await platform.list(root, entry.path)
      if (mounted.current) setExpanded((previous) => new Map(previous).set(entry.path, children))
    } catch (failure) {
      if (mounted.current) setError(`读取文件夹失败 · ${String(failure)}`)
    } finally {
      loadingFolders.current.delete(entry.path)
    }
  }
  const chooseFolder = async () => {
    const next = await platform.chooseFolder?.()
    if (next && mounted.current) { setWorkspace(next); setExpanded(new Map()) }
  }
  const chooseDocument = async () => {
    const entry = await platform.chooseDocument?.()
    if (entry) await switchDocument(entry)
  }
  const report = (run: () => Promise<void>) => { void run().catch((failure) => setError(String(failure))) }
  const returnToLegacy = async () => {
    if (operation.current) return
    operation.current = true
    setBusy(true)
    if (await flush()) onSwitchToLegacy?.(activePath)
    operation.current = false
    if (mounted.current) setBusy(false)
  }

  return <main className="plate-workspace" data-activate-on-release>
    {titleBar && <div className={titleBar.mac ? 'window-bar window-bar-mac' : 'window-bar'}
      style={{ '--traffic-light-center': titleBar.buttonCenter ? `${titleBar.buttonCenter}px` : undefined } as React.CSSProperties}>
      <div className="window-drag-region" data-tauri-drag-region="" aria-hidden="true" />
      <button type="button" className="sidebar-toggle" aria-label="侧栏" aria-expanded={sidebar} onClick={() => setSidebar((value) => !value)}>
        <span className="sidebar-toggle-symbol" aria-hidden="true" />
      </button>
    </div>}
    <div className="plate-workspace-body">
      {(sidebar && (workspace || platform.chooseFolder || platform.chooseDocument)) && <aside className="plate-workspace-tree" aria-label="工作区文件">
        <header>{workspace ? documentEntry(workspace.root).name : '工作区'}</header>
        {platform.chooseFolder && <button type="button" onClick={() => report(chooseFolder)} disabled={busy}>打开文件夹</button>}
        {platform.chooseDocument && <button type="button" onClick={() => report(chooseDocument)} disabled={busy}>打开 Markdown</button>}
        {workspace && <Entries rows={workspace.entries} expanded={expanded} active={activePath} onOpen={(entry) => report(() => onOpen(entry))} />}
      </aside>}
      <section className="plate-document" aria-label="文档">
        <header className="plate-document-header">
          <strong>{editor?.entry.name ?? 'Onebox'}</strong>
          {onSwitchToLegacy && <button type="button" disabled={busy} onClick={() => report(returnToLegacy)}>返回现用编辑器</button>}
        </header>
        <div className="plate-document-scroll" aria-busy={busy}>
          {editor && <PlateEditor key={editor.generation} markdown={editor.markdown} resources={resources} readOnly={busy}
            onReady={onReady} onChange={onChange} onCompositionEnd={scheduleSave} />}
          {!editor && !busy && <p className="plate-empty">打开一个 Markdown 文件开始编辑。</p>}
        </div>
      </section>
    </div>
    <footer className="plate-workspace-status" role="status">
      <span>{busy ? '正在打开…' : saving ? '正在保存…' : error ?? ''}</span>
      {error && activeSession?.dirty && <button type="button" onClick={() => { void flush() }}>重试保存</button>}
      <span>Plate</span>
    </footer>
  </main>
}
