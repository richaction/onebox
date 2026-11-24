import { createComponent, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { expect, it, vi } from 'vitest'
import WorkspaceSidebar, { type WorkspaceSelection } from '../src/ui/WorkspaceSidebar'
import FileName from '../src/ui/FileName'
import { desktopWorkspace } from '../src/io/tauri'

it('saves the document title after a click moves focus to another control', async () => {
  const host = document.createElement('div')
  const target = document.createElement('button')
  document.body.append(host, target)
  const save = vi.fn()
  const addListener = window.addEventListener.bind(window)
  let attachedAfterMount = false
  const listeners = vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'blur') attachedAfterMount = host.querySelector('input')?.isConnected === true
    addListener(type, listener, options)
  })
  const dismiss = render(() => createComponent(FileName, {
    name: 'note.md',
    edit: { stem: 'renamed', onInput: () => {}, onPause: () => {}, onSave: save, onCancel: () => {} },
  }), host)
  try {
    expect(attachedAfterMount).toBe(true)
    const click = vi.fn(() => expect(save).not.toHaveBeenCalled())
    target.addEventListener('click', click)
    host.querySelector('input')!.focus()
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }))
    target.focus()
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(save).not.toHaveBeenCalled()
    target.click()
    expect(click).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
  } finally {
    dismiss()
    listeners.mockRestore()
    host.remove()
    target.remove()
  }
})

