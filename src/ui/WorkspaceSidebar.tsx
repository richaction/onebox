import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import { NameField } from './FileName'
import { createStore, reconcile } from 'solid-js/store'
import { desktopWorkspace, type WorkspaceEntry, type WorkspaceRoot } from '../io/tauri'

interface Directory {
  entries?: WorkspaceEntry[]
  loading: boolean
  error?: string
}

type DropLocation = { folder: string; anchor: string; edge: 'before' | 'after' | 'inside' }

function separator(path: string) {
  return path.startsWith('/') ? '/' : '\\'
}

function childOf(path: string, parent: string, includeSelf = false) {
  const sep = separator(parent)
  return (includeSelf && path === parent) || path.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

function ancestors(root: string, path: string) {
  if (!childOf(path, root) || path === root) return []
  const sep = separator(root)
  let folder = root.endsWith(sep) ? root.slice(0, -1) : root
  return path.slice(folder.length + 1).split(sep).slice(0, -1).map((part) => folder += sep + part)
}

const nameOf = (path: string) => path.split(/[/\\]/u).filter(Boolean).at(-1) ?? path

interface SidebarContext {
  x: number
  y: number
  trigger: HTMLElement
  entry?: WorkspaceEntry
}

interface SidebarAction {
  label: string
  run: () => void
  separator?: boolean
}

interface Creation {
  folder: string
  after?: string
  directory: boolean
  trigger: HTMLElement
}

function ContextMenu(props: { at: SidebarContext; actions: SidebarAction[]; close: (restoreFocus: boolean) => void }) {
  let menu!: HTMLDivElement
  const buttons = () => Array.from(menu.querySelectorAll('button'))
  onMount(() => {
    menu.showPopover?.()
    const bounds = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(props.at.x, window.innerWidth - bounds.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(props.at.y, window.innerHeight - bounds.height - 8))}px`
    buttons()[0]?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node)) props.close(false)
    }
    const away = () => props.close(false)
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', away)
    window.addEventListener('blur', away)
    onCleanup(() => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', away)
      window.removeEventListener('blur', away)
    })
  })
  return (
    <div class="workspace-context-menu" ref={menu} popover="manual" role="menu" aria-label="文件操作"
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault()
          props.close(true)
          return
        }
        const items = buttons()
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'ArrowDown' ? (current + 1) % items.length
          : event.key === 'ArrowUp' ? (current + items.length - 1) % items.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
        if (next < 0) return
        event.preventDefault()
        items[next]?.focus()
      }}>
      <For each={props.actions}>{(action) => (
        <>
          <Show when={action.separator}><div class="workspace-menu-separator" role="separator" /></Show>
          <button type="button" role="menuitem" tabIndex={-1}
            onClick={() => { props.close(true); action.run() }}>{action.label}</button>
        </>
      )}</For>
    </div>
  )
}

export default function WorkspaceSidebar(props: {
  workspace?: WorkspaceRoot
  visible: boolean
  restoring: boolean
  active: string | null
  pending?: string
  readonly: boolean
  reveal?: string
  revision: number
  importTarget?: string
  onOpen: (entry: WorkspaceEntry) => void
  onOpenFile: (folder?: string) => Promise<string | undefined>
  onOpenWorkspace: () => void
  onOpenDemo?: () => void
  onCreate: (folder: string, name: string, directory: boolean, onCreated: (entry: WorkspaceEntry) => void) => Promise<void>
  onTrash: (entry: WorkspaceEntry) => Promise<void>
  onRename: (entry: WorkspaceEntry, stem: string) => Promise<string>
  displayName?: (entry: WorkspaceEntry) => string
  renamed?: { source: string; destination: string; name: string }
  onMove: (entry: WorkspaceEntry, target: string) => Promise<void>
  onCopy: () => void
  onMoveDocument: () => void
  onClose: () => void
}) {
  const root = props.workspace?.root ?? ''
  const [directories, setDirectory] = createStore<Record<string, Directory>>(
    props.workspace ? { [root]: { entries: props.workspace.entries, loading: false } } : {},
  )
  const [expanded, setExpanded] = createSignal(new Set<string>())
  const [dragged, setDragged] = createSignal<WorkspaceEntry>()
  const [dropTarget, setDropTarget] = createSignal<DropLocation>()
  const orderKey = `onebox:workspace-order:${root}`
  const [orders, setOrders] = createSignal<Record<string, string[]>>((() => {
    try { return JSON.parse(localStorage.getItem(orderKey) ?? '{}') ?? {} }
    catch { return {} }
  })())
  const [moving, setMoving] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [moveEntry, setMoveEntry] = createSignal<WorkspaceEntry>()
  const [context, setContext] = createSignal<SidebarContext>()
  const [creation, setCreation] = createSignal<Creation>()
  const [renaming, setRenaming] = createSignal<string>()
  const [trashEntry, setTrashEntry] = createSignal<WorkspaceEntry>()
  const [targetFolder, setTargetFolder] = createSignal(root)
  let tree!: HTMLElement
  let disposed = false
  onCleanup(() => { disposed = true })

  const requests = new Map<string, number>()
  const load = async (path: string, refresh = false) => {
    const state = directories[path]
    if (!refresh && (state?.loading || state?.entries)) return
    const generation = (requests.get(path) ?? 0) + 1
    requests.set(path, generation)
    setDirectory(path, { entries: state?.entries, loading: true, error: undefined })
    try {
      const entries = await desktopWorkspace.entries(root, path)
      if (disposed || requests.get(path) !== generation) return
      setDirectory(path, 'entries', reconcile(entries, { key: 'path' }))
      setDirectory(path, 'loading', false)
    } catch {
      if (disposed || requests.get(path) !== generation) return
      setDirectory(path, 'loading', false)
      setDirectory(path, 'error', '目录读取失败')
    }
  }

  createEffect(on(() => [props.active, props.reveal], (paths) => {
    if (!root) return
    const folders = new Set(paths.flatMap((path) => path ? ancestors(root, path) : []))
    if (!folders.size) return
    setExpanded((open) => new Set([...open, ...folders]))
    for (const folder of folders) void load(folder)
  }))

  createEffect(on(() => props.renamed, (rename) => {
    if (!rename) return
    const parent = ancestors(root, rename.source).at(-1) ?? root
    const entries = directories[parent]?.entries
    if (!entries?.some((entry) => entry.path === rename.source)) return
    setDirectory(parent, 'entries', reconcile(entries.map((entry) => entry.path === rename.source
      ? { ...entry, path: rename.destination, name: rename.name } : entry), { key: 'path' }))
    const order = orders()[parent]
    if (order?.includes(rename.source)) {
      saveOrders({ ...orders(), [parent]: order.map((path) => path === rename.source ? rename.destination : path) })
    }
  }, { defer: true }))

  const refresh = () => {
    if (!root) return
    void load(root, true)
    for (const path of expanded()) {
      if (ancestors(root, path).every((parent) => expanded().has(parent))) void load(path, true)
    }
  }
  createEffect(on(() => props.revision, refresh, { defer: true }))

  createEffect(() => {
    const file = props.reveal
    if (!props.visible || !root || !file || !childOf(file, root)) return
    const folder = ancestors(root, file).at(-1) ?? root
    if (!directories[folder]?.entries?.some((entry) => entry.path === file)) return
    const frame = requestAnimationFrame(() => {
      const row = tree.querySelector(`[data-workspace-entry="${CSS.escape(file)}"]`)
      row?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })

  const expand = (path: string) => {
    setExpanded((open) => new Set([...open, path]))
    void load(path)
  }

  const toggle = (path: string) => {
    if (!expanded().has(path)) return expand(path)
    const open = new Set(expanded())
    open.delete(path)
    setExpanded(open)
  }

  const canMoveTo = (entry: WorkspaceEntry, target: string) => {
    const sep = separator(entry.path)
    const parent = entry.path.slice(0, entry.path.lastIndexOf(sep))
    const destination = target.endsWith(sep) ? target.slice(0, -1) : target
    return destination !== parent && (!entry.directory || !childOf(target, entry.path, true))
  }

  const orderedEntries = (folder: string) => {
    const entries = (directories[folder]?.entries ?? []).filter((entry) => entry.name !== '.DS_Store')
    const order = orders()[folder]
    if (!Array.isArray(order)) return entries
    const ranks = new Map(order.map((path, index) => [path, index]))
    return entries.sort((first, second) =>
      (ranks.get(first.path) ?? order.length) - (ranks.get(second.path) ?? order.length))
  }

  const saveOrders = (updated: Record<string, string[]>) => {
    setOrders(updated)
    try { localStorage.setItem(orderKey, JSON.stringify(updated)) } catch { /* Keep session order. */ }
  }

  const placeFile = (folder: string, path: string, after?: string) => {
    if (disposed || path === after || !childOf(path, root) || (ancestors(root, path).at(-1) ?? root) !== folder) return
    const saved = orders()[folder]
    const siblings = orderedEntries(folder).map((entry) => entry.path)
    const paths = [...new Set([...(Array.isArray(saved) ? saved : []), ...siblings])].filter((item) => item !== path)
    const index = after ? paths.indexOf(after) : -1
    paths.splice(index + 1, 0, path)
    saveOrders({ ...orders(), [folder]: paths })
  }

  const beginCreation = (folder: string, directory: boolean, trigger: HTMLElement, after?: string) => {
    if (folder !== root) expand(folder)
    setCreation({ folder, directory, trigger, after })
  }

  const beginMove = (entry: WorkspaceEntry) => {
    if (moving()) return
    setError(undefined)
    setTargetFolder(root)
    setMoveEntry(entry)
  }

  const closeContext = (restoreFocus: boolean) => {
    const trigger = context()?.trigger
    setContext(undefined)
    if (restoreFocus) trigger?.focus({ preventScroll: true })
  }
  createEffect(on(() => props.visible, (visible) => { if (!visible) closeContext(false) }))

  const showContext = (event: MouseEvent | KeyboardEvent, entry?: WorkspaceEntry) => {
    event.preventDefault()
    event.stopPropagation()
    if (moving() || props.restoring) return
    const target = event.target as HTMLElement
    const trigger = target.closest('button') ?? (event.currentTarget as HTMLElement)
    const bounds = trigger.getBoundingClientRect()
    const pointer = 'clientX' in event && event.type === 'contextmenu' && (event.clientX || event.clientY) ? event : undefined
    setContext({
      x: pointer?.clientX ?? bounds.left,
      y: pointer?.clientY ?? bounds.bottom + 4,
      trigger,
      entry,
    })
  }

  const contextShortcut = (event: KeyboardEvent, entry?: WorkspaceEntry) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) showContext(event, entry)
    if (event.key === 'F2' && entry && entry.accessible !== false) {
      event.preventDefault()
      setRenaming(entry.path)
    }
  }

  const actionsFor = ({ entry, trigger }: SidebarContext) => {
    const actions: SidebarAction[] = []
    const after = entry && !entry.directory ? entry.path : undefined
    const folder = entry?.directory ? entry.path : after ? ancestors(root, after).at(-1) ?? root : root
    if (entry && !entry.directory && entry.accessible !== false) {
      const label = entry.markdown ? '打开此文档' : '预览'
      actions.push({ label, run: () => props.onOpen(entry) })
    }
    if (folder) {
      actions.push(
        { label: '新建文件…', run: () => beginCreation(folder, false, trigger, after) },
        { label: '新建文件夹…', run: () => beginCreation(folder, true, trigger) },
      )
    }
    if (entry && entry.accessible !== false) {
      actions.push(
        { label: '重命名…', run: () => setRenaming(entry.path) },
        { label: '移动到…', run: () => beginMove(entry) },
      )
    }
    const activeFileActions = props.active && !props.readonly
    if (activeFileActions && ((!entry && (!root || !childOf(props.active!, root))) || entry?.path === props.active)) {
      if (!entry) actions.push({ label: '移动当前文档…', run: props.onMoveDocument })
      actions.push({ label: entry ? '复制到…' : '复制当前文档…', run: props.onCopy })
    }
    if (entry && entry.accessible !== false) {
      actions.push({ label: '删除…', run: () => setTrashEntry(entry) })
    }
    const copyPath = entry?.path ?? (root || props.active)
    if (copyPath) actions.push({ label: '复制路径', run: async () => {
      try {
        await navigator.clipboard.writeText(copyPath)
        setError(undefined)
      } catch {
        setError('复制路径失败')
      }
    } })
    actions.push(
      { label: '打开文件夹…', run: props.onOpenWorkspace, separator: actions.length > 0 },
      { label: '打开文件…', run: async () => {
        const path = await props.onOpenFile(folder || undefined)
        if (path && folder) placeFile(folder, path, after)
      } },
    )
    if (root && !entry) actions.push({ label: '刷新文件夹', run: refresh }, { label: '关闭文件夹', run: props.onClose })
    if (!entry && props.onOpenDemo) actions.push({ label: '打开调试样例', run: props.onOpenDemo })
    return actions
  }

  const forgetFolder = (entry: WorkspaceEntry) => {
    if (!entry.directory) return
    setExpanded((open) => new Set([...open].filter((path) => !childOf(path, entry.path, true))))
    for (const path of Object.keys(directories)) {
      if (!childOf(path, entry.path, true)) continue
      // Invalidate pending loads even if another folder is later created at the same path.
      requests.set(path, (requests.get(path) ?? 0) + 1)
      setDirectory(path, undefined!)
    }
  }

  const rename = async (entry: WorkspaceEntry, stem: string) => {
    const destination = await props.onRename(entry, stem)
    if (destination === entry.path) return
    const folders = [...expanded()].filter((path) => childOf(path, entry.path, true))
    forgetFolder(entry)
    for (const path of folders) expand(destination + path.slice(entry.path.length))
  }

  const move = async (entry: WorkspaceEntry, target: string) => {
    if (moving() || !canMoveTo(entry, target)) return false
    setMoving(true)
    setError(undefined)
    try {
      await props.onMove(entry, target)
      forgetFolder(entry)
      setMoveEntry(undefined)
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      return false
    } finally {
      setMoving(false)
    }
  }

  const drop = async (entry: WorkspaceEntry, target: DropLocation) => {
    if (target.edge === 'inside') {
      await move(entry, target.folder)
      return
    }
    const paths = orderedEntries(target.folder).map((item) => item.path).filter((path) => path !== entry.path)
    const index = paths.indexOf(target.anchor)
    if (index < 0) return
    let destination = entry.path
    if (canMoveTo(entry, target.folder)) {
      if (!await move(entry, target.folder)) return
      const sep = separator(target.folder)
      destination = `${target.folder}${target.folder.endsWith(sep) ? '' : sep}${entry.name}`
    }
    paths.splice(index + (target.edge === 'after' ? 1 : 0), 0, destination)
    const updated = { ...orders(), [target.folder]: paths }
    saveOrders(updated)
  }

  let press: { pointer: number; x: number; y: number; row: HTMLElement; entry: WorkspaceEntry } | undefined
  let openTimer: ReturnType<typeof setTimeout> | undefined
  let clickTimer: ReturnType<typeof setTimeout> | undefined
  let suppressClick = false

  const clearDrag = () => {
    press = undefined
    clearTimeout(openTimer)
    setDragged(undefined)
    setDropTarget(undefined)
  }

  const pressRow = (event: PointerEvent, entry: WorkspaceEntry) => {
    if (event.button === 2 || (event.button === 0 && event.ctrlKey)) {
      event.preventDefault()
      return
    }
    if (moving() || event.button !== 0 || event.pointerType === 'touch') return
    if (entry.accessible === false) return
    if (renaming() === entry.path || (event.target as Element).closest('.workspace-row-action')) return
    press = { pointer: event.pointerId, x: event.clientX, y: event.clientY, row: event.currentTarget as HTMLElement, entry }
  }

  const locationAt = (event: PointerEvent, entry: WorkspaceEntry): DropLocation | undefined => {
    const hovered = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-workspace-entry], [data-workspace-folder]')
    if (!hovered || !tree.contains(hovered)) return
    const { workspaceEntry: anchor, workspaceFolder: folder, workspaceParent: parent } = hovered.dataset
    if (anchor === entry.path) return
    const row = hovered.getBoundingClientRect()
    const ratio = (event.clientY - row.top) / Math.max(row.height, 1)
    if (folder && (!anchor || (ratio >= 0.25 && ratio <= 0.75))) {
      if (canMoveTo(entry, folder)) return { folder, anchor: folder, edge: 'inside' }
      return
    }
    if (!anchor || !parent || (entry.directory && childOf(parent, entry.path, true))) return
    return { folder: parent, anchor, edge: ratio < 0.5 ? 'before' : 'after' }
  }

  const movePointer = (event: PointerEvent) => {
    if (!press || press.pointer !== event.pointerId) return
    if (!(event.buttons & 1)) {
      clearDrag()
      return
    }
    if (!dragged()) {
      const row = press.row.getBoundingClientRect()
      const stillOnRow = event.clientY >= row.top && event.clientY < row.bottom
        && event.clientX >= row.left && event.clientX < row.right
      if (stillOnRow || Math.hypot(event.clientX - press.x, event.clientY - press.y) < 10) return
      setDragged(press.entry)
      setError(undefined)
    }
    const target = locationAt(event, press.entry)
    const previous = dropTarget()
    if (target?.anchor === previous?.anchor && target?.edge === previous?.edge) return
    setDropTarget(target)
    clearTimeout(openTimer)
    if (target?.edge === 'inside' && target.folder !== root && !expanded().has(target.folder)) {
      openTimer = setTimeout(() => { if (!expanded().has(target.folder)) toggle(target.folder) }, 550)
    }
  }

  const releasePointer = (event: PointerEvent) => {
    if (!press || press.pointer !== event.pointerId) return
    const source = dragged()
    const target = source && locationAt(event, source)
    clearDrag()
    if (!source) return
    suppressClick = true
    clickTimer = setTimeout(() => { suppressClick = false }, 0)
    if (target) void drop(source, target)
  }

  onMount(() => {
    const preventDropClick = (event: MouseEvent) => {
      if (suppressClick && event.detail > 0) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    const cancelDrag = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && press) clearDrag()
    }
    window.addEventListener('pointermove', movePointer)
    window.addEventListener('pointerup', releasePointer)
    window.addEventListener('pointercancel', clearDrag)
    window.addEventListener('blur', clearDrag)
    window.addEventListener('click', preventDropClick, true)
    window.addEventListener('keydown', cancelDrag)
    onCleanup(() => {
      clearTimeout(openTimer)
      clearTimeout(clickTimer)
      window.removeEventListener('pointermove', movePointer)
      window.removeEventListener('pointerup', releasePointer)
      window.removeEventListener('pointercancel', clearDrag)
      window.removeEventListener('blur', clearDrag)
      window.removeEventListener('click', preventDropClick, true)
      window.removeEventListener('keydown', cancelDrag)
    })
  })

  const DirectoryStatus = (state: { path: string; empty: string }) => (
    <Show when={directories[state.path]?.error} fallback={
      <span class="workspace-empty">{directories[state.path]?.loading ? '读取中…' : state.empty}</span>
    }>
      <button type="button" class="workspace-empty" onClick={() => void load(state.path, true)}>读取失败，重试</button>
    </Show>
  )

  const FolderBranch = (folder: { path: string }) => {
    const opened = () => expanded().has(folder.path)
    const [mounted, setMounted] = createSignal(opened())
    createEffect(() => {
      if (opened()) {
        setMounted(true)
        return
      }
      const timer = setTimeout(() => setMounted(false), 180)
      onCleanup(() => clearTimeout(timer))
    })
    return (
      <div class="workspace-branch" classList={{ 'is-expanded': opened() }} inert={!opened()}>
        <div class="workspace-branch-content">
          <Show when={opened() || mounted()}><Rows path={folder.path} /></Show>
        </div>
      </div>
    )
  }

  const EntryIcons = ({ entry }: { entry: WorkspaceEntry }) => (
    <>
      <span classList={{ 'workspace-chevron': true, 'has-folder': entry.directory, 'is-open': entry.directory && expanded().has(entry.path) }} aria-hidden="true" />
      <span classList={{
        'workspace-entry-icon': true,
        'is-folder': entry.directory,
        'is-folder-open': entry.directory && expanded().has(entry.path),
        'is-document': entry.markdown,
      }} aria-hidden="true" />
    </>
  )

  const Rows = (rows: { path: string }) => {
    const entries = createMemo(() => orderedEntries(rows.path))
    const draft = () => creation()?.folder === rows.path ? creation() : undefined
    return <ul class="workspace-rows" data-workspace-folder={rows.path}>
      <Show when={!draft()?.after || !entries().some((entry) => entry.path === draft()?.after) ? draft() : undefined} keyed>
        {(draft) => <CreateRow draft={draft} />}
      </Show>
      <For each={entries()} fallback={
        <Show when={creation()?.folder !== rows.path}><li><DirectoryStatus path={rows.path} empty="空文件夹" /></li></Show>
      }>
        {(entry) => (<>
          <li classList={{
            'workspace-drop-before': dropTarget()?.anchor === entry.path && dropTarget()?.edge === 'before',
            'workspace-drop-after': dropTarget()?.anchor === entry.path && dropTarget()?.edge === 'after',
          }}>
            <div
              class="workspace-row"
              classList={{
                'workspace-drop-target': props.importTarget === entry.path || (dropTarget()?.anchor === entry.path && dropTarget()?.edge === 'inside'),
                'workspace-dragged': dragged()?.path === entry.path,
                'workspace-row-menu-open': context()?.entry?.path === entry.path,
              }}
              data-workspace-folder={entry.directory ? entry.path : undefined}
              data-workspace-entry={entry.path} data-workspace-parent={rows.path}
              onPointerDown={(event) => pressRow(event, entry)}
              onContextMenu={(event) => showContext(event, entry)}
              onKeyDown={(event) => contextShortcut(event, entry)}
            >
              <Show when={renaming() !== entry.path} fallback={
                <div class="workspace-row-rename">
                  <EntryIcons entry={entry} />
                  <NameField name={entry.name} directory={entry.directory} onRename={(stem) => rename(entry, stem)}
                    onClose={() => setRenaming((current) => current === entry.path ? undefined : current)} />
                </div>
              }>
                <button
                  type="button"
                  class="workspace-row-button"
                  title={props.displayName?.(entry) ?? entry.name}
                  disabled={entry.accessible === false}
                  aria-expanded={entry.directory ? expanded().has(entry.path) : undefined}
                  aria-current={!entry.directory && props.active === entry.path ? 'page' : undefined}
                  aria-busy={props.pending === entry.path || undefined}
                  onClick={(event) => {
                    if (event.detail > 1) return
                    if (entry.directory) toggle(entry.path)
                    else props.onOpen(entry)
                  }}
                  onDblClick={() => setRenaming(entry.path)}
                >
                  <EntryIcons entry={entry} />
                  <span class="workspace-entry-name">{props.displayName?.(entry) ?? entry.name}</span>
                </button>
              </Show>
              <Show when={entry.accessible !== false}>
                <button
                  type="button" class="workspace-row-action" title="更多操作" aria-haspopup="menu"
                  aria-label={`${entry.name} 的操作`} onClick={(event) => showContext(event, entry)}
                />
              </Show>
            </div>
            <Show when={entry.directory}>
              <FolderBranch path={entry.path} />
            </Show>
          </li>
          <Show when={draft()?.after === entry.path ? draft() : undefined} keyed>
            {(draft) => <CreateRow draft={draft} />}
          </Show>
        </>)}
      </For>
    </ul>
  }

  const MoveDialog = (dialogProps: { entry: WorkspaceEntry }) => {
    let dialog!: HTMLDialogElement
    onMount(() => dialog.showModal())
    const navigate = (path: string) => {
      setTargetFolder(path)
      void load(path)
    }
    const breadcrumbs = () => {
      const target = targetFolder()
      return target === root ? [root] : [root, ...ancestors(root, target), target]
    }
    return (
      <dialog
        class="workspace-move-dialog" ref={dialog} aria-label="移动到文件夹"
        onCancel={(event) => { event.preventDefault(); if (!moving()) setMoveEntry(undefined) }}
      >
        <header>
          <strong>移动到</strong>
          <span title={dialogProps.entry.name}>{dialogProps.entry.name}</span>
        </header>
        <nav class="workspace-breadcrumbs" aria-label="目标路径">
          <For each={breadcrumbs()}>{(folder) => (
            <button type="button" disabled={moving()} aria-current={folder === targetFolder() ? 'location' : undefined}
              onClick={() => navigate(folder)}>{nameOf(folder)}</button>
          )}</For>
        </nav>
        <div class="workspace-destinations">
          <For each={directories[targetFolder()]?.entries?.filter((entry) =>
            entry.directory && (!dialogProps.entry.directory || !childOf(entry.path, dialogProps.entry.path, true)))}
            fallback={<DirectoryStatus path={targetFolder()} empty="没有子文件夹" />}>
            {(folder) => (
              <button type="button" disabled={moving()} onClick={() => navigate(folder.path)}>
                <span class="workspace-entry-icon is-folder" aria-hidden="true" />
                {folder.name}
                <span aria-hidden="true">›</span>
              </button>
            )}
          </For>
        </div>
        <Show when={error()}><p class="workspace-move-error" role="alert">{error()}</p></Show>
        <footer>
          <button type="button" disabled={moving()} onClick={() => setMoveEntry(undefined)}>取消</button>
          <button type="button" class="workspace-confirm"
            disabled={moving() || !directories[targetFolder()]?.entries || !canMoveTo(dialogProps.entry, targetFolder())}
            onClick={() => void move(dialogProps.entry, targetFolder())}>{moving() ? '正在移动…' : '移到此处'}</button>
        </footer>
      </dialog>
    )
  }

  const CreateRow = ({ draft }: { draft: Creation }) => {
    let field!: HTMLInputElement
    const [pending, setPending] = createSignal(false)
    const [issue, setIssue] = createSignal<string>()
    const label = draft.directory ? '文件夹名称' : '文件名称'
    const submit = async () => {
      const name = field.value.trim()
      if (!name || pending()) return
      setPending(true)
      setIssue(undefined)
      try {
        await props.onCreate(draft.folder, name, draft.directory, (entry) => {
          placeFile(draft.folder, entry.path, draft.after)
        })
        if (disposed) return
        setCreation((current) => current === draft ? undefined : current)
        if (draft.directory) draft.trigger.focus({ preventScroll: true })
      } catch (err) {
        setIssue(err instanceof Error ? err.message : String(err))
      } finally {
        setPending(false)
      }
    }
    onMount(() => {
      field.focus({ preventScroll: true })
      field.scrollIntoView({ block: 'nearest' })
    })
    return (
      <li>
        <div class="workspace-create-row" aria-busy={pending() || undefined}>
          <span class="workspace-entry-icon" classList={{ 'is-folder': draft.directory, 'is-document': !draft.directory }} aria-hidden="true" />
          <input ref={field} aria-label={label} placeholder={draft.directory ? label : '文件名.md'}
            aria-invalid={!!issue()} readOnly={pending()} onInput={() => setIssue(undefined)}
            onBlur={() => {
              if (!draft.directory && !pending() && !field.value.trim()) {
                setCreation((current) => current === draft ? undefined : current)
              }
            }}
            onContextMenu={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return
              event.preventDefault()
              event.stopPropagation()
              if (event.key === 'Enter') void submit()
              else if (!pending()) {
                setCreation(undefined)
                draft.trigger.focus({ preventScroll: true })
              }
            }} />
        </div>
        <Show when={issue()}><p class="workspace-move-error" role="alert">{issue()}</p></Show>
      </li>
    )
  }

  const TrashDialog = ({ entry }: { entry: WorkspaceEntry }) => {
    let dialog!: HTMLDialogElement
    const [pending, setPending] = createSignal(false)
    const [issue, setIssue] = createSignal<string>()
    onMount(() => dialog.showModal())
    const confirm = async () => {
      if (pending()) return
      setPending(true)
      setIssue(undefined)
      try {
        await props.onTrash(entry)
        forgetFolder(entry)
        const draft = creation()
        if (draft && childOf(draft.folder, entry.path, true)) setCreation(undefined)
        setTrashEntry(undefined)
      } catch (err) {
        setIssue(err instanceof Error ? err.message : String(err))
      } finally {
        setPending(false)
      }
    }
    return (
      <dialog class="workspace-move-dialog" ref={dialog} aria-label="确认删除"
        onCancel={(event) => { event.preventDefault(); if (!pending()) setTrashEntry(undefined) }}>
        <header><strong>移到废纸篓？</strong></header>
        <p class="workspace-trash-description">「{entry.name}」{entry.directory ? '及其内容将移到废纸篓。' : '将移到废纸篓。'}</p>
        <Show when={issue()}><p class="workspace-move-error" role="alert">{issue()}</p></Show>
        <footer>
          <button type="button" autofocus disabled={pending()} onClick={() => setTrashEntry(undefined)}>取消</button>
          <button type="button" class="workspace-confirm workspace-trash-confirm" disabled={pending()}
            onClick={() => void confirm()}>{pending() ? '正在删除…' : '移到废纸篓'}</button>
        </footer>
      </dialog>
    )
  }

  return (
    <aside class="workspace" id="workspace-sidebar" aria-label="工作区文件" ref={tree}
      inert={!props.visible} onContextMenu={(event) => showContext(event)}
      onKeyDown={(event) => contextShortcut(event)}>
      <div
        class="workspace-title" classList={{ 'workspace-drop-target': props.importTarget === root || dropTarget()?.anchor === root }}
        data-workspace-folder={root || undefined}
      >
        <Show when={root}><span class="workspace-entry-icon is-folder is-folder-open" aria-hidden="true" /></Show>
        <strong title={root || undefined}>{root ? nameOf(root) : '工作区'}</strong>
        <button type="button" class="workspace-more" aria-label="工作区操作" aria-haspopup="menu"
          disabled={moving() || props.restoring} onClick={(event) => showContext(event)}>⋯</button>
      </div>
      <Show when={root} fallback={
        <div class="workspace-start">
          <span>{props.restoring ? '正在恢复工作区…' : '没有打开的文件夹'}</span>
          <button type="button" class="workspace-open-folder" disabled={props.restoring} onClick={props.onOpenWorkspace}>
            打开文件夹…
          </button>
          <button type="button" disabled={props.restoring} onClick={() => props.onOpenFile()}>打开文件…</button>
          <Show when={props.onOpenDemo}>
            <button type="button" disabled={props.restoring} onClick={props.onOpenDemo}>打开调试样例</button>
          </Show>
        </div>
      }>
        <nav class="workspace-tree" aria-label="文件目录"><Rows path={root} /></nav>
      </Show>
      <Show when={error() && !moveEntry()}><p class="workspace-move-error" role="alert">{error()}</p></Show>
      <Show when={context()} keyed>
        {(current) => <ContextMenu at={current} actions={actionsFor(current)} close={closeContext} />}
      </Show>
      <Show when={moveEntry()} keyed>{(entry) => <MoveDialog entry={entry} />}</Show>
      <Show when={trashEntry()} keyed>{(entry) => <TrashDialog entry={entry} />}</Show>
    </aside>
  )
}