it('keeps the sidebar steady on open and remembers contextual placement after remount', async () => {
  const root = '/pin-test'
  const folder = { path: `${root}/folder`, name: 'folder', directory: true, markdown: false }
  const file = (name: string, parent = root) => ({ path: `${parent}/${name}`, name, directory: false, markdown: name.endsWith('.md') })
  const first = file('first.md')
  const second = file('second.pdf')
  const nested = file('note.md', folder.path)
  const dotfile = file('.gitignore', folder.path)
  const subfolder = { path: `${folder.path}/child`, name: 'child', directory: true, markdown: false }
  let children = [subfolder, file('.DS_Store', folder.path), dotfile, nested]
  const load = vi.spyOn(desktopWorkspace, 'entries').mockImplementation(async (_root, parent) =>
    parent === folder.path ? children : [file('.DS_Store'), folder, first, second])
  const orderKey = `onebox:workspace-order:${root}`
  const savedOrder = JSON.stringify({ [root]: [folder.path, first.path, second.path] })
  localStorage.setItem(orderKey, savedOrder)
  const [active, setActive] = createSignal<string | null>(first.path)
  const [revision, setRevision] = createSignal(0)
  const host = document.createElement('div')
  document.body.append(host)
  const noop = () => {}
  vi.useFakeTimers()
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
  const mount = () => render(() => createComponent(WorkspaceSidebar, {
    workspace: { root, entries: [file('.DS_Store'), folder, first, second] },
    visible: true, restoring: false, get active() { return active() }, get revision() { return revision() },
    onOpen: (entry) => setActive(entry.path), onOpenFile: async () => { setActive(nested.path); return nested.path }, onOpenWorkspace: noop,
    onRevealLocation: async () => {},
    onCreate: async (parent, name, _directory, onCreated) => {
      const entry = file(name, parent)
      children = [...children, entry]
      onCreated(entry)
      setRevision((value) => value + 1)
      setActive(entry.path)
    },
    onTrash: async () => {}, onRename: async (entry) => entry.path,
    onMove: async () => {}, onPaste: async () => {}, onClose: noop,
  }), host)
  let dispose = mount()
  const names = (path: string) => [...host.querySelectorAll(`ul[data-workspace-folder="${path}"] > li > .workspace-row`)]
    .map((row) => row.getAttribute('data-workspace-entry'))
  const choose = (path: string, action: string) => {
    host.querySelector(`[data-workspace-entry="${path}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    buttons.find((button) => button.textContent === action)!.click()
  }

  try {
    expect(names(root)).toEqual([folder.path, first.path, second.path])
    const button = host.querySelector<HTMLButtonElement>(`[data-workspace-entry="${second.path}"] > button`)!
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(names(root)).toEqual([folder.path, first.path, second.path])
    expect(button.getAttribute('aria-current')).toBe('page')
    expect(button.hasAttribute('aria-busy')).toBe(false)
    const other = host.querySelector<HTMLButtonElement>(`[data-workspace-entry="${first.path}"] > button`)!
    other.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
    const input = host.querySelector<HTMLInputElement>('.filename-field input')!
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('first')
    expect(active()).toBe(second.path)
    expect(scroll).not.toHaveBeenCalled()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(names(root)).toEqual([folder.path, first.path, second.path])

    setActive(nested.path)
    await Promise.resolve()
    expect(names(root)).toEqual([folder.path, first.path, second.path])
    expect(names(folder.path)).toEqual([subfolder.path, dotfile.path, nested.path])
    expect(localStorage.getItem(orderKey)).toBe(savedOrder)

    choose(dotfile.path, '打开文件…')
    await vi.advanceTimersByTimeAsync(0)
    expect(names(folder.path)).toEqual([subfolder.path, dotfile.path, nested.path])
    choose(folder.path, '打开文件…')
    await vi.advanceTimersByTimeAsync(0)
    expect(names(folder.path)).toEqual([nested.path, subfolder.path, dotfile.path])

    choose(dotfile.path, '新建文件…')
    const draft = host.querySelector<HTMLInputElement>('input[aria-label="文件名称"]')!
    expect(draft.closest('li')?.previousElementSibling?.firstElementChild?.getAttribute('data-workspace-entry')).toBe(dotfile.path)
    draft.value = 'added.md'
    draft.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.advanceTimersByTimeAsync(0)
    const saved = [nested.path, subfolder.path, dotfile.path, `${folder.path}/added.md`]
    expect(names(folder.path)).toEqual(saved)
    expect(JSON.parse(localStorage.getItem(orderKey)!)[folder.path]).toEqual(saved)
    dispose()
    dispose = mount()
    await vi.advanceTimersByTimeAsync(0)
    expect(names(folder.path)).toEqual(saved)
  } finally {
    dispose()
    vi.useRealTimers()
    scroll.mockRestore()
    load.mockRestore()
    localStorage.removeItem(orderKey)
    host.remove()
  }
})

it('marks a valid drop folder before moving and clears the mark on release', () => {
  const folder = (name: string) => ({ path: `/work/${name}`, name, directory: true, markdown: false })
  const source = folder('source')
  const target = folder('target')
  const host = document.createElement('div')
  document.body.append(host)
  const onMove = vi.fn(async () => {})
  const noop = () => {}
  const dispose = render(() => createComponent(WorkspaceSidebar, {
    workspace: { root: '/work', entries: [source, target] },
    visible: true,
    restoring: false,
    active: null,
    revision: 0,
    onMove,
    onCreate: async () => {},
    onTrash: async () => {},
    onRename: async (entry) => entry.path,
    onOpen: noop,
    onOpenFile: async () => undefined,
    onOpenWorkspace: noop,
    onRevealLocation: async () => {},
    onPaste: async () => {},
    onClose: noop,
  }), host)
  const sourceRow = host.querySelector<HTMLElement>('[data-workspace-folder="/work/source"]')!
  const targetRow = host.querySelector<HTMLElement>('[data-workspace-folder="/work/target"]')!
  vi.spyOn(sourceRow, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 32))
  vi.spyOn(targetRow, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 32, 200, 32))
  const hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(targetRow)
  const pointer = (type: string, y: number, buttons: number) => new PointerEvent(type, {
    bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: 30, clientY: y, button: 0, buttons,
  })

  try {
    sourceRow.querySelector('button')!.dispatchEvent(pointer('pointerdown', 12, 1))
    window.dispatchEvent(pointer('pointermove', 22, 1))
    expect(targetRow.classList.contains('workspace-drop-target')).toBe(false)

    window.dispatchEvent(pointer('pointermove', 62, 1))
    expect(targetRow.parentElement!.classList.contains('workspace-drop-after')).toBe(true)
    window.dispatchEvent(pointer('pointerup', 62, 0))
    expect(targetRow.parentElement!.classList.contains('workspace-drop-after')).toBe(false)
    expect([...host.querySelectorAll('[data-workspace-entry]')].map((row) => row.getAttribute('data-workspace-entry')))
      .toEqual([target.path, source.path])
    expect(onMove).not.toHaveBeenCalled()

    sourceRow.querySelector('button')!.dispatchEvent(pointer('pointerdown', 12, 1))
    window.dispatchEvent(pointer('pointermove', 48, 1))
    expect(targetRow.classList.contains('workspace-drop-target')).toBe(true)
    expect(onMove).not.toHaveBeenCalled()

    window.dispatchEvent(pointer('pointerup', 48, 0))
    expect(targetRow.classList.contains('workspace-drop-target')).toBe(false)
    expect(onMove).toHaveBeenCalledWith(source, target.path)
  } finally {
    localStorage.removeItem('onebox:workspace-order:/work')
    hit.mockRestore()
    dispose()
    host.remove()
  }
})

it('uses the same menu for right click and overflow, with inline creation and confirmed deletion', async () => {
  const entry = { path: '/work/note.md', name: 'note.md', directory: false, markdown: true }
  const folder = { path: '/work/folder', name: 'folder', directory: true, markdown: false }
  const host = document.createElement('div')
  document.body.append(host)
  const onCreate = vi.fn(async (_parent, _name, _directory, onCreated: (entry: typeof folder) => void) => {
    onCreated(folder)
  })
  const onTrash = vi.fn(async () => {})
  const onRename = vi.fn(async () => '/work/renamed.md')
  const onRevealLocation = vi.fn(async () => {})
  const onOpen = vi.fn()
  const noop = () => {}
  const dispose = render(() => createComponent(WorkspaceSidebar, {
    workspace: { root: '/work', entries: [entry, folder] },
    visible: true,
    restoring: false,
    active: null,
    revision: 0,
    onCreate,
    onTrash,
    onRename,
    onMove: async () => {},
    onOpen,
    onOpenFile: async () => undefined,
    onOpenWorkspace: noop,
    onRevealLocation,
    onPaste: async () => {},
    onClose: noop,
  }), host)
  const row = host.querySelector<HTMLElement>('[data-workspace-entry]')!
  const more = row.querySelector<HTMLButtonElement>('.workspace-row-action')!
  const menuItems = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))

  try {
    const rowButton = (path: string) => host.querySelector<HTMLButtonElement>(
      `[data-workspace-entry="${path}"] > .workspace-row-button`,
    )!
    for (const [item, stem] of [[entry, 'note'], [folder, 'folder']] as const) {
      const button = rowButton(item.path)
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
      if (item.directory) expect(button.getAttribute('aria-expanded')).toBe('true')
      button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
      const input = host.querySelector<HTMLInputElement>('.filename-field input')!
      expect(document.activeElement).toBe(input)
      expect(input.value).toBe(stem)
      expect([input.selectionStart, input.selectionEnd]).toEqual([stem.length, stem.length])
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    }
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(entry)

    // AppKit can report detail=2 on the first click of an adjacent row.
    rowButton(folder.path).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    rowButton(entry.path).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
    rowButton(entry.path).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(host.querySelector('.filename-field input')).toBeNull()

    more.click()
    more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }))
    window.dispatchEvent(new Event('resize'))
    more.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 }))
    more.click()
    expect(menuItems()).toHaveLength(0)

    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    const rightClickLabels = menuItems().map((button) => button.textContent)
    more.click()
    expect(menuItems().map((button) => button.textContent)).toEqual(rightClickLabels)
    menuItems().find((button) => button.textContent === '打开文件位置')!.click()
    expect(onRevealLocation).toHaveBeenCalledExactlyOnceWith(entry.path)
    more.click()
    expect(rightClickLabels).toContain('复制路径')
    expect(rightClickLabels).not.toContain('打开此文档')
    expect(rightClickLabels).not.toContain('移动到…')
    expect(rightClickLabels).not.toContain('复制到…')
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    menuItems().find((button) => button.textContent === '剪切文件')!.click()
    expect(row.classList.contains('workspace-row-cut')).toBe(true)
    more.click()
    menuItems().find((button) => button.textContent === '复制路径')!.click()
    expect(clipboard).toHaveBeenCalledWith('/work/note.md')
    await vi.waitFor(() => expect(row.classList.contains('workspace-row-cut')).toBe(false))
    clipboard.mockRestore()
    more.click()
    const rename = menuItems().find((button) => button.textContent === '重命名…')!
    rename.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }))
    rename.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 }))
    window.dispatchEvent(new Event('resize'))
    expect(rename.isConnected).toBe(true)
    rename.click()
    const name = host.querySelector<HTMLInputElement>('.filename-field input')!
    expect(name.value).toBe('note')
    expect(name.closest('.filename-field')?.querySelector('.filename-field-suffix')?.textContent).toBe('.md')
    name.value = 'renamed'
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onRename).toHaveBeenCalledWith(entry, 'renamed')
    await Promise.resolve()
    await Promise.resolve()

    for (const kind of ['文件', '文件夹']) {
      more.click()
      menuItems().find((button) => button.textContent === `新建${kind}…`)!.click()
      const selector = `input[aria-label="${kind}名称"]`
      const unnamed = host.querySelector<HTMLInputElement>(selector)!
      expect(document.activeElement).toBe(unnamed)
      unnamed.value = '   '
      more.focus()
      expect(host.querySelector(selector)).toBeNull()
      expect(document.activeElement).toBe(more)
    }
    expect(onCreate).not.toHaveBeenCalled()

    host.querySelector<HTMLButtonElement>('[aria-label="工作区操作"]')!.click()
    menuItems().find((button) => button.textContent === '新建文件…')!.click()
    const emptyDraft = host.querySelector<HTMLInputElement>('input[aria-label="文件名称"]')!
    const target = rowButton(entry.path)
    onOpen.mockClear()
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }))
    target.focus()
    expect(host.contains(emptyDraft)).toBe(true)
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 }))
    target.click()
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(entry)
    await vi.waitFor(() => expect(host.contains(emptyDraft)).toBe(false))

    more.click()
    menuItems().find((button) => button.textContent === '新建文件…')!.click()
    const named = host.querySelector<HTMLInputElement>('input[aria-label="文件名称"]')!
    named.value = 'draft.md'
    more.focus()
    expect(host.contains(named)).toBe(true)
    named.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    more.click()
    menuItems().find((button) => button.textContent === '新建文件夹…')!.click()
    const field = host.querySelector<HTMLInputElement>('.workspace-rows input')!
    expect(host.querySelector('dialog')).toBeNull()
    field.value = 'alpha'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onCreate).toHaveBeenCalledWith('/work', 'alpha', true, expect.any(Function))
    await Promise.resolve()

    more.click()
    const trash = menuItems().find((button) => button.textContent === '删除…')!
    trash.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }))
    window.dispatchEvent(new Event('resize'))
    expect(menuItems()).toContain(trash)
    trash.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 }))
    trash.click()
    expect(onTrash).not.toHaveBeenCalled()
    host.querySelector<HTMLButtonElement>('.workspace-trash-confirm')!.click()
    expect(onTrash).toHaveBeenCalledWith(entry)
    await Promise.resolve()
  } finally {
    dispose()
    host.remove()
  }
})

it('copies and cuts one focused file and pastes into the focused folder or root', async () => {
  const root = '/clipboard-test'
  const source = { path: `${root}/sample.pdf`, name: 'sample.pdf', directory: false, markdown: false }
  const folder = { path: `${root}/target`, name: 'target', directory: true, markdown: false }
  const nested = { ...source, path: `${folder.path}/sample.pdf` }
  const load = vi.spyOn(desktopWorkspace, 'entries').mockResolvedValue([nested])
  const stopWatching = vi.fn(async () => {})
  let onFileEvent: Parameters<typeof desktopWorkspace.watchDirectories>[1] | undefined
  const watch = vi.spyOn(desktopWorkspace, 'watchDirectories').mockImplementation(async (_paths, onEvent) => {
    onFileEvent = onEvent
    return stopWatching
  })
  const host = document.createElement('div')
  document.body.append(host)
  const onOpen = vi.fn()
  const onPaste = vi.fn(async () => {})
  const onCopy = vi.fn(async () => 1)
  const dispose = render(() => createComponent(WorkspaceSidebar, {
    workspace: { root, entries: [source, folder] },
    visible: true,
    restoring: false,
    active: null,
    revision: 0,
    onOpen,
    onPaste,
    onCopy,
    onRevealLocation: async () => {},
    onMove: async () => {},
    onCreate: async () => {},
    onTrash: async () => {},
    onRename: async (entry) => entry.path,
    onOpenFile: async () => undefined,
    onOpenWorkspace: () => {},
    onClose: () => {},
  }), host)
  const row = (path: string) => host.querySelector<HTMLElement>(`[data-workspace-entry="${path}"]`)!
  const select = (path: string) => row(path).querySelector<HTMLButtonElement>('.workspace-row-button')!.click()
  const hint = () => host.querySelector('[role="status"]')?.textContent
  const press = (key: string, metaKey = false) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ctrlKey: !metaKey, metaKey })
    document.activeElement!.dispatchEvent(event)
    return event.defaultPrevented
  }

  try {
    select(source.path)
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(source)
    expect(press('c', true)).toBe(true)
    expect(press('v')).toBe(true)
    expect(onPaste).toHaveBeenLastCalledWith(source, root, false)
    await Promise.resolve()
    expect(onCopy).toHaveBeenCalledExactlyOnceWith([source])
    await vi.waitFor(() => expect(hint()).toBe('已复制'))

    select(folder.path)
    expect(press('v', true)).toBe(true)
    expect(onPaste).toHaveBeenLastCalledWith(source, folder.path, false)
    await Promise.resolve()

    select(nested.path)
    expect(press('x', true)).toBe(true)
    expect(row(nested.path).classList.contains('workspace-row-cut')).toBe(true)
    await vi.waitFor(() => expect(hint()).toBe('已剪切 · 到 Finder 按 ⌥⌘V 移动'))
    expect(onCopy).toHaveBeenLastCalledWith([nested])
    host.querySelector<HTMLElement>('.workspace-title strong')!.click()
    onPaste.mockRejectedValueOnce(new Error('目标已存在同名文件'))
    expect(press('v')).toBe(true)
    expect(row(nested.path).classList.contains('workspace-row-cut')).toBe(false)
    await Promise.resolve()
    expect(row(nested.path).classList.contains('workspace-row-cut')).toBe(false)
    expect(press('v')).toBe(true)
    expect(onPaste).toHaveBeenLastCalledWith(nested, root, true)
    await Promise.resolve()
    expect(row(nested.path).classList.contains('workspace-row-cut')).toBe(false)
    expect(press('v')).toBe(false)

    select(nested.path)
    expect(press('x')).toBe(true)
    await vi.waitFor(() => expect(onCopy).toHaveBeenCalledTimes(3))
    expect(press('v')).toBe(true)
    expect(onPaste).toHaveBeenLastCalledWith(nested, folder.path, false)
    await Promise.resolve()
    expect(hint()).toBe('')

    select(nested.path)
    expect(press('x', true)).toBe(true)
    expect(row(nested.path).classList.contains('workspace-row-cut')).toBe(true)
    select(source.path)
    expect(press('c', true)).toBe(true)
    expect(row(nested.path).classList.contains('workspace-row-cut')).toBe(false)
    await vi.waitFor(() => expect(hint()).toBe('已复制'))

    select(nested.path)
    expect(press('x', true)).toBe(true)
    await vi.waitFor(() => expect(hint()).toBe('已剪切 · 到 Finder 按 ⌥⌘V 移动'))
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.activeElement!.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(row(nested.path).classList.contains('workspace-row-cut')).toBe(false)
    expect(hint()).toBe('')
    expect(press('v')).toBe(false)

    select(nested.path)
    expect(press('x', true)).toBe(true)
    await vi.waitFor(() => expect(hint()).toBe('已剪切 · 到 Finder 按 ⌥⌘V 移动'))
    expect(watch).toHaveBeenLastCalledWith([folder.path], expect.any(Function))
    stopWatching.mockClear()
    load.mockResolvedValueOnce([])
    onFileEvent?.({ paths: [nested.path], type: { modify: { kind: 'rename', mode: 'from' } } })
    await vi.waitFor(() => expect(row(nested.path)).toBeNull())
    expect(stopWatching).toHaveBeenCalled()
    host.querySelector<HTMLElement>('.workspace-title strong')!.click()
    expect(press('v')).toBe(false)

    const button = row(source.path).querySelector<HTMLButtonElement>('.workspace-row-button')!
    button.focus()
    expect(press('c')).toBe(true)
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
    expect(document.activeElement?.tagName).toBe('INPUT')
    expect(press('x')).toBe(false)
    expect(press('v')).toBe(false)
    expect(onPaste).toHaveBeenCalledTimes(5)
  } finally {
    dispose()
    load.mockRestore()
    watch.mockRestore()
    host.remove()
  }
})

it('selects files across folders and applies the clipboard action to the selection', async () => {
  const root = '/multi-clipboard'
  const files = ['A.md', 'B.pdf', 'C.JPG', 'D.tar.gz'].map((name) => ({
    path: `${root}/${name}`, name, directory: false, markdown: name.endsWith('.md'),
  }))
  const [first, second, third, fourth] = files
  const folder = { path: `${root}/target`, name: 'target', directory: true, markdown: false }
  const nested = { path: `${folder.path}/nested.pdf`, name: 'nested.pdf', directory: false, markdown: false }
  const destination = { path: `${root}/destination`, name: 'destination', directory: true, markdown: false }
  const entries = [first, second, folder, third, fourth, destination]
  const host = document.createElement('div')
  document.body.append(host)
  const onOpen = vi.fn()
  const onCopy = vi.fn(async () => 1)
  const onPaste = vi.fn(async () => {})
  const onSelectionReady = vi.fn<(selection?: WorkspaceSelection) => void>()
  const [sidebarVisible, setSidebarVisible] = createSignal(true)
  const load = vi.spyOn(desktopWorkspace, 'entries').mockImplementation(async (_root, path) =>
    path === root ? entries : path === folder.path ? [nested] : [])
  const dispose = render(() => createComponent(WorkspaceSidebar, {
    workspace: { root, entries },
    get visible() { return sidebarVisible() },
    restoring: false,
    active: null,
    revision: 0,
    onOpen,
    onCopy,
    onPaste,
    onSelectionReady,
    onRevealLocation: async () => {},
    onMove: async () => {},
    onCreate: async () => {},
    onTrash: async () => {},
    onRename: async (entry) => entry.path,
    onOpenFile: async () => undefined,
    onOpenWorkspace: () => {},
    onClose: () => {},
  }), host)
  const button = (path: string) => host.querySelector<HTMLButtonElement>(
    `[data-workspace-entry="${path}"] > .workspace-row-button`,
  )!
  const selected = () => [...host.querySelectorAll('[aria-pressed="true"]')].map((el) =>
    el.closest<HTMLElement>('[data-workspace-entry]')?.dataset.workspaceEntry)
  const controlClick = (path: string) => {
    button(path).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: true }))
    button(path).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, ctrlKey: true }))
    button(path).dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }))
  }
  const press = (key: string) => document.activeElement!.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, metaKey: true }),
  )
  const showMenu = (path: string) =>
    button(path).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
  const hints = () => [...host.querySelectorAll('.workspace-row .workspace-clipboard-hint')].map((el) =>
    [el.closest<HTMLElement>('[data-workspace-entry]')?.dataset.workspaceEntry, el.textContent])

  try {
    button(first.path).click()
    button(third.path).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    controlClick(folder.path)
    button(folder.path).dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    button(folder.path).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    expect(selected()).toEqual([first.path, second.path, third.path])
    expect(button(folder.path).getAttribute('aria-expanded')).toBe('false')
    expect(button(folder.path).hasAttribute('aria-pressed')).toBe(false)
    controlClick(second.path)
    controlClick(third.path)
    controlClick(fourth.path)
    expect(selected()).toEqual([first.path, fourth.path])
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(first)
    expect(host.querySelector('[role="menu"]')).toBeNull()

    press('c')
    await vi.waitFor(() => expect(hints()).toEqual([[first.path, '已复制'], [fourth.path, '已复制']]))
    expect(onCopy).toHaveBeenCalledExactlyOnceWith([first, fourth])

    press('x')
    await vi.waitFor(() => expect(hints()).toEqual([[first.path, '已剪切'], [fourth.path, '已剪切']]))
    expect(host.querySelectorAll('.workspace-row-cut')).toHaveLength(2)
    expect(onCopy).toHaveBeenLastCalledWith([first, fourth])
    button(folder.path).click()
    expect(selected()).toEqual([first.path, fourth.path])
    expect(button(folder.path).getAttribute('aria-expanded')).toBe('true')
    onPaste.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('目标已存在同名文件'))
    press('v')
    expect(host.querySelectorAll('.workspace-row-cut')).toHaveLength(0)
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain(fourth.name))
    expect(onPaste.mock.calls).toEqual([[first, folder.path, true], [fourth, folder.path, true]])
    press('v')
    await vi.waitFor(() => expect(onPaste).toHaveBeenCalledTimes(3))
    expect(onPaste).toHaveBeenLastCalledWith(fourth, folder.path, true)

    const overview = onSelectionReady.mock.calls[0]![0]!
    controlClick(nested.path)
    expect(overview.entries()).toEqual([first, nested, fourth])
    button(folder.path).click()
    expect(button(folder.path).getAttribute('aria-expanded')).toBe('false')
    await vi.waitFor(() => expect(button(nested.path)).toBeNull())
    expect(overview.entries()).toEqual([first, nested, fourth])
    expect(overview.showOverview()).toBe(true)
    expect(overview.canCopy()).toBe(true)
    overview.copy(false)
    await vi.waitFor(() => expect(onCopy).toHaveBeenLastCalledWith([first, nested, fourth]))
    button(folder.path).click()
    expect(button(nested.path).getAttribute('aria-pressed')).toBe('true')

    overview.remove(nested.path)
    overview.remove(fourth.path)
    expect(selected()).toEqual([first.path])
    expect(overview.showOverview()).toBe(true)
    expect(overview.canCopy()).toBe(true)
    overview.copy(true)
    await vi.waitFor(() => expect(hints()).toEqual([[first.path, '已剪切']]))
    expect(overview.message()).toBeUndefined()
    expect(overview.cutPaths()).toEqual(new Set([first.path]))
    overview.copy(false)
    await vi.waitFor(() => expect(hints()).toEqual([[first.path, '已复制']]))
    expect(overview.message()).toBeUndefined()
    expect(overview.cutPaths().size).toBe(0)
    expect(onCopy.mock.calls.slice(-2)).toEqual([[[first]], [[first]]])
    button(first.path).click()
    expect(overview.showOverview()).toBe(false)
    button(folder.path).click()
    press('c')
    await vi.waitFor(() => expect(onCopy).toHaveBeenLastCalledWith([folder]))
    expect(selected()).toEqual([first.path])
    press('x')
    await vi.waitFor(() => expect(hints()).toEqual([[folder.path, '已剪切']]))
    expect(selected()).toEqual([first.path])
    controlClick(fourth.path)
    showMenu(folder.path)
    expect(selected()).toEqual([first.path, fourth.path])
    expect(overview.showOverview()).toBe(true)
    const folderActions = Array.from(host.querySelectorAll('[role="menuitem"]'), (item) => item.textContent)
    expect(folderActions).toContain('新建文件…')
    expect(folderActions).toContain('复制文件夹')
    expect(folderActions).toContain('剪切文件夹')
    expect(folderActions).not.toContain('复制文件')
    expect(folderActions).not.toContain('剪切文件')
    const menuAction = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent === label)!
    menuAction('复制文件夹').click()
    await vi.waitFor(() => expect(onCopy.mock.calls.slice(-2)).toEqual([[[folder]], [[folder]]]))
    await vi.waitFor(() => expect(hints()).toEqual([[folder.path, '已复制']]))
    expect(overview.entries()).toEqual([first, fourth])
    expect(overview.message()).toBeUndefined()
    host.querySelector<HTMLButtonElement>('[aria-label="工作区操作"]')!.click()
    menuAction('粘贴').click()
    await vi.waitFor(() => expect(onPaste).toHaveBeenLastCalledWith(folder, root, false))

    const cutFolder = async () => {
      showMenu(folder.path)
      menuAction('剪切文件夹').click()
      await vi.waitFor(() => expect(hints()).toEqual([[folder.path, '已剪切']]))
      expect(overview.cutPaths()).toEqual(new Set([folder.path]))
      expect(overview.message()).toBeUndefined()
      expect(overview.entries()).toEqual([first, fourth])
    }
    await cutFolder()
    press('Escape')
    expect(overview.cutPaths().size).toBe(0)
    expect(hints()).toEqual([])

    await cutFolder()
    const pasteCount = onPaste.mock.calls.length
    host.querySelector<HTMLButtonElement>('[aria-label="工作区操作"]')!.click()
    menuAction('粘贴').click()
    expect(onPaste).toHaveBeenCalledTimes(pasteCount)
    expect(overview.cutPaths().size).toBe(0)

    await cutFolder()
    showMenu(destination.path)
    menuAction('粘贴').click()
    await vi.waitFor(() => expect(onPaste).toHaveBeenLastCalledWith(folder, destination.path, true))
    expect(overview.cutPaths().size).toBe(0)

    setSidebarVisible(false)
    expect(overview.message()).toBeUndefined()
    overview.copy(false)
    await vi.waitFor(() => expect(overview.message()).toBe('已复制 2 个文件'))
    overview.remove(fourth.path)
    expect(overview.message()).toBeUndefined()
  } finally {
    dispose()
    load.mockRestore()
    host.remove()
  }
})

it('pastes Finder contents into the focused folder and only moves files from the current Onebox cut', async () => {
  const root = '/system-clipboard'
  const file = { path: `${root}/note.pdf`, name: 'note.pdf', directory: false, markdown: false }
  const folder = { path: `${root}/target`, name: 'target', directory: true, markdown: false }
  const host = document.createElement('div')
  document.body.append(host)
  let changeCount = 10
  const onCopy = vi.fn(async () => ++changeCount)
  const onPaste = vi.fn(async () => {})
  const onPasteSystem = vi.fn(async (_target: string, localChangeCount?: number) =>
    localChangeCount === changeCount ? 'local' as const : 'pasted' as const)
  const load = vi.spyOn(desktopWorkspace, 'entries').mockResolvedValue([])
  const dispose = render(() => createComponent(WorkspaceSidebar, {
    workspace: { root, entries: [file, folder] },
    visible: true,
    restoring: false,
    active: null,
    revision: 0,
    onCopy,
    onPaste,
    onPasteSystem,
    onOpen: () => {},
    onOpenFile: async () => undefined,
    onOpenWorkspace: () => {},
    onRevealLocation: async () => {},
    onMove: async () => {},
    onCreate: async () => {},
    onTrash: async () => {},
    onRename: async (entry) => entry.path,
    onClose: () => {},
  }), host)
  const button = (path: string) => host.querySelector<HTMLButtonElement>(
    `[data-workspace-entry="${path}"] > .workspace-row-button`,
  )!
  const press = (key: string) => document.activeElement!.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, metaKey: true }),
  )
  const isCut = () => button(file.path).closest('.workspace-row')!.classList.contains('workspace-row-cut')

  try {
    button(folder.path).click()
    press('v')
    await vi.waitFor(() => expect(onPasteSystem).toHaveBeenLastCalledWith(folder.path, undefined))
    expect(onPaste).not.toHaveBeenCalled()

    button(file.path).click()
    press('x')
    button(folder.path).click()
    press('v')
    await vi.waitFor(() => expect(onPaste).toHaveBeenCalledExactlyOnceWith(file, folder.path, true))
    expect(onPasteSystem).toHaveBeenLastCalledWith(folder.path, 11)
    expect(isCut()).toBe(false)

    button(file.path).click()
    press('x')
    await vi.waitFor(() => expect(onCopy).toHaveBeenCalledTimes(2))
    expect(isCut()).toBe(true)
    changeCount++
    button(folder.path).click()
    press('v')
    await vi.waitFor(() => expect(onPasteSystem).toHaveBeenLastCalledWith(folder.path, 12))
    expect(onPaste).toHaveBeenCalledTimes(1)
    expect(isCut()).toBe(false)
  } finally {
    dispose()
    load.mockRestore()
    host.remove()
  }
})
